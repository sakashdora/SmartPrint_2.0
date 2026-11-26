import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// One worker serves ONE printer: its own device key, heartbeat and claim loop. A PC with several printers runs several
// workers side by side, so jobs for different printers print at the same time and one printer's fault or offline state
// never holds back another. The actual printing is injected (`print`), which keeps this testable without a printer.
//
//   createWorker({ name, token, getBase, root, print, getHealth, refreshToken, log })
//     print({ pdfPath, printerName, options }) -> { method }     sends the file to the Windows queue
//     getHealth() -> { blocking, label, at } | null              what Windows last said about this printer
//     refreshToken() -> string | null                            the current key for this printer from settings.json
export function createWorker({ name, token, getBase, root, print, getHealth = () => null, refreshToken = () => null, onHeartbeat = () => {}, log = () => {}, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const worker = { name, token, authFailed: false, running: false, lastJobAt: 0, lastHeartbeatAt: 0 };

  async function request(path, { method = 'GET', body, lease, binary, range } = {}) {
    const response = await fetchImpl(new URL(path, getBase()), {
      method,
      headers: {
        Authorization: `Bearer ${worker.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(lease ? { 'X-Lease-Token': lease } : {}),
        ...(range ? { Range: range } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) {
      if (response.status === 401) {
        const refreshed = refreshToken();
        if (refreshed && refreshed !== worker.token) {
          worker.token = refreshed; worker.authFailed = false;
          log(`[${name}] Detected a new device key in settings.json. Reconnected.`);
        } else if (!worker.authFailed) {
          // Logged once, not on every poll.
          worker.authFailed = true;
          log(`[${name}] The server rejected this printer's device key (401): it was disconnected or linked again elsewhere. Open SmartPrint > Printers on this PC and click Connect to link it again.`);
        }
      }
      const error = new Error(`SmartPrint request failed (${response.status} on ${path}).`);
      error.status = response.status;
      throw error;
    }
    if (worker.authFailed) { worker.authFailed = false; log(`[${name}] Device key accepted again.`); }
    return binary ? { bytes: Buffer.from(await response.arrayBuffer()), range: response.headers.get('Content-Range') } : response.json();
  }

  async function printJob(job) {
    if (!/^[a-f0-9-]{36}$/.test(job.id)) throw new Error('Invalid job identifier.');
    const path = join(root, `${job.id}.pdf`), journal = join(root, `${job.id}.submitted`);
    const short = job.id.slice(0, 8).toUpperCase();

    let previous = null;
    try { previous = JSON.parse(await readFile(journal, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }

    // Submitted moments ago in this same attempt: the owner confirms the physical output, we never print it twice.
    if (previous && (!job.attempt || job.attempt <= (previous.attempt || 1))) {
      const ageMs = Date.now() - new Date(previous.submitted || 0).getTime();
      if (ageMs < 180000) { log(`[${name}] Job #${short} was submitted ${Math.round(ageMs / 1000)}s ago. Waiting for owner confirmation.`); return 'duplicate'; }
    }
    if (previous) { log(`[${name}] Re-processing job #${short} (attempt ${job.attempt || 2}).`); await unlink(journal).catch(() => {}); }

    try {
      log(`>>> [${name}] Incoming job #${short} (attempt ${job.attempt || 1}): ${job.options.color === 'color' ? 'Colour' : 'Black & White'}, ${job.options.copies || 1} copies, ${job.options.duplex ? 'double-sided' : 'single-sided'}`);
      const chunks = [];
      let start = 0, total;
      do {
        const result = await request(`/api/device/jobs/${job.id}/document`, { binary: true, lease: job.token, range: `bytes=${start}-${start + 1048575}` });
        chunks.push(result.bytes);
        total = Number(result.range?.split('/')[1] || result.bytes.length);
        start += result.bytes.length;
        if (total > 40 * 1048576 || !result.bytes.length) throw new Error('Invalid print file size.');
      } while (start < total);
      const bytes = Buffer.concat(chunks);
      if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Downloaded document is not a valid PDF file.');
      await writeFile(path, bytes, { mode: 0o600 });
      // Durable record before the printer is touched: a crash after this point can never reprint the job.
      await writeFile(journal, JSON.stringify({ id: job.id, attempt: job.attempt || 1, printer: name, sha256: createHash('sha256').update(bytes).digest('hex'), submitted: new Date().toISOString() }), { flag: 'w', mode: 0o600 });
      await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'submitted' } });
      log(`    [${name}] Sending to the printer...`);
      const result = await print({ pdfPath: path, printerName: name, options: job.options });
      await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'awaiting_confirmation' } });
      log(`✓ [${name}] Job #${short} sent to the printer (${result?.method ?? 'spooler'}). Confirm the physical output in SmartPrint.`);
      worker.lastJobAt = Date.now();
      return 'printed';
    } catch (error) {
      log(`! [${name}] Failed to submit job #${short}: ${error.message}`);
      await unlink(journal).catch(() => {});
      await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'failed', error: error.message } }).catch(() => {});
      return 'failed';
    } finally {
      await unlink(path).catch(() => {});
    }
  }

  // One look at the queue for this printer. 'blocked' = Windows reports a fault, so nothing was taken from the queue.
  async function claimOnce() {
    const health = getHealth();
    if (health?.blocking && Date.now() - health.at < 120000) return 'blocked';
    const job = await request('/api/device/claim', { method: 'POST' });
    if (!job) return 'idle';
    await printJob(job);
    return 'job';
  }

  const idleDelay = (streak, base, max) => Math.min(max, base + Math.floor(streak / 10) * 500);
  async function loop() {
    let retryDelay = 1000, idleStreak = 0, lastNotice = 0;
    while (worker.running) {
      if (worker.authFailed) { await sleep(3000); try { await request('/api/device/heartbeat', { method: 'POST' }); } catch {} continue; }
      try {
        const outcome = await claimOnce();
        if (outcome === 'job') { idleStreak = 0; retryDelay = 1000; continue; }
        if (outcome === 'blocked') {
          if (Date.now() - lastNotice > 60000) { log(`[${name}] Not taking jobs: Windows reports "${getHealth()?.label}". Fix it and jobs will resume.`); lastNotice = Date.now(); }
          await sleep(5000); continue;
        }
        idleStreak++; retryDelay = idleDelay(idleStreak, 1000, 4000);
      } catch (error) {
        if (Date.now() - lastNotice > 30000) { log(`[${name}] Claim check notice (${error.status || error.message}). Will retry...`); lastNotice = Date.now(); }
        retryDelay = Math.min(10000, retryDelay * 1.5);
      }
      if (worker.running) await sleep(retryDelay);
    }
  }

  let beat = null;
  Object.assign(worker, {
    request, printJob, claimOnce,
    heartbeat: async () => {
      const res = await request('/api/device/heartbeat', { method: 'POST' });
      worker.lastHeartbeatAt = Date.now();
      onHeartbeat(res);
      return res;
    },
    start() {
      if (worker.running) return worker.done;
      worker.running = true;
      beat = setInterval(() => { worker.heartbeat().catch(error => { if (error.status !== 401) log(`[${name}] Heartbeat warning: ${error.message}`); }); }, 10000);
      beat.unref?.();
      worker.done = loop();
      return worker.done;
    },
    async stop() { worker.running = false; clearInterval(beat); await worker.done?.catch(() => {}); }
  });
  return worker;
}
