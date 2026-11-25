import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Online payment is not used here; the keys only keep the shop endpoints identical to production.
process.env.RAZORPAY_KEY_ID = 'rzp_test_abcdefgh12345678';
process.env.RAZORPAY_KEY_SECRET = 'test_secret_value_for_unit_tests';

const { openDatabase } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');
const { describeAbilities } = await import('../server/printer-health.js');
const { printerStats, filterPrinters, adminPrintersView } = await import('../public/admin-printers.js');

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
  const connect = async (name, extra = {}) => {
    const added = await request('/api/owner/printers/autoconnect', { method: 'POST', cookie: owner, body: { name, ...extra } });
    await request('/api/device/heartbeat', { method: 'POST', token: added.body.token });
    return added.body;
  };
  // What the connector sends every minute for one printer: Windows status plus the driver's answer.
  const scan = (device, { code = 0, capabilities } = {}) => request('/api/device/printers/scanned', { method: 'POST', token: device.token, body: { printers: [], health: { code }, ...(capabilities ? { capabilities } : {}) } });
  const mine = async () => (await request('/api/owner/devices', { cookie: owner })).body;
  return { db, request, owner, connect, scan, mine, signIn };
}

test('abilities say what is known and where it came from', () => {
  const none = describeAbilities({ color: 0, duplex: 0, cap_source: 'driver' });
  assert.deepEqual([none.source, none.colour, none.two_sided, none.detected], ['unverified', false, false, null], 'nothing detected and nothing chosen: off, and labelled unverified');
  const detected = describeAbilities({ color: 1, duplex: 1, cap_source: 'driver', det_color: 1, det_duplex: 1, det_at: '2026-11-25T10:00:00.000Z' });
  assert.deepEqual([detected.source, detected.summary, detected.has_mismatch], ['driver', 'Colour + black & white · Two-sided + one-sided', false]);
  const wrong = describeAbilities({ color: 0, duplex: 1, cap_source: 'manual', det_color: 1, det_duplex: 1, det_at: '2026-11-25T10:00:00.000Z' });
  assert.deepEqual([wrong.source, wrong.mismatch, wrong.has_mismatch], ['owner', { colour: true, two_sided: false }, true], 'a colour printer set to black & white is flagged');
  const agree = describeAbilities({ color: 1, duplex: 0, cap_source: 'manual', det_color: 1, det_duplex: 0, det_at: '2026-11-25T10:00:00.000Z' });
  assert.equal(agree.has_mismatch, false);
  assert.equal(describeAbilities({ color: 0, duplex: 0, cap_source: 'manual' }).has_mismatch, false, 'no driver answer, nothing to compare with');
});

test('a colour printer wrongly set to black & white is flagged to owner and admin, test pages follow the setting, and one click fixes it', async t => {
  const { request, owner, db, connect, scan, mine, signIn } = await start(t);
  const device = await connect('Brother DCP-T820DW Printer', { color: false, duplex: false, manual: true }); // the owner chose B&W, one-sided
  await scan(device, { capabilities: { color: true, duplex: true } }); // the driver says colour + two-sided

  let [printer] = await mine();
  assert.deepEqual([printer.abilities.source, printer.abilities.colour, printer.abilities.two_sided, printer.abilities.has_mismatch], ['owner', false, false, true]);
  assert.deepEqual([printer.abilities.detected.colour, printer.abilities.detected.two_sided], [true, true], 'what the driver said is remembered');

  const admin = await signIn('admin@smartprint.local');
  const [seen] = (await request('/api/admin/devices', { cookie: admin })).body;
  assert.deepEqual([seen.shop_name, seen.abilities.has_mismatch, seen.manufacturer], ['Campus Print Studio', true, 'Brother'], 'the admin sees the same mismatch, with the shop');
  assert.equal((await request('/api/admin/devices', { cookie: owner })).status, 403, 'owners cannot read the platform printer list');
  let shop = (await request('/api/shops/campus-print')).body;
  assert.deepEqual([shop.colorAvailable, shop.duplexAvailable], [false, false], 'customers are only offered what is set');

  // the test page is sent the way the printer is SET UP
  const bw = await request(`/api/owner/devices/${printer.id}/test-print`, { method: 'POST', cookie: owner });
  assert.equal(JSON.parse((await db.query('SELECT options FROM orders WHERE id=$1', [bw.body.orderId]))[0].options).color, 'bw');

  // one click: use what the driver detected, applied at once (not at the next scan)
  const fixed = await request(`/api/owner/devices/${printer.id}`, { method: 'PATCH', cookie: owner, body: { useDetected: true } });
  assert.deepEqual([fixed.body.color, fixed.body.duplex, fixed.body.applied], [true, true, true]);
  [printer] = await mine();
  assert.deepEqual([printer.abilities.source, printer.abilities.colour, printer.abilities.two_sided, printer.abilities.has_mismatch], ['driver', true, true, false]);
  shop = (await request('/api/shops/campus-print')).body;
  assert.deepEqual([shop.colorAvailable, shop.duplexAvailable], [true, true], 'customers now see colour and two-sided');
  await db.query('DELETE FROM orders');
  const colour = await request(`/api/owner/devices/${printer.id}/test-print`, { method: 'POST', cookie: owner });
  assert.equal(JSON.parse((await db.query('SELECT options FROM orders WHERE id=$1', [colour.body.orderId]))[0].options).color, 'color', 'the test page is now in colour');
});

test('an automatically detected printer follows the driver, live, and an unverified one stays off', async t => {
  const { connect, scan, mine, request } = await start(t);
  const device = await connect('EPSON L3250 Series'); // connected without an owner override
  let [{ abilities }] = await mine();
  assert.deepEqual([abilities.source, abilities.colour, abilities.two_sided], ['unverified', false, false], 'before the first driver check nothing is claimed');
  await scan(device, { capabilities: { color: true, duplex: false } });
  [{ abilities }] = await mine();
  assert.deepEqual([abilities.source, abilities.colour, abilities.two_sided, Boolean(abilities.detected.checked_at)], ['driver', true, false, true]);
  await scan(device, { capabilities: { color: true, duplex: true } }); // e.g. a duplex unit was added or the driver was updated
  [{ abilities }] = await mine();
  assert.deepEqual([abilities.colour, abilities.two_sided], [true, true], 'the next scan updates it');
  assert.equal((await request('/api/shops/campus-print')).body.duplexAvailable, true);
});

test('customers learn which abilities are ready right now, not only which exist', async t => {
  const { request, connect, scan } = await start(t);
  const device = await connect('EPSON L3250 Series');
  await scan(device, { capabilities: { color: true, duplex: true } });
  let shop = (await request('/api/shops/campus-print')).body;
  assert.deepEqual([shop.colorAvailable, shop.colorReady, shop.duplexReady, shop.printersReady], [true, true, true, 1]);
  await scan(device, { code: 0x10, capabilities: { color: true, duplex: true } }); // out of paper
  shop = (await request('/api/shops/campus-print')).body;
  assert.deepEqual([shop.colorAvailable, shop.colorReady, shop.duplexAvailable, shop.duplexReady, shop.printersReady], [true, false, true, false, 0], 'the abilities exist but are not ready');
});

test('admin printers view: counts, states, filters and safe output', () => {
  const now = new Date().toISOString();
  const base = { active: 1, shop_name: 'Campus Print', shop_slug: 'campus', heartbeat: now };
  const health = (state, extra = {}) => ({ state, label: state, claimable: false, connector_online: true, detail: null, checked_at: now, ...extra });
  const ab = (colour, two_sided, extra = {}) => ({ colour, two_sided, source: 'driver', has_mismatch: false, detected: { colour, two_sided }, ...extra });
  const devices = [
    { ...base, name: 'HP LaserJet 1020', manufacturer: 'HP', abilities: ab(false, false), health: health('ready', { claimable: true }) },
    { ...base, name: 'Brother <img src=x onerror=alert(1)>', manufacturer: 'Brother', abilities: ab(false, true, { source: 'owner', has_mismatch: true, detected: { colour: true, two_sided: true } }), health: health('paper_jam') },
    { ...base, name: 'EPSON L3250', manufacturer: 'Epson', abilities: ab(true, true, { source: 'unverified', detected: null }), health: health('connector_offline', { connector_online: false }) },
    { ...base, name: 'Canon G3010', manufacturer: 'Canon', abilities: ab(true, false), health: health('paused_by_owner') },
    { ...base, name: 'Revoked printer', active: 0, abilities: ab(true, true), health: health('disconnected', { connector_online: false }) }
  ];
  assert.deepEqual(printerStats(devices), { total: 4, ready: 1, attention: 1, offline: 1, colour: 2, twoSided: 2, mismatch: 1, unverified: 1 });
  assert.equal(filterPrinters(devices).length, 4, 'disconnected printers are not listed');
  assert.deepEqual(filterPrinters(devices, { state: 'attention' }).map(d => d.manufacturer), ['Brother']);
  assert.deepEqual(filterPrinters(devices, { state: 'mismatch' }).map(d => d.manufacturer), ['Brother']);
  assert.deepEqual(filterPrinters(devices, { state: 'paused' }).map(d => d.manufacturer), ['Canon']);
  assert.deepEqual(filterPrinters(devices, { q: 'epson' }).map(d => d.name), ['EPSON L3250']);
  const html = adminPrintersView({ devices, escape: s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`), time: s => s, filter: {} });
  assert.ok(!html.includes('<img'), 'printer names are escaped');
  assert.ok(html.includes('driver says colour, two-sided'), 'the mismatch is explained');
  assert.ok(html.includes('Not verified') && html.includes('Set by owner'));
  void randomUUID;
});
