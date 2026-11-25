import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never touch the real connector folder of the PC running the tests.
process.env.LOCALAPPDATA = mkdtempSync(join(tmpdir(), 'smartprint-multi-'));

const { openDatabase } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');
const { normalizeConfig, upsertPrinter, removePrinter, renamePrinter } = await import('../connector/config.js');
const { validatePrinterAddress, validateNetworkPrinter, probePrinterAddress, addNetworkPrinter, adminCommand } = await import('../connector/network-printer.js');
const { createWorker } = await import('../connector/worker.js');
const { detectManufacturer, classifyConnection } = await import('../server/printer-capabilities.js');

// ---- settings file ----------------------------------------------------------------------------------------------
test('settings: an old single-printer file is read as one printer and nothing is lost', () => {
  const old = { Url: 'https://shop.example/', Token: 'tok-1', Printer: 'HP LaserJet 1020', ProcessorSecret: 'keep-me' };
  const cfg = normalizeConfig(old);
  assert.deepEqual(cfg.Printers, [{ Name: 'HP LaserJet 1020', Token: 'tok-1' }]);
  assert.equal(cfg.Url, 'https://shop.example');
  assert.equal(cfg.ProcessorSecret, 'keep-me');
  // an unnamed single printer (connector picked the Windows default) is kept, not dropped
  assert.deepEqual(normalizeConfig({ Token: 'tok-x' }).Printers, [{ Name: '', Token: 'tok-x' }]);
  assert.deepEqual(normalizeConfig({}).Printers, []);
});

test('settings: several printers, relinking, removing, and older tools still see the first one', () => {
  let cfg = upsertPrinter({ Url: 'https://shop.example', Token: 'tok-1', Printer: 'HP LaserJet 1020' }, { url: 'https://shop.example', name: 'Epson L3250', token: 'tok-2' });
  assert.deepEqual(cfg.Printers.map(p => p.Name), ['HP LaserJet 1020', 'Epson L3250']);
  cfg = upsertPrinter(cfg, { url: 'https://shop.example/', name: 'brother dcp-t820dw', token: 'tok-3' });
  assert.equal(cfg.Printers.length, 3);
  cfg = upsertPrinter(cfg, { url: 'https://shop.example', name: 'EPSON L3250', token: 'tok-2b' });
  assert.deepEqual(cfg.Printers.filter(p => /epson/i.test(p.Name)), [{ Name: 'EPSON L3250', Token: 'tok-2b' }], 'linking the same printer again replaces its key, case-insensitively');
  assert.deepEqual([cfg.Token, cfg.Printer], ['tok-1', 'HP LaserJet 1020'], 'legacy fields mirror the first printer');
  cfg = removePrinter(cfg, 'hp laserjet 1020');
  assert.deepEqual(cfg.Printers.map(p => p.Name), ['brother dcp-t820dw', 'EPSON L3250']);
  assert.equal(cfg.Printer, 'brother dcp-t820dw');
  cfg = renamePrinter(cfg, 'brother dcp-t820dw', 'Brother DCP-T820DW Printer');
  assert.equal(cfg.Printers[0].Name, 'Brother DCP-T820DW Printer');
  cfg = removePrinter(removePrinter(cfg, 'Brother DCP-T820DW Printer'), 'EPSON L3250');
  assert.deepEqual([cfg.Printers, cfg.Token, cfg.Printer], [[], '', ''], 'removing the last printer leaves nothing linked (the old key does not come back)');
  assert.deepEqual(normalizeConfig(cfg).Printers, []);
  // another SmartPrint server: the old printers belonged to the old server
  const moved = upsertPrinter({ Url: 'https://old.example', Printers: [{ Name: 'A', Token: '1' }, { Name: 'B', Token: '2' }] }, { url: 'https://new.example', name: 'C', token: '3' });
  assert.deepEqual([moved.Url, moved.Printers.map(p => p.Name)], ['https://new.example', ['C']]);
  assert.throws(() => upsertPrinter({}, { url: 'https://x', name: '', token: 't' }));
});

// ---- brands and connections -------------------------------------------------------------------------------------
test('HP, Brother, Epson and Canon printers are recognised over USB and over the network', () => {
  const cases = [
    ['HP LaserJet 1020', 'USB003', 'HP', true], ['HP DeskJet 2332 series', 'USB001', 'HP', true], ['HP OfficeJet Pro 8710', 'HP5C6D7E', 'HP', false],
    ['Brother HL-L2321D', 'USB001', 'Brother', true], ['Brother DCP-T820DW Printer', 'WSD-c6dcd302-c0fa', 'Brother', false], ['Brother MFC-L2750DW', 'BRN_A1B2C3', 'Brother', false],
    ['EPSON L3250 Series', 'EPUSB1:', 'Epson', true], ['EPSON L3250 Series', 'EP1A2B3C', 'Epson', false], ['EPSON WorkForce WF-2830', 'IP_192.168.1.44', 'Epson', false],
    ['Canon G2010 series', 'USB001', 'Canon', true], ['Canon PIXMA G3010', 'CNBJNP_192.168.1.5', 'Canon', false], ['Canon LBP2900', 'USB002', 'Canon', true], ['Canon imageCLASS MF445dw', 'TCP_10.0.0.8', 'Canon', false]
  ];
  for (const [name, port, maker, wired] of cases) {
    assert.equal(detectManufacturer(name, name), maker, name);
    const c = classifyConnection({ name, port, driver: name });
    assert.equal(c.isWired, wired, `${name} on ${port} wired`);
    assert.equal(c.isWifi, !wired, `${name} on ${port} wifi`);
  }
  assert.equal(detectManufacturer('Some Unknown Printer'), 'Other');
  assert.equal(classifyConnection({ name: 'Microsoft Print to PDF', port: 'PORTPROMPT:' }).connectionType, 'Virtual / PDF');
});

// ---- add a network printer by address ---------------------------------------------------------------------------
test('network printer address: only private IPv4 addresses are accepted', () => {
  for (const ok of ['192.168.1.50', '10.0.0.7', '172.16.5.9', '172.31.255.1', ' 192.168.0.100 ']) assert.equal(validatePrinterAddress(ok), ok.trim());
  for (const bad of ['8.8.8.8', '127.0.0.1', '169.254.1.5', '224.0.0.1', '172.32.0.1', '192.168.1.0', '192.168.1.255', '192.168.1.256', '192.168.001.050', '192.168.1', 'printer.local', '192.168.1.50:9100', '192.168.1.50; calc', '', null])
    assert.throws(() => validatePrinterAddress(bad), `${bad}`);
});

test('network printer: only an already-installed, non-software driver may be used; names are checked', () => {
  const drivers = ['HP Universal Printing PCL 6', 'Brother DCP-T820DW Printer', 'Microsoft IPP Class Driver'];
  const ok = validateNetworkPrinter({ ip: '192.168.1.50', name: 'Front desk (colour)', driver: 'brother dcp-t820dw printer' }, drivers);
  assert.deepEqual(ok, { ip: '192.168.1.50', name: 'Front desk (colour)', driver: 'Brother DCP-T820DW Printer', portName: 'IP_192.168.1.50' });
  assert.equal(validateNetworkPrinter({ ip: '10.0.0.9', driver: 'HP Universal Printing PCL 6' }, drivers).name, 'HP 10.0.0.9', 'default name carries the brand and address');
  assert.equal(validateNetworkPrinter({ ip: '10.0.0.9', driver: 'Microsoft IPP Class Driver' }, drivers).name, 'Network printer 10.0.0.9');
  assert.throws(() => validateNetworkPrinter({ ip: '192.168.1.50', driver: 'Epson ESC/P-R' }, drivers), /already installed/, 'a driver that is not installed is never fetched');
  assert.throws(() => validateNetworkPrinter({ ip: '192.168.1.50', driver: 'Microsoft Print To PDF' }, ['Microsoft Print To PDF']), /software driver/);
  assert.throws(() => validateNetworkPrinter({ ip: '192.168.1.50', driver: 'HP Universal Printing PCL 6', name: 'x"; Remove-Item *' }, drivers), /letters, numbers/);
  assert.throws(() => validateNetworkPrinter({ ip: '8.8.8.8', driver: 'HP Universal Printing PCL 6' }, drivers), /private network/);
});

test('network printer: values reach PowerShell through the environment, an admin prompt is explained, duplicates refused', async () => {
  const drivers = ['Brother DCP-T820DW Printer'];
  const calls = [];
  const input = { ip: '192.168.1.50', name: "Owner's Brother", driver: 'Brother DCP-T820DW Printer' };
  // a name with an apostrophe is not allowed at all, so nothing can break out of a quoted string
  await assert.rejects(addNetworkPrinter(input, { installedDrivers: drivers, run: async () => ({}) }), /letters, numbers/);
  const good = { ip: '192.168.1.50', name: 'Brother Front Desk', driver: 'Brother DCP-T820DW Printer' };
  const added = await addNetworkPrinter(good, { installedDrivers: drivers, run: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: '' }; } });
  assert.equal(added.name, 'Brother Front Desk');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.SP_IP, '192.168.1.50');
  assert.equal(calls[0].options.env.SP_NAME, 'Brother Front Desk');
  assert.equal(calls[0].options.env.SP_DRIVER, 'Brother DCP-T820DW Printer');
  assert.ok(!calls[0].args.join(' ').includes('192.168.1.50') && !calls[0].args.join(' ').includes('Brother Front Desk'), 'no user value is placed in the command text');

  const denied = await addNetworkPrinter(good, { installedDrivers: drivers, run: async () => { throw Object.assign(new Error('failed'), { stderr: 'Add-PrinterPort : Access is denied.' }); } }).catch(e => e);
  assert.equal(denied.status, 403);
  assert.equal(denied.needsAdmin, true);
  assert.equal(denied.command, "Add-PrinterPort -Name 'IP_192.168.1.50' -PrinterHostAddress '192.168.1.50'; Add-Printer -Name 'Brother Front Desk' -DriverName 'Brother DCP-T820DW Printer' -PortName 'IP_192.168.1.50'");
  assert.equal(adminCommand({ ip: '10.0.0.1', name: "It's", driver: "D'r", portName: 'IP_10.0.0.1' }).includes("'It''s'"), true, 'quotes are doubled in the copyable command');
  const other = await addNetworkPrinter(good, { installedDrivers: drivers, run: async () => { throw Object.assign(new Error('x'), { stderr: 'The specified driver does not exist\nmore' }); } }).catch(e => e);
  assert.equal(other.status, 500);
  assert.match(other.message, /driver does not exist/);
  const duplicate = await addNetworkPrinter(good, { installedDrivers: drivers, existingNames: ['brother front desk'], run: async () => assert.fail('must not run') }).catch(e => e);
  assert.equal(duplicate.status, 409);
});

test('network printer: reachability reports which printing ports answered', async () => {
  const answered = await probePrinterAddress('192.168.1.50', { open: async (host, port) => port === 9100 || port === 631 });
  assert.deepEqual([answered.reachable, answered.ports.map(p => p.port)], [true, [9100, 631]]);
  const silent = await probePrinterAddress('192.168.1.51', { open: async () => false });
  assert.deepEqual([silent.reachable, silent.ports], [false, []]);
  await assert.rejects(probePrinterAddress('8.8.8.8', { open: async () => assert.fail('never probe public hosts') }), /private network/);
});

// ---- several printers on one PC, against the real server -----------------------------------------------------------
async function start(t) {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie, token } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: (response.headers.get('content-type') || '').includes('json') ? await response.json() : null, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const owner = (await request('/api/auth/login', { method: 'POST', body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' } })).cookie;
  const root = mkdtempSync(join(tmpdir(), 'smartprint-worker-'));
  const printed = [];
  // Connects one printer exactly as the Printers page does, then wraps its key in a worker.
  const addPrinter = async (name, { color, duplex = false, health = null, print, refreshToken } = {}) => {
    const linked = await request('/api/owner/printers/autoconnect', { method: 'POST', cookie: owner, body: { name, color, duplex, manual: true } });
    const worker = createWorker({
      name, token: linked.body.token, getBase: () => base, root, getHealth: () => health, refreshToken,
      print: print ?? (async ({ printerName, options }) => { printed.push({ printerName, color: options.color }); return { method: 'test' }; }),
      sleep: () => Promise.resolve()
    });
    await worker.heartbeat();
    return { worker, id: linked.body.id, token: linked.body.token };
  };
  return { db, request, owner, root, printed, addPrinter };
}

test('two printers on one PC each take only the jobs they can print, at the same time', async t => {
  const { db, request, owner, printed, addPrinter } = await start(t);
  const bw = await addPrinter('HP LaserJet 1020', { color: false });
  const colour = await addPrinter('Epson L3250 Series', { color: true });
  const devices = (await request('/api/owner/devices', { cookie: owner })).body;
  assert.equal(devices.filter(d => d.active).length, 2, 'both printers are connected side by side');
  assert.ok(devices.every(d => d.heartbeat), 'each has its own heartbeat');

  const colourJob = (await request(`/api/owner/devices/${colour.id}/test-print`, { method: 'POST', cookie: owner })).body.orderId; // colour printer -> colour test page
  const bwJob = (await request(`/api/owner/devices/${bw.id}/test-print`, { method: 'POST', cookie: owner })).body.orderId;
  const [first, second] = await Promise.all([bw.worker.claimOnce(), colour.worker.claimOnce()]);
  assert.deepEqual([first, second], ['job', 'job']);
  assert.deepEqual(printed.map(p => `${p.printerName}:${p.color}`).sort(), ['Epson L3250 Series:color', 'HP LaserJet 1020:bw']);
  const rows = Object.fromEntries((await db.query('SELECT id,status FROM orders')).map(r => [r.id, r.status]));
  assert.equal(rows[colourJob], 'awaiting_confirmation');
  assert.equal(rows[bwJob], 'awaiting_confirmation');
  assert.equal(await bw.worker.claimOnce(), 'idle');
});

test('a colour job is never taken by a black-and-white printer, even when it is the only one connected', async t => {
  const { db, request, owner, printed, addPrinter } = await start(t);
  const bw = await addPrinter('HP LaserJet 1020', { color: false });
  const colour = await addPrinter('Epson L3250 Series', { color: true });
  const job = (await request(`/api/owner/devices/${colour.id}/test-print`, { method: 'POST', cookie: owner })).body.orderId;
  assert.equal(await bw.worker.claimOnce(), 'idle');
  assert.equal(printed.length, 0);
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [job]))[0].status, 'queued');
  assert.equal(await colour.worker.claimOnce(), 'job');
  assert.deepEqual(printed.map(p => p.printerName), ['Epson L3250 Series']);
});

test('a printer with a reported fault takes nothing while its neighbour keeps printing', async t => {
  const { db, request, owner, printed, addPrinter } = await start(t);
  const jammed = await addPrinter('Brother HL-L2321D', { color: false, health: { blocking: true, label: 'Paper jam', at: Date.now() } });
  const fine = await addPrinter('HP LaserJet 1020', { color: false });
  const job = (await request(`/api/owner/devices/${fine.id}/test-print`, { method: 'POST', cookie: owner })).body.orderId;
  assert.equal(await jammed.worker.claimOnce(), 'blocked');
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [job]))[0].status, 'queued', 'the jammed printer did not claim it');
  assert.equal(await fine.worker.claimOnce(), 'job');
  assert.deepEqual(printed.map(p => p.printerName), ['HP LaserJet 1020']);
});

test('a print error is reported for review, the journal is cleared, and a repeated delivery is never printed twice', async t => {
  const { db, request, owner, root, addPrinter } = await start(t);
  let attempts = 0;
  const flaky = await addPrinter('Canon G3010 series', { color: true, print: async () => { attempts++; throw new Error('Spooler refused the job'); } });
  const job = (await request(`/api/owner/devices/${flaky.id}/test-print`, { method: 'POST', cookie: owner })).body.orderId;
  assert.equal(await flaky.worker.claimOnce(), 'job');
  assert.equal(attempts, 1);
  // The server had already accepted "submitted", so the outcome is uncertain: the owner checks the printer. It is never
  // recorded as a clean "failed" (nothing printed) because Windows may have printed part of it.
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [job]))[0].status, 'needs_review');
  assert.ok(!existsSync(join(root, `${job}.submitted`)) && !existsSync(join(root, `${job}.pdf`)), 'no stray files after a failure');

  // success path: the job is journalled, and the same job offered again within minutes is not printed again
  let prints = 0;
  const good = await addPrinter('Canon PIXMA G2010', { color: true, print: async () => { prints++; return { method: 'test' }; } });
  const id2 = (await request(`/api/owner/devices/${good.id}/test-print`, { method: 'POST', cookie: owner })).body.orderId;
  const claimed = await good.worker.request('/api/device/claim', { method: 'POST' });
  assert.equal(claimed.id, id2);
  assert.equal(await good.worker.printJob(claimed), 'printed');
  assert.equal(await good.worker.printJob(claimed), 'duplicate', 'the journal stops a second print of the same job');
  assert.equal(prints, 1);
});

test('a rejected device key is reported once and recovers when settings.json holds a new key', async t => {
  const { request, owner, addPrinter } = await start(t);
  let fresh = null;
  const printer = await addPrinter('HP LaserJet 1020', { color: false, refreshToken: () => fresh });
  const real = printer.worker.token;
  printer.worker.token = 'not-a-valid-key-0123456789';
  await assert.rejects(printer.worker.claimOnce(), /401/);
  assert.equal(printer.worker.authFailed, true);
  fresh = real;
  await assert.rejects(printer.worker.claimOnce(), /401/, 'the request that discovers the new key still reports the old failure');
  assert.equal(printer.worker.authFailed, false);
  assert.equal(await printer.worker.claimOnce(), 'idle', 'and the next one works');
  void request; void owner;
});

// ---- which Windows printer a job goes to ----------------------------------------------------------------------------
test('with several printers a job prints on exactly the named printer, never on a lookalike', async () => {
  const { selectPrintTarget } = await import('../connector/sumatra-helper.js');
  const installed = [
    { Name: 'HP LaserJet 1020', PrinterStatus: 0, PortName: 'USB003' },
    { Name: 'EPSON L3250 Series', PrinterStatus: 0, PortName: 'EPUSB1:' },
    { Name: 'EPSON L3250 Series (Copy 1)', PrinterStatus: 0, PortName: 'USB002' },
    { Name: 'Brother HL-L2321D', PrinterStatus: 0x80, PortName: 'USB004' }
  ];
  assert.equal(selectPrintTarget('epson l3250 series', installed, { strict: true }).name, 'EPSON L3250 Series', 'exact name, Windows spelling');
  assert.throws(() => selectPrintTarget('Canon G3010 series', installed, { strict: true }), /not installed in Windows/, 'a missing printer fails instead of printing elsewhere');
  assert.throws(() => selectPrintTarget('Brother HL-L2321D', installed, { strict: true }), /Offline in Windows/);
  assert.throws(() => selectPrintTarget('EPSON L3250', installed, { strict: true }), /not installed/, 'a partial name is not a match');
  // the single-printer behaviour is unchanged: an offline or missing printer may be replaced by a close match
  assert.equal(selectPrintTarget('Canon G3010 series', installed, { strict: false }).switched, true);
  assert.throws(() => selectPrintTarget('Brother HL-L2321D', installed, { strict: false }), /Offline in Windows/);
});

// ---- the dashboard link on the shop PC --------------------------------------------------------------------------------
test('the connector link exposes per-printer state and the add/disconnect/test routes, to trusted pages only', async t => {
  const { createServer } = await import('node:http');
  const { createBridgeHandler } = await import('../connector/local-bridge.js');
  const calls = [];
  const connector = {
    state: () => ({ base: 'http://localhost:3000', linked: true, needsRelink: false, printer: 'HP LaserJet 1020', linkedPrinters: [{ name: 'HP LaserJet 1020', authFailed: false }, { name: 'Epson L3250 Series', authFailed: true }] }),
    printers: async () => [{ name: 'HP LaserJet 1020' }],
    pair: async body => { calls.push(['pair', body]); return { printer: body.printer }; },
    unpair: async body => { calls.push(['unpair', body]); return { printer: body.printer, remaining: 1 }; },
    drivers: async () => [{ name: 'HP LaserJet 1020', manufacturer: 'HP' }],
    probe: async body => { calls.push(['probe', body]); return { ip: body.ip, reachable: true, ports: [{ port: 9100, label: 'RAW / JetDirect' }] }; },
    addNetworkPrinter: async body => {
      calls.push(['add', body]);
      if (body.ip === '10.0.0.9') throw Object.assign(new Error('Windows needs administrator permission.'), { status: 403, needsAdmin: true, command: 'Add-PrinterPort ...' });
      return { name: body.name || 'Brother 10.0.0.8', portName: `IP_${body.ip}` };
    }
  };
  const server = createServer(createBridgeHandler(connector));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`, origin = 'http://localhost:3000';
  const call = async (path, { method = 'GET', body, from = origin } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(from ? { Origin: from } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };

  const status = await call('/status?drivers=1');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.linkedPrinters, [{ name: 'HP LaserJet 1020', authFailed: false }, { name: 'Epson L3250 Series', authFailed: true }], 'each printer reports its own link state');
  assert.deepEqual(status.body.drivers, [{ name: 'HP LaserJet 1020', manufacturer: 'HP' }]);
  assert.equal('drivers' in (await call('/status')).body, false, 'drivers are listed only when asked for');

  assert.deepEqual((await call('/unpair', { method: 'POST', body: { printer: 'HP LaserJet 1020' } })).body, { ok: true, printer: 'HP LaserJet 1020', remaining: 1 });
  assert.equal((await call('/unpair', { method: 'POST', body: { printer: '  ' } })).status, 400);
  assert.deepEqual((await call('/probe', { method: 'POST', body: { ip: '192.168.1.50' } })).body.ports, [{ port: 9100, label: 'RAW / JetDirect' }]);
  assert.deepEqual((await call('/network-printer', { method: 'POST', body: { ip: '10.0.0.8', driver: 'Brother DCP-T820DW Printer', name: 'Front desk' } })).body, { ok: true, printer: 'Front desk', portName: 'IP_10.0.0.8' });
  const admin = await call('/network-printer', { method: 'POST', body: { ip: '10.0.0.9', driver: 'x' } });
  assert.deepEqual([admin.status, admin.body.needsAdmin, admin.body.command], [403, true, 'Add-PrinterPort ...'], 'the administrator hint reaches the page');

  // other websites, and requests without an Origin, can do none of this
  const before = calls.length;
  for (const from of ['https://evil.example', '']) {
    for (const [path, body] of [['/unpair', { printer: 'HP LaserJet 1020' }], ['/probe', { ip: '192.168.1.50' }], ['/network-printer', { ip: '10.0.0.8', driver: 'x' }], ['/pair', { url: 'https://evil.example', token: 'a'.repeat(32), printer: 'x' }]])
      assert.equal((await call(path, { method: 'POST', body, from })).status, 403, `${from || '(no origin)'} ${path}`);
    assert.equal((await call('/status', { from })).status, 403);
  }
  assert.equal(calls.length, before, 'nothing reached the connector');
});
