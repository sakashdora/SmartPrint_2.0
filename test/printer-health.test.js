import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Online payments must look configured so the payment gate is reachable; the keys are fake and no request is made to
// Razorpay (every path below is refused or served before a provider call).
process.env.RAZORPAY_KEY_ID = 'rzp_test_abcdefgh12345678';
process.env.RAZORPAY_KEY_SECRET = 'test_secret_value_for_unit_tests';
delete process.env.RAZORPAY_LIVE_ENABLED;

const { openDatabase } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');
const { classifyPrinterHealth, evaluateDevice, shopPrinterAvailability } = await import('../server/printer-health.js');
const { clientIp, digest, encrypt, loadKey } = await import('../server/security.js');
const { pdf } = await import('./helpers/edu.js');

// ---- pure logic -------------------------------------------------------------------------------------------------
test('Windows spooler status codes map to honest, blocking-aware states', () => {
  const cases = [
    [0, 'ready', false], ['Normal', 'ready', false], [0x1000000, 'ready', false], // power save is idle, not a fault
    [0x80, 'offline', true], [0x8, 'paper_jam', true], [0x10, 'paper_out', true], [0x400000, 'door_open', true],
    [0x40000, 'toner_out', true], [0x2, 'error', true], [0x1, 'paused', true], [0x100000, 'attention', true],
    [0x20000, 'toner_low', false], [0x400, 'printing', false], [0x200, 'busy', false],
    [0x80 | 0x400, 'offline', true], // a fault wins over activity
    [0x8 | 0x20000, 'paper_jam', true], // a fault wins over a warning
    ['Offline', 'offline', true], ['PaperJam', 'paper_jam', true], ['Paper Out', 'paper_out', true]
  ];
  for (const [code, state, blocking] of cases) {
    const verdict = classifyPrinterHealth(code);
    assert.equal(verdict.state, state, `code ${code}`);
    assert.equal(verdict.blocking, blocking, `code ${code} blocking`);
  }
  // Anything Windows did not tell us clearly is "unknown", never "ready".
  for (const code of [null, undefined, '', -1, 1.5, 'garbage', 0x2000000, NaN]) assert.equal(classifyPrinterHealth(code).state, 'unknown', String(code));
  assert.deepEqual(classifyPrinterHealth(0x80 | 0x8).flags, ['Offline in Windows (cable, power or network)', 'Paper jam']);
});

test('device evaluation never calls a printer healthy on the heartbeat alone', () => {
  const now = Date.parse('2026-11-25T10:00:00.000Z'), ago = s => new Date(now - s * 1000).toISOString();
  const base = { active: 1, paused: 0, heartbeat: ago(5), health: null, health_checked: null };
  const e = (extra, at = now) => evaluateDevice({ ...base, ...extra }, at);

  assert.equal(e({ active: 0 }).state, 'disconnected');
  assert.equal(e({ active: 0 }).claimable, false);
  const gone = e({ heartbeat: ago(400) });
  assert.deepEqual([gone.state, gone.connector_online, gone.claimable], ['connector_offline', false, false]);
  assert.equal(e({ heartbeat: null }).state, 'connector_offline');
  const paused = e({ paused: 1, paused_note: 'Out for lunch' });
  assert.deepEqual([paused.state, paused.label, paused.claimable], ['paused_by_owner', 'Out for lunch', false]);

  const silent = e({});
  assert.deepEqual([silent.state, silent.verified, silent.claimable], ['unknown', false, true], 'older connectors that never report keep working, but are not called ready');
  assert.match(silent.label, /status not reported/);
  assert.equal(silent.checked_at, null);

  const ready = e({ health: 'ready', health_checked: ago(30) });
  assert.deepEqual([ready.state, ready.verified, ready.claimable], ['ready', true, true]);
  assert.equal(ready.checked_at, ago(30), 'the time of the last check is always shown');

  const jam = e({ health: 'paper_jam', health_checked: ago(30), health_detail: 'Paper jam' });
  assert.deepEqual([jam.state, jam.blocking, jam.claimable, jam.connector_online], ['paper_jam', true, false, true]);
  assert.equal(jam.detail, 'Paper jam');

  // A fault report that stopped refreshing must not pin the printer shut forever, nor keep claiming a stale "ready".
  for (const health of ['paper_jam', 'ready']) {
    const stale = e({ health, health_checked: ago(900) });
    assert.equal(stale.state, 'unknown', `stale ${health}`);
    assert.match(stale.label, /out of date/);
    assert.equal(stale.verified, false);
  }
  assert.equal(e({ health: 'not-a-state', health_checked: ago(10) }).state, 'unknown', 'unknown state names are ignored');
});

test('clientIp trusts CF-Connecting-IP only from this computer or when the operator says so', () => {
  const req = (peer, header, ip = '198.51.100.9') => ({ socket: { remoteAddress: peer }, headers: header ? { 'cf-connecting-ip': header } : {}, ip });
  delete process.env.TRUST_CF_CONNECTING_IP;
  assert.equal(clientIp(req('203.0.113.50', '1.2.3.4')), '198.51.100.9', 'a remote caller cannot choose its own address');
  assert.equal(clientIp(req('127.0.0.1', '1.2.3.4')), '1.2.3.4', 'a cloudflared tunnel on this PC is trusted');
  assert.equal(clientIp(req('::ffff:127.0.0.1', '2001:db8::1')), '2001:db8::1');
  assert.equal(clientIp(req('127.0.0.1', 'not-an-ip')), '198.51.100.9', 'a malformed header is ignored');
  assert.equal(clientIp(req('127.0.0.1', undefined)), '198.51.100.9');
  process.env.TRUST_CF_CONNECTING_IP = 'true';
  try { assert.equal(clientIp(req('203.0.113.50', '1.2.3.4')), '1.2.3.4'); } finally { delete process.env.TRUST_CF_CONNECTING_IP; }
});

// ---- server flows -----------------------------------------------------------------------------------------------
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
  const signIn = async email => (await request('/api/auth/login', { method: 'POST', body: { email, password: 'SmartPrintDemo!2026' } })).cookie;
  const owner = await signIn('owner@smartprint.local');
  // A shop printer that has checked in, as the connector on the shop PC would.
  const connect = async (name = 'HP LaserJet 1020', capabilities = {}) => {
    const added = await request('/api/owner/printers/autoconnect', { method: 'POST', cookie: owner, body: { name, color: false, duplex: false, ...capabilities } });
    await request('/api/device/heartbeat', { method: 'POST', token: added.body.token });
    return added.body;
  };
  const report = (device, code) => request('/api/device/printers/scanned', { method: 'POST', token: device.token, body: { printers: [], health: { code } } });
  const makeQuote = async (options = {}) => {
    const key = loadKey(), sealed = encrypt(await pdf(1), key), documentId = randomUUID(), quoteId = randomUUID(), secret = `quote-${randomUUID()}`;
    const merged = JSON.stringify({ color: 'bw', duplex: false, copies: 1, layout: 'single', range: '', ...options });
    const expires = new Date(Date.now() + 600000).toISOString();
    await db.query('INSERT INTO documents (id,shop_id,payload,iv,tag,expires) VALUES ($1,$2,$3,$4,$5,$6)', [documentId, 'shop-demo', sealed.payload, sealed.iv, sealed.tag, new Date(Date.now() + 3600000).toISOString()]);
    await db.query('INSERT INTO quotes (id,shop_id,document_id,token,options,pages,sides,sheets,amount,version,expires) VALUES ($1,$2,$3,$4,$5,1,1,1,200,1,$6)', [quoteId, 'shop-demo', documentId, digest(secret), merged, expires]);
    return { quoteId, secret };
  };
  return { db, request, owner, connect, report, makeQuote, signIn };
}

test('the owner card says what is known, and a reported fault is shown with its check time and raised once', async t => {
  const { db, request, owner, connect, report } = await start(t);
  const device = await connect();
  let [row] = (await request('/api/owner/devices', { cookie: owner })).body;
  assert.equal(row.health.state, 'unknown');
  assert.equal(row.health.verified, false);
  assert.notEqual(row.status_note, 'Ready');

  assert.equal((await report(device, 0)).status, 200);
  [row] = (await request('/api/owner/devices', { cookie: owner })).body;
  assert.deepEqual([row.health.state, row.health.verified], ['ready', true]);
  assert.ok(row.health.checked_at);

  await report(device, 0x8);
  await report(device, 0x8); // the next scan: same fault, no second alert
  [row] = (await request('/api/owner/devices', { cookie: owner })).body;
  assert.deepEqual([row.health.state, row.health.blocking, row.health.claimable], ['paper_jam', true, false]);
  assert.match(row.status_note, /Paper jam/);
  const alerts = await db.query("SELECT * FROM notifications WHERE event_type='printer.problem'");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /Paper jam/);

  await report(device, 0x10); // a different fault is a new event
  assert.equal((await db.query("SELECT * FROM notifications WHERE event_type='printer.problem'")).length, 2);
});

test('the server classifies the raw status itself: an invented state name is not accepted', async t => {
  const { request, owner, connect, db } = await start(t);
  const device = await connect();
  await request('/api/device/printers/scanned', { method: 'POST', token: device.token, body: { printers: [], health: { state: 'ready', code: 0x8 } } });
  assert.equal((await request('/api/owner/devices', { cookie: owner })).body[0].health.state, 'paper_jam');
  await request('/api/device/printers/scanned', { method: 'POST', token: device.token, body: { printers: [], health: { code: null } } });
  assert.equal((await db.query('SELECT health FROM devices WHERE id=$1', [device.id]))[0].health, 'unknown', 'when Windows could not tell, the answer is unknown');
});

test('a printer that reports a fault is not offered paid work, and gets it back once fixed', async t => {
  const { db, request, owner, connect, report } = await start(t);
  const device = await connect();
  const [row] = (await request('/api/owner/devices', { cookie: owner })).body;
  const queued = await request(`/api/owner/devices/${row.id}/test-print`, { method: 'POST', cookie: owner });
  assert.equal(queued.status, 200);
  const status = async () => (await db.query('SELECT status FROM orders WHERE id=$1', [queued.body.orderId]))[0].status;

  await report(device, 0x10); // out of paper
  const refused = await request('/api/device/claim', { method: 'POST', token: device.token });
  assert.equal(refused.status, 200);
  assert.equal(refused.body, null, 'nothing is handed to a printer with no paper');
  assert.equal(await status(), 'queued', 'the paid job simply waits');
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM print_leases'))[0].n, 0);

  await report(device, 0);
  const claimed = await request('/api/device/claim', { method: 'POST', token: device.token });
  assert.equal(claimed.body?.id, queued.body.orderId);
  assert.equal(await status(), 'printing');
});

test('online payment is refused, before any charge, while the shop printer cannot print the job', async t => {
  const { db, request, connect, report, makeQuote } = await start(t);
  const device = await connect(); // B&W only printer
  await report(device, 0);

  // Ready and compatible: the order is created.
  let quote = await makeQuote();
  const ok = await request('/api/orders', { method: 'POST', token: quote.secret, body: { quoteId: quote.quoteId, method: 'online' } });
  assert.equal(ok.status, 201);

  // Jammed: refused, quote left untouched so the customer can pick cash/UPI or retry.
  await report(device, 0x8);
  quote = await makeQuote();
  const jammed = await request('/api/orders', { method: 'POST', token: quote.secret, body: { quoteId: quote.quoteId, method: 'online' } });
  assert.equal(jammed.status, 409);
  assert.match(jammed.body.error, /Paper jam/);
  assert.match(jammed.body.error, /not been charged/);
  assert.equal((await db.query('SELECT used FROM quotes WHERE id=$1', [quote.quoteId]))[0].used, 0);
  // Counter payment is still allowed: the customer can wait or the owner can fix the printer.
  const cash = await request('/api/orders', { method: 'POST', token: quote.secret, body: { quoteId: quote.quoteId, method: 'cash' } });
  assert.equal(cash.status, 201);

  // The second gate: an order already created cannot start a NEW Razorpay payment while the printer is down.
  const order = await request('/api/orders', { method: 'POST', token: (await makeQuote()).secret, body: { quoteId: (await db.query('SELECT id FROM quotes WHERE used=0 LIMIT 1'))[0].id, method: 'cash' } });
  assert.equal(order.status, 201);
  const refused = await request(`/api/orders/${order.body.id}/payment`, { method: 'POST', token: order.body.token });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /not been charged/);
  const [{ provider_order }] = await db.query('SELECT provider_order FROM orders WHERE id=$1', [order.body.id]);
  assert.equal(provider_order, null, 'no payment attempt was created at the provider');
});

test('a colour order is not payable online when only black-and-white printers are ready', async t => {
  const { request, connect, report, makeQuote } = await start(t);
  const device = await connect('HP LaserJet 1020', { color: false });
  await report(device, 0);
  const quote = await makeQuote({ color: 'color' });
  const refused = await request('/api/orders', { method: 'POST', token: quote.secret, body: { quoteId: quote.quoteId, method: 'online' } });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /colour/);
});

test('a shop with no registered printer prints by hand, so online payment is not blocked', async t => {
  const { db, makeQuote, request } = await start(t);
  assert.deepEqual(await shopPrinterAvailability(db, 'shop-demo', { color: 'bw' }), { available: true, manual: true, reason: null });
  const quote = await makeQuote();
  assert.equal((await request('/api/orders', { method: 'POST', token: quote.secret, body: { quoteId: quote.quoteId, method: 'online' } })).status, 201);
});

test('a paid order is never un-paid by a later printer fault', async t => {
  const { db, request, owner, connect, report, makeQuote } = await start(t);
  const device = await connect();
  await report(device, 0);
  const quote = await makeQuote();
  const placed = await request('/api/orders', { method: 'POST', token: quote.secret, body: { quoteId: quote.quoteId, method: 'cash' } });
  assert.equal((await request(`/api/owner/orders/${placed.body.id}/cash`, { method: 'POST', cookie: owner })).status, 200);
  await report(device, 0x2); // printer error after payment
  const [order] = await db.query('SELECT status, payment FROM orders WHERE id=$1', [placed.body.id]);
  assert.deepEqual([order.payment, order.status], ['paid', 'queued'], 'shown as PAID and waiting; nothing resets it');
  assert.equal((await request('/api/device/claim', { method: 'POST', token: device.token })).body, null);
  assert.equal((await db.query('SELECT payment FROM orders WHERE id=$1', [placed.body.id]))[0].payment, 'paid');
});

test('customers see how many printers are ready, nothing more', async t => {
  const { request, connect, report } = await start(t);
  const device = await connect('Secret Back Office Printer');
  await report(device, 0);
  let shop = (await request('/api/shops/campus-print')).body;
  assert.equal(shop.printersReady, 1);
  await report(device, 0x40000);
  shop = (await request('/api/shops/campus-print')).body;
  assert.equal(shop.printersReady, 0);
  assert.equal(shop.printerCount, 1);
  const text = JSON.stringify(shop);
  assert.ok(!/Secret Back Office|toner|health/i.test(text), 'no printer names, faults or health details reach customers');
});

test('admin counts online printers by a fresh heartbeat and does not call cancelled orders failed', async t => {
  const { db, request, signIn, connect, report, owner } = await start(t);
  const live = await connect('Live Printer');
  await report(live, 0x8); // jammed but connected
  // A device that checked in once, long ago, and a revoked one: neither is "online".
  const ancient = new Date(Date.now() - 86400000).toISOString();
  await db.query("INSERT INTO devices (id,shop_id,name,token,active,heartbeat) VALUES ('d-old','shop-demo','Old Printer','t-old',1,$1)", [ancient]);
  await db.query("INSERT INTO devices (id,shop_id,name,token,active,heartbeat) VALUES ('d-off','shop-demo','Revoked Printer','t-off',0,$1)", [new Date().toISOString()]);
  const [first] = (await request('/api/owner/devices', { cookie: owner })).body;
  assert.ok(first);
  const insertOrder = (status, payment = 'paid') => db.query('INSERT INTO orders (id,shop_id,document_id,token,options,pages,sides,sheets,amount,method,payment,status,created) VALUES ($1,$2,$3,$4,$5,1,1,1,200,$6,$7,$8,$9)', [randomUUID(), 'shop-demo', 'doc', randomUUID(), '{}', 'cash', payment, status, new Date().toISOString()]);
  for (const status of ['failed', 'cancelled', 'cancelled', 'expired', 'needs_review', 'printing', 'completed']) await insertOrder(status);

  const admin = await signIn('admin@smartprint.local');
  const { body: stats } = await request('/api/admin/stats', { cookie: admin });
  assert.deepEqual(stats.devices, { total: 2, online: 1, ready: 0, attention: 1, verified: 1 });
  assert.equal(stats.orders.failed, 1, 'cancelled and expired orders are not failures');
  assert.equal(stats.orders.cancelled, 2);
  assert.equal(stats.orders.expired, 1);
  assert.equal(stats.orders.review, 1);
  assert.equal(stats.orders.printing, 1);
  assert.equal(stats.transactions.net, stats.transactions.volume - stats.transactions.refunded);

  const { body: devices } = await request('/api/admin/devices', { cookie: admin });
  const byName = Object.fromEntries(devices.map(d => [d.name, d.health.state]));
  assert.equal(byName['Live Printer'], 'paper_jam');
  assert.equal(byName['Old Printer'], 'connector_offline');
  assert.equal(byName['Revoked Printer'], 'disconnected');
  assert.equal((await request('/api/admin/stats', { cookie: owner })).status, 403, 'owners cannot read platform statistics');
});

test('/api/health does not invent a commit id', async t => {
  const { request } = await start(t);
  const saved = [process.env.RENDER_GIT_COMMIT, process.env.VERCEL_GIT_COMMIT_SHA];
  delete process.env.RENDER_GIT_COMMIT; delete process.env.VERCEL_GIT_COMMIT_SHA;
  assert.equal((await request('/api/health')).body.commit, null);
  void saved;
});

// ---- wired printers: "installed in Windows" is not "plugged in" ------------------------------------------------------
test('an unplugged USB printer is not ready even though Windows calls it normal', () => {
  // Windows reports PrinterStatus 0 for the unplugged HP LaserJet 1020 on the dev PC; USB presence and "Use Printer Offline" tell the truth.
  const unplugged = classifyPrinterHealth(0, { usbPresent: false, workOffline: true });
  assert.deepEqual([unplugged.state, unplugged.blocking], ['usb_missing', true]);
  assert.match(unplugged.label, /USB cable not detected/);
  assert.equal(classifyPrinterHealth(0, { usbPresent: false }).state, 'usb_missing');
  assert.deepEqual([classifyPrinterHealth(0, { usbPresent: true }).state, classifyPrinterHealth(0, { usbPresent: true }).blocking], ['ready', false], 'attached and fine: ready');
  assert.equal(classifyPrinterHealth(0, { usbPresent: null }).state, 'ready', 'not a USB port or unknown: not blamed');
  const offline = classifyPrinterHealth(0, { workOffline: true });
  assert.deepEqual([offline.state, offline.blocking], ['offline', true]);
  assert.match(offline.flags.join(' '), /Use Printer Offline/);
  assert.equal(classifyPrinterHealth(0x8, { workOffline: true }).state, 'paper_jam', 'a more specific fault is not hidden by the offline switch');
  assert.equal(classifyPrinterHealth(0x80, { usbPresent: true }).state, 'offline');
  assert.equal(classifyPrinterHealth(null, { usbPresent: true }).state, 'unknown', 'an attached cable alone does not prove the printer is healthy');
});

test('an unplugged wired printer takes no jobs and no online payment, and the server ignores made-up flags', async t => {
  const { request, owner, connect, makeQuote } = await start(t);
  const device = await connect();
  const send = health => request('/api/device/printers/scanned', { method: 'POST', token: device.token, body: { printers: [], health } });
  const state = async () => (await request('/api/owner/devices', { cookie: owner })).body[0].health;

  await send({ code: 0, usbPresent: true, workOffline: false });
  assert.deepEqual([(await state()).state, (await state()).claimable], ['ready', true]);

  await send({ code: 0, usbPresent: false, workOffline: true }); // cable pulled
  assert.deepEqual([(await state()).state, (await state()).claimable], ['usb_missing', false]);
  assert.equal((await request('/api/device/claim', { method: 'POST', token: device.token })).body, null);
  assert.equal((await request('/api/shops/campus-print')).body.printersReady, 0);
  const quote = await makeQuote();
  const refused = await request('/api/orders', { method: 'POST', token: quote.secret, body: { quoteId: quote.quoteId, method: 'online' } });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /USB cable not detected/);

  // values that are not real booleans are not believed
  await send({ code: 0, usbPresent: 'false', workOffline: 'true' });
  assert.equal((await state()).state, 'ready');
  await send({ code: 0, usbPresent: true }); // plugged back in
  assert.equal((await state()).claimable, true);
});
