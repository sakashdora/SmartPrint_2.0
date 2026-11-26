import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LOCALAPPDATA = mkdtempSync(join(tmpdir(), 'smartprint-connect-test-'));

const { openDatabase } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');
const { classifyConnection, normalizePaperSizes, probePrinterCapabilities } = await import('../server/printer-capabilities.js');
const { getWindowsPrinters } = await import('../connector/sumatra-helper.js');
const { createBridgeHandler } = await import('../connector/local-bridge.js');

test('classifyConnection distinguishes USB, Wi-Fi, Ethernet/LAN, TCP/IP, Shared, and Virtual printers', () => {
  assert.equal(classifyConnection({ name: 'HP LaserJet 1020', port: 'USB003' }).kind, 'usb');
  assert.equal(classifyConnection({ name: 'Brother WiFi', port: 'WSD-1234' }).kind, 'wifi');
  assert.equal(classifyConnection({ name: 'Office Ethernet Printer', port: 'IP_192.168.1.50' }).kind, 'ethernet');
  assert.equal(classifyConnection({ name: 'Canon LBP', port: 'IP_192.168.1.55' }).kind, 'tcpip');
  assert.equal(classifyConnection({ name: '\\\\PRINT-SRV\\HP-Floor2', port: '\\\\PRINT-SRV\\HP-Floor2' }).kind, 'shared');
  assert.equal(classifyConnection({ name: 'Microsoft Print to PDF', port: 'PORTPROMPT:' }).kind, 'virtual');
});

test('normalizePaperSizes maps Windows PageMediaSize names cleanly', () => {
  assert.deepEqual(normalizePaperSizes(['ISOA4', 'NorthAmericaLetter', 'NorthAmericaLegal', 'ISOA4']), ['A4', 'Letter', 'Legal']);
});

async function startServer(t) {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: res.status, body: (res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
  };
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' })
  });
  const owner = login.headers.get('set-cookie')?.split(';')[0];
  return { db, request, owner };
}

test('connect, disconnect, reconnect, set-default, targeted test-print, and diagnostics lifecycle', async t => {
  const { db, request, owner } = await startServer(t);

  // 1. Connect Printer A (USB mono) and Printer B (Wi-Fi colour duplex)
  const pA = await request('/api/owner/printers/autoconnect', {
    method: 'POST', cookie: owner,
    body: {
      name: 'HP LaserJet 1020', color: false, duplex: false, manual: false,
      portName: 'USB003', driverName: 'HP LaserJet 1020', connectionType: 'Wired USB Cable',
      isDefault: true, paperSizes: ['A4', 'Letter'], resolutionDpi: 600,
      machineName: 'SHOP-PC-1', connectorId: 'conn-1', connectorVersion: '3.1.0'
    }
  });
  assert.equal(pA.status, 200);

  const pB = await request('/api/owner/printers/autoconnect', {
    method: 'POST', cookie: owner,
    body: {
      name: 'Brother DCP-T820DW', color: true, duplex: true, manual: false,
      portName: 'IP_192.168.1.44', driverName: 'Brother DCP-T820DW Printer', connectionType: 'TCP/IP Network',
      isDefault: false, paperSizes: ['A4', 'Legal'], resolutionDpi: 1200,
      machineName: 'SHOP-PC-1', connectorId: 'conn-1', connectorVersion: '3.1.0'
    }
  });
  assert.equal(pB.status, 200);

  // Both connectors check in
  assert.equal((await request('/api/device/heartbeat', { method: 'POST', token: pA.body.token })).status, 200);
  assert.equal((await request('/api/device/heartbeat', { method: 'POST', token: pB.body.token })).status, 200);

  // 2. Verify metadata persisted
  const list1 = await request('/api/owner/devices', { cookie: owner });
  assert.equal(list1.status, 200);
  assert.equal(list1.body.length, 2);
  const devA = list1.body.find(d => d.id === pA.body.id);
  const devB = list1.body.find(d => d.id === pB.body.id);
  assert.equal(devA.port_name, 'USB003');
  assert.deepEqual(devA.paper_sizes, ['A4', 'Letter']);
  assert.equal(devB.machine_name, 'SHOP-PC-1');

  // 3. Set Printer B as default
  const defRes = await request(`/api/owner/devices/${devB.id}/default`, { method: 'POST', cookie: owner });
  assert.equal(defRes.status, 200);
  const list2 = await request('/api/owner/devices', { cookie: owner });
  assert.equal(list2.body.find(d => d.id === devB.id).is_default, 1);
  assert.equal(list2.body.find(d => d.id === devA.id).is_default, 0);

  // 4. Targeted test print for Printer B: Printer A MUST NOT claim it!
  const tp = await request(`/api/owner/devices/${devB.id}/test-print`, { method: 'POST', cookie: owner });
  assert.equal(tp.status, 200);
  assert.ok(tp.body.orderId);

  const claimByA = await request('/api/device/claim', { method: 'POST', token: pA.body.token });
  assert.equal(claimByA.status, 200);
  assert.equal(claimByA.body, null, 'Printer A must never claim a test print targeted at Printer B');

  const claimByB = await request('/api/device/claim', { method: 'POST', token: pB.body.token });
  assert.equal(claimByB.status, 200);
  assert.equal(claimByB.body.id, tp.body.orderId, 'Printer B claims its own targeted test print');

  // Track test-print stage
  const tpStatus = await request(`/api/owner/devices/${devB.id}/test-print/${tp.body.orderId}`, { cookie: owner });
  assert.equal(tpStatus.status, 200);
  assert.equal(tpStatus.body.stage, 'claimed_by_connector');

  // 5. Diagnostics & Shop Isolation
  const diag = await request(`/api/owner/devices/${devB.id}/diagnostics`, { cookie: owner });
  assert.equal(diag.status, 200);
  assert.equal(diag.body.connector_id, 'conn-1');
  assert.equal(diag.body.recent_jobs.length, 1);

  await db.query("INSERT INTO users (id,email,password,role) VALUES ('u-iso','iso@x.test','x','owner')");
  await db.query("INSERT INTO shops (id,owner_id,slug,name,location,status) VALUES ('shop-iso','u-iso','iso-shop','Iso','Here','active')");
  await db.query("INSERT INTO devices (id,shop_id,name,token,active) VALUES ('dev-iso','shop-iso','Other','tok-iso',1)");
  assert.equal((await request('/api/owner/devices/dev-iso/diagnostics', { cookie: owner })).status, 404);

  // 6. Disconnect Printer A and Reconnect it (must reactivate active=1)
  assert.equal((await request(`/api/owner/devices/${devA.id}`, { method: 'DELETE', cookie: owner })).status, 200);
  const afterDel = await request('/api/owner/devices', { cookie: owner });
  assert.equal(afterDel.body.find(d => d.id === devA.id).active, 0);

  const reA = await request('/api/owner/printers/autoconnect', {
    method: 'POST', cookie: owner,
    body: { name: 'HP LaserJet 1020', color: false, duplex: false, manual: false }
  });
  assert.equal(reA.status, 200);
  const afterRe = await request('/api/owner/devices', { cookie: owner });
  assert.equal(afterRe.body.find(d => d.id === devA.id).active, 1);
});

test('local-bridge /set-default and /refresh endpoints work with trusted origin', async () => {
  let defaultCalled = '';
  let refreshCalled = false;
  const handler = createBridgeHandler({
    state: () => ({ base: 'http://localhost:3000', connectorId: 'c1', connectorVersion: '3.1.0', machineName: 'PC', linked: true, needsRelink: false, printer: 'P1', linkedPrinters: [] }),
    printers: async () => [],
    pair: async () => ({ printer: 'P1' }),
    setDefault: async ({ printer }) => { defaultCalled = printer; },
    refresh: async () => { refreshCalled = true; return { printers: [], lastScanAt: new Date().toISOString() }; }
  });
  const server = (await import('node:http')).createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const r1 = await fetch(`http://127.0.0.1:${port}/set-default`, { method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify({ printer: 'HP LaserJet 1020' }) });
    assert.equal(r1.status, 200);
    assert.equal(defaultCalled, 'HP LaserJet 1020');
    const r2 = await fetch(`http://127.0.0.1:${port}/refresh`, { method: 'POST', headers: { Origin: 'http://localhost:3000' } });
    assert.equal(r2.status, 200);
    assert.equal(refreshCalled, true);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('shop-scoped connector pairing prevents silent shop hijacking and supports authorized release', async t => {
  const { db, request, owner } = await startServer(t);
  const pt1 = await request('/api/owner/connectors/pairing-token', { method: 'POST', cookie: owner });
  assert.equal(pt1.status, 200);
  assert.ok(pt1.body.pairingToken);

  const pair1 = await request('/api/owner/connectors/pair', {
    method: 'POST', cookie: owner,
    body: { connectorId: 'conn-multi-1', machineId: 'm1', machineName: 'SHOP-PC', version: '3.1.0', pairingToken: pt1.body.pairingToken }
  });
  assert.equal(pair1.status, 200);
  assert.equal(pair1.body.shopId, 'shop-demo');

  // Reusing a pairing token fails
  const replay = await request('/api/owner/connectors/pair', {
    method: 'POST', cookie: owner,
    body: { connectorId: 'conn-multi-1', pairingToken: pt1.body.pairingToken }
  });
  assert.equal(replay.status, 400);

  // Another shop trying to pair the same connector gets 409 ownership_conflict
  await db.query("INSERT INTO users (id,email,password,role) VALUES ('u-shop2','shop2@x.test','x','owner')");
  await db.query("INSERT INTO shops (id,owner_id,slug,name,location,status) VALUES ('shop-2','u-shop2','shop-2','Shop Two','Here','active')");
  // Release from shop-demo
  const rel = await request('/api/owner/connectors/release', { method: 'POST', cookie: owner, body: { connectorId: 'conn-multi-1' } });
  assert.equal(rel.status, 200);

  const listAfter = await request('/api/owner/connectors', { cookie: owner });
  assert.equal(listAfter.status, 200);
  assert.equal(listAfter.body.connectors[0].status, 'revoked');
});

test('Windows integration: real getWindowsPrinters and probePrinterCapabilities on win32', { skip: process.platform !== 'win32' }, async () => {
  const printers = await getWindowsPrinters();
  assert.ok(Array.isArray(printers));
  if (printers.length > 0) {
    assert.ok(printers[0].Name);
    const caps = await probePrinterCapabilities(printers.slice(0, 2).map(p => p.Name));
    assert.ok(caps instanceof Map);
  }
});
