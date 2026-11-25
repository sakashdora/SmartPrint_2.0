import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureSumatraPDF, printPdfToWindowsPrinter, getWindowsPrinters, pickPrinter, checkPrinterStatus, clearStaleConnectorJobs } from './sumatra-helper.js';
import { probePrinterCapabilities, classifyConnection, guessCapabilities, detectManufacturer } from '../server/printer-capabilities.js';
import { startBridge, BRIDGE_PORT } from './local-bridge.js';
import { classifyPrinterHealth } from '../server/printer-health.js';
import { normalizeConfig, upsertPrinter, removePrinter, renamePrinter } from './config.js';
import { createWorker } from './worker.js';
import { listInstalledDrivers, addNetworkPrinter, probePrinterAddress } from './network-printer.js';

const run = promisify(execFile);
const root = resolve(process.env.LOCALAPPDATA || '.', 'SmartPrintConnector');
await mkdir(root, { recursive: true });

const logFile = join(root, 'connector.log');
export function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(logFile, line + '\n', 'utf8'); } catch {}
}

process.on('uncaughtException', err => { log(`[UncaughtException] ${err.stack || err.message}`); });
process.on('unhandledRejection', reason => { log(`[UnhandledRejection] ${reason?.stack || reason?.message || reason}`); });

// Load .env file if present in working directory or repo root
for (const envDir of [process.cwd(), resolve(process.cwd(), '..'), root]) {
  const envCandidate = join(envDir, '.env');
  if (existsSync(envCandidate)) {
    try {
      const content = readFileSync(envCandidate, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
        if (match && !process.env[match[1]]) process.env[match[1]] = (match[2] || '').trim().replace(/^['"](.*)['"]$/, '$1');
      }
    } catch {}
    break;
  }
}

// Persisted settings with BOM stripping. One PC can print for several printers: settings.json lists them
// (see config.js); a file from the single-printer connector is read as one printer and nothing is lost.
const settingsPath = join(root, 'settings.json');
export function loadConfig() {
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf8').replace(/^﻿/, '').trim();
      if (raw) return JSON.parse(raw);
    } catch (err) { console.warn('[Warning] Could not parse settings.json:', err.message); }
  }
  return {};
}
const saveConfig = cfg => writeFile(settingsPath, JSON.stringify(cfg, null, 2), 'utf8');

let config = normalizeConfig(loadConfig());
let base = (process.env.SMARTPRINT_URL || config.Url || 'http://localhost:3000').replace(/\/+$/, '');
const processorSecret = process.env.PROCESSOR_SECRET || config.ProcessorSecret;

// A PC set up from the dashboard's one-time key starts with environment variables only. Save them on first run so a
// restart or the Windows startup task reconnects without the key. Existing printers are never overwritten here.
if (process.env.SMARTPRINT_DEVICE_TOKEN && !config.Printers.length) {
  try {
    config = normalizeConfig({ ...config, Url: base, Token: process.env.SMARTPRINT_DEVICE_TOKEN, Printer: process.env.SMARTPRINT_PRINTER || '', LastUpdated: new Date().toISOString() });
    await saveConfig({ ...config, Token: config.Printers[0].Token, Printer: config.Printers[0].Name });
    log(`[Connector] Saved connection settings to ${settingsPath}.`);
  } catch (err) { log(`[Connector] Could not save settings: ${err.message}`); }
}

// Record process PID for single-instance connector management
const pidPath = join(root, 'connector.pid');
try { await writeFile(pidPath, String(process.pid), 'utf8'); } catch {}
const cleanupPid = () => { try { unlink(pidPath).catch(() => {}); } catch {} };

async function checkPrinterExists(name) {
  if (process.platform !== 'win32' || !name) return false;
  try {
    const { stdout } = await run('reg.exe', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\${name}`], { timeout: 1500, windowsHide: true });
    if (stdout) return true;
  } catch {}
  try {
    const { stdout } = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Devices', '/v', name], { timeout: 1500, windowsHide: true });
    if (stdout) return true;
  } catch {}
  return false;
}

// Ensure SumatraPDF is ready or fall back to the native spooler
let sumatra = process.env.SUMATRA_PATH || config.Sumatra;
if (!sumatra || !existsSync(sumatra)) sumatra = await ensureSumatraPDF();

// ---- one worker per linked printer -------------------------------------------------------------------------------
const workers = new Map(); // lower-case printer name -> worker
const keyOf = name => String(name).trim().toLowerCase();
const tokenFromSettings = name => normalizeConfig(loadConfig()).Printers.find(p => keyOf(p.Name) === keyOf(name))?.Token ?? null;

function makeWorker(name, token) {
  const worker = createWorker({
    name, token, getBase: () => base, root, log,
    // With several printers on this PC a job must print on exactly the printer it was queued for.
    print: args => printPdfToWindowsPrinter({ ...args, sumatraPath: sumatra, strict: workers.size > 1 }),
    getHealth: () => worker.health ?? null,
    refreshToken: () => tokenFromSettings(name)
  });
  return worker;
}

// Resolve each configured name to the installed Windows printer. One printer keeps the old behaviour (a similar or
// online copy is accepted). With several, only an exact name is used, so one printer's job can never fall back onto
// another printer.
async function resolveConfiguredPrinters() {
  const entries = config.Printers.slice();
  const installed = process.platform === 'win32' ? await getWindowsPrinters() : [];
  const multiple = entries.length > 1;
  for (const entry of entries) {
    let name = entry.Name;
    if (installed.length) {
      const exact = installed.find(p => keyOf(p.Name) === keyOf(name));
      if (exact) name = exact.Name;
      else if (!multiple) {
        const res = pickPrinter(name, installed);
        if (res.name) { log(`[Printer] ${res.reason}`); name = res.name; }
      } else log(`[Printer] WARNING: "${name}" is not installed in Windows on this PC. Its jobs wait until the printer is back; they are never sent to another printer.`);
      const status = installed.find(p => keyOf(p.Name) === keyOf(name));
      if (status && checkPrinterStatus(status.PrinterStatus).isOffline) log(`[Printer] WARNING: "${name}" is currently OFFLINE in Windows. Check its power and cable or WiFi connection.`);
    } else if (name && !(await checkPrinterExists(name))) log(`[Printer] WARNING: Could not list Windows printers and "${name}" was not found in the registry.`);
    if (!name) { log('[Printer] WARNING: No Windows printer detected. Install the printer driver and print a Windows test page.'); continue; }
    if (workers.has(keyOf(name))) { log(`[Printer] "${name}" is linked twice; the duplicate is ignored.`); continue; }
    if (name !== entry.Name) { config = renamePrinter(config, entry.Name, name); await saveConfig(config).catch(() => {}); }
    workers.set(keyOf(name), makeWorker(name, entry.Token));
  }
}
await resolveConfiguredPrinters();
if (!workers.size) log('[Connector] Not linked yet. Open SmartPrint > Printers on this PC and click Connect on each printer you want to use.');

// ---- this PC's printers, for the Printers page ---------------------------------------------------------------------
// Real printers with driver-verified capabilities. Software printers (PDF, OneNote, PaperPort ...) are left out.
// Cached briefly because the page polls it.
let lastScan = { at: 0, list: [] };
async function collectLocalPrinters({ maxAge = 15000 } = {}) {
  if (process.platform !== 'win32') return [];
  if (Date.now() - lastScan.at < maxAge) return lastScan.list;
  const rawWindows = await getWindowsPrinters();
  const printers = [];
  for (const p of rawWindows) {
    if (!p || !p.Name) continue;
    const port = String(p.PortName || '').trim(), name = String(p.Name).trim(), driver = String(p.DriverName || name).trim();
    const { connectionType: connType, isWifi, isWired } = classifyConnection({ name, port, driver });
    if (connType === 'Virtual / PDF') continue;
    const health = classifyPrinterHealth(p.PrinterStatus ?? null);
    printers.push({ name, portName: port, driverName: driver, manufacturer: detectManufacturer(name, driver), connectionType: connType, isWifi, isWired, isDefault: Boolean(p.Default), status: checkPrinterStatus(p.PrinterStatus).status, windowsState: health.state, windowsStateLabel: health.label, ...guessCapabilities(name, driver), verified: false });
  }
  const capabilities = await probePrinterCapabilities(printers.map(p => p.name));
  for (const p of printers) if (capabilities.has(p.name)) Object.assign(p, capabilities.get(p.name), { verified: true });
  lastScan = { at: Date.now(), list: printers };
  return printers;
}

// Used only when Get-Printer returns nothing: read the printer list from the registry.
async function registryPrinters() {
  const printers = [];
  let defPrinter = '';
  try {
    const { stdout: defOut } = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows', '/v', 'Device'], { timeout: 3000, windowsHide: true });
    const defMatch = defOut.match(/Device\s+REG_SZ\s+([^,]+)/i);
    if (defMatch) defPrinter = defMatch[1].trim();
  } catch {}
  const { stdout } = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Devices'], { timeout: 3000, windowsHide: true });
  if (stdout && stdout.trim()) {
    for (const line of stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('HKEY_'))) {
      const parts = line.split(/\s{2,}REG_SZ\s{2,}/);
      if (!parts || !parts[0]) continue;
      const name = parts[0].trim();
      if (!name || /OneNote|Fax|Microsoft XPS/i.test(name)) continue;
      let port = '';
      try {
        const { stdout: portOut } = await run('reg.exe', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\${name}`, '/v', 'Port'], { timeout: 1500, windowsHide: true });
        const portMatch = portOut.match(/Port\s+REG_SZ\s+(.*)/i);
        if (portMatch) port = portMatch[1].trim();
      } catch {}
      if (!port && parts[1]) port = (parts[1].split(',')[1] || '').trim();
      const { connectionType: connType, isWifi, isWired } = classifyConnection({ name, port });
      printers.push({ name, portName: port, driverName: name, manufacturer: detectManufacturer(name), connectionType: connType, isWifi, isWired, isDefault: Boolean(defPrinter && keyOf(name) === keyOf(defPrinter)), status: 'Ready', ...guessCapabilities(name) });
    }
  }
  return printers;
}

// Every minute: tell the server what each linked printer is doing. Windows's status and the driver's capabilities for a
// printer are sent with THAT printer's own key; only the first worker also shares the PC's printer list.
async function scanAndReportLocalPrinters() {
  if (process.platform !== 'win32' || !workers.size) return;
  try {
    const rawWindows = await getWindowsPrinters();
    const printers = [];
    for (const p of rawWindows) {
      if (!p || !p.Name || /OneNote|Fax|Microsoft XPS/i.test(p.Name)) continue;
      const port = String(p.PortName || '').trim(), name = String(p.Name || '').trim(), driver = String(p.DriverName || name).trim();
      const { connectionType: connType, isWifi, isWired } = classifyConnection({ name, port, driver });
      printers.push({ name, portName: port, driverName: driver, manufacturer: detectManufacturer(name, driver), connectionType: connType, isWifi, isWired, isDefault: Boolean(p.Default), status: checkPrinterStatus(p.PrinterStatus).status, ...guessCapabilities(name, driver) });
    }
    if (!printers.length) printers.push(...await registryPrinters());
    const linked = [...workers.values()];
    const capabilities = await probePrinterCapabilities([...linked.map(w => w.name), ...printers.map(p => p.name)]);
    for (const p of printers) Object.assign(p, capabilities.get(p.name) || {});
    let first = true;
    for (const worker of linked) {
      if (worker.authFailed) continue;
      const own = rawWindows.find(p => p?.Name && keyOf(p.Name) === keyOf(worker.name));
      const code = own ? (own.PrinterStatus ?? null) : null; // null = Windows could not tell us
      const verdict = classifyPrinterHealth(code);
      worker.health = { blocking: verdict.blocking, label: verdict.label, state: verdict.state, at: Date.now() };
      const caps = capabilities.get(worker.name);
      // Always report: "Windows could not tell us" is itself the honest answer.
      await worker.request('/api/device/printers/scanned', { method: 'POST', body: { printers: first ? printers : [], health: { code }, ...(caps ? { capabilities: caps } : {}) } }).catch(() => {});
      first = false;
    }
  } catch {}
}

let driverCache = { at: 0, list: [] };

// ---- dashboard link (this PC only) ---------------------------------------------------------------------------------
// Links ONE printer to the server. The key is checked with the server before anything is saved; printers that are
// already linked keep working. Linking to a different server replaces them, because they belonged to the old one.
async function pair({ url, token, printer: chosen }) {
  const target = url.replace(/\/+$/, '');
  const check = await fetch(new URL('/api/device/heartbeat', target), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) }).catch(err => ({ ok: false, status: err.message }));
  if (!check.ok) throw Object.assign(new Error(`The SmartPrint server did not accept this device key (${check.status}).`), { status: 400 });
  let name = String(chosen || '').trim();
  if (!name) throw Object.assign(new Error('Choose a printer to connect.'), { status: 400 });
  if (process.platform === 'win32') {
    const installed = await getWindowsPrinters();
    const exact = installed.find(p => keyOf(p.Name) === keyOf(name));
    if (exact) name = exact.Name;
    else if (installed.length) throw Object.assign(new Error(`"${name}" is not installed in Windows on this PC. Install its driver, then click Scan again.`), { status: 400 });
  }
  config = upsertPrinter(loadConfig(), { url: target, name, token });
  await saveConfig(config);
  if (target !== base) { for (const w of workers.values()) await w.stop(); workers.clear(); }
  base = target;
  const previous = workers.get(keyOf(name));
  if (previous) await previous.stop();
  const worker = makeWorker(name, token);
  workers.set(keyOf(name), worker);
  worker.start();
  lastScan.at = 0;
  log(`[Connector] Linked "${name}" from the dashboard to ${target}. Printers on this PC: ${workers.size}.`);
  scanAndReportLocalPrinters().catch(() => {});
  return { printer: name };
}

async function unpair({ printer: name }) {
  const worker = workers.get(keyOf(name));
  if (worker) { await worker.stop(); workers.delete(keyOf(name)); }
  config = removePrinter(loadConfig(), name);
  await saveConfig(config);
  log(`[Connector] Disconnected "${name}" from this PC's connector. Printers left: ${workers.size}.`);
  return { printer: name, remaining: workers.size };
}

log('============================================================');
log('       SmartPrint Windows Shop Connector · v3.0            ');
log('============================================================');
log(`  Server URL  : ${base}`);
log(`  Printers    : ${workers.size ? [...workers.values()].map(w => w.name).join(', ') : '(none linked yet)'}`);
log(`  Print Engine: ${sumatra ? 'SumatraPDF Portable (' + sumatra + ')' : 'Native Windows Print Spooler'}`);
log(`  Status      : ${workers.size ? `ONLINE · Listening for shop print jobs on ${workers.size} printer${workers.size === 1 ? '' : 's'}...` : 'Waiting to be linked from the SmartPrint Printers page'}`);
try {
  await startBridge({
    state: () => {
      const list = [...workers.values()];
      return { base, linked: list.some(w => !w.authFailed), needsRelink: list.length > 0 && list.every(w => w.authFailed), printer: list[0]?.name ?? '', linkedPrinters: list.map(w => ({ name: w.name, authFailed: w.authFailed })) };
    },
    printers: ({ fresh } = {}) => collectLocalPrinters({ maxAge: fresh ? 0 : 15000 }),
    pair, unpair,
    // Installed drivers with their maker, cached for a minute (listing them takes a second or two).
    drivers: async () => {
      if (Date.now() - driverCache.at > 60000) driverCache = { at: Date.now(), list: await listInstalledDrivers() };
      return driverCache.list.map(name => ({ name, manufacturer: detectManufacturer('', name) }));
    },
    probe: ({ ip }) => probePrinterAddress(ip),
    addNetworkPrinter: async input => {
      const added = await addNetworkPrinter(input, { existingNames: (await getWindowsPrinters()).map(p => p.Name) });
      lastScan.at = 0; driverCache.at = 0;
      log(`[Connector] Added network printer "${added.name}" (${added.ip}) using the installed driver "${added.driver}".`);
      return added;
    }
  }, { extraOrigins: String(process.env.SMARTPRINT_TRUSTED_ORIGINS || '').split(',').filter(Boolean), log });
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    // One connector per PC: a second copy would compete for the same jobs.
    log(`[Connector] Another SmartPrint connector is already running on this PC (port ${BRIDGE_PORT}). Exiting.`);
    cleanupPid();
    process.exit(0);
  }
  log(`[Connector] Dashboard link unavailable: ${err.message}`);
}
log('============================================================');

// Clean up stale files older than 10 minutes
for (const name of await readdir(root)) {
  if (!/^[a-f0-9-]{36}\.pdf$/.test(name)) continue;
  const path = join(root, name);
  try {
    const info = await stat(path);
    if (info.isFile() && Date.now() - info.mtimeMs > 600000) await unlink(path);
  } catch {}
}

async function prepareJob(job, worker) {
  if (!processorSecret) { console.log(`[Preview] Skipping local processor for job ${job.id} (processor secret not configured).`); return; }
  const files = [];
  for (const file of job.files) {
    const chunks = [];
    for (let part = 0; part < Math.ceil(file.size / 1048576); part++) chunks.push((await worker.request(`/api/device/preparations/${job.id}/files/${file.id}/${part}`, { binary: true })).bytes);
    files.push({ data: Buffer.concat(chunks).toString('base64'), name: file.name });
  }
  const response = await fetch('http://127.0.0.1:4000/prepare', {
    method: 'POST',
    headers: { Authorization: `Bearer ${processorSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, options: job.options }),
    signal: AbortSignal.timeout(125000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Scanner or converter failed.');
  const bytes = Buffer.from(result.data, 'base64');
  await worker.request(`/api/device/preparations/${job.id}/result`, { method: 'POST', body: { size: bytes.length } });
  for (let start = 0, part = 0; start < bytes.length; start += 1048576, part++) {
    await worker.request(`/api/device/preparations/${job.id}/result/${part}`, { method: 'PUT', body: { data: bytes.subarray(start, start + 1048576).toString('base64') } });
  }
  await worker.request(`/api/device/preparations/${job.id}/complete`, { method: 'POST', body: { pages: result.pages } });
  console.log(`[Preview] Preparation complete for job ${job.id}`);
}

let running = true;
process.on('SIGINT', () => { running = false; cleanupPid(); console.log('\nStopping connector...'); });
process.on('SIGTERM', () => { running = false; cleanupPid(); console.log('\nStopping connector...'); });
process.on('exit', cleanupPid);

// Old SmartPrint jobs still waiting in a Windows queue would all print when a cable is plugged back in.
const clearStale = () => clearStaleConnectorJobs(root, { log }).catch(() => 0);
await clearStale();
const staleCleaner = setInterval(clearStale, 10 * 60000);
await scanAndReportLocalPrinters();
const printerScanner = setInterval(() => scanAndReportLocalPrinters(), 60000);

// Conversion can take minutes, so it has its own loop, outside the paid-print workers. Any linked printer's key may
// claim a preparation (they belong to the shop, not to one printer).
const idleDelay = (streak, base, max) => Math.min(max, base + Math.floor(streak / 10) * 500);
async function preparationLoop() {
  let idleStreak = 0;
  while (running && processorSecret) {
    const worker = [...workers.values()].find(w => !w.authFailed);
    if (!worker) { await new Promise(resolve => setTimeout(resolve, 5000)); continue; }
    try {
      const preparation = await worker.request('/api/device/preparations/claim', { method: 'POST' });
      if (preparation) {
        idleStreak = 0;
        try { await prepareJob(preparation, worker); }
        catch {
          await worker.request(`/api/device/preparations/${preparation.id}/fail`, { method: 'POST', body: { error: 'The shop computer could not convert this file. Please export it as PDF and retry.' } }).catch(() => {});
        }
        continue;
      }
    } catch (prepErr) { log(`[Preview] Preparation loop notice: ${prepErr.message}`); }
    idleStreak++;
    if (running) await new Promise(resolve => setTimeout(resolve, idleDelay(idleStreak, 1500, 3000)));
  }
}
const preparing = preparationLoop();
for (const worker of workers.values()) worker.start();
while (running) await new Promise(resolve => setTimeout(resolve, 1000));

await preparing;
await Promise.all([...workers.values()].map(w => w.stop()));
clearInterval(printerScanner);
clearInterval(staleCleaner);
