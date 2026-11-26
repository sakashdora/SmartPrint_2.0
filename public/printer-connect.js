import { watchUpdates } from './live.js';
import { icon } from './ui.js';

const CONNECTOR = 'http://127.0.0.1:17631';
const BRANDS = ['HP', 'Brother', 'Epson', 'Canon'];
const SUPPORT = {
  HP: 'https://support.hp.com/in-en/drivers/printers',
  Brother: 'https://support.brother.com/',
  Epson: 'https://epson.com/support',
  Canon: 'https://in.canon/en/support'
};

let uiState = {
  filterTab: 'all',
  search: '',
  autoRefresh: true,
  freshScan: false,
  scanning: false,
  scanStage: '',
  scanError: '',
  showNetworkModal: false,
  configPrinter: null,
  diagDeviceId: null,
  testPrints: new Map()
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const isOnline = d => Boolean(d?.active && d.heartbeat && Date.now() - Date.parse(d.heartbeat) < 180000);
const fmtTime = iso => {
  if (!iso) return 'Never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'Never';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 10) return 'Just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

async function connectorCall(path, { method = 'GET', body } = {}) {
  const response = await fetch(CONNECTOR + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(method === 'GET' ? 25000 : 40000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Connector error (${response.status}).`), { status: response.status, data });
  return data;
}

function resolvePrinterStatus(scanned, device, hasConflict) {
  if (device && !device.active) return { code: 'disconnected', label: 'Disconnected', tone: 'neutral', blocking: true };
  if (device && device.is_paused) return { code: 'paused', label: 'Paused', tone: 'warn', blocking: true };
  if (device) {
    const h = device.health || {};
    if (!h.connector_online) {
      if (!device.heartbeat) return { code: 'awaiting_heartbeat', label: 'Awaiting heartbeat', tone: 'info', blocking: true };
      if (scanned && scanned.windowsBlocking) return { code: scanned.windowsState || 'offline', label: scanned.windowsStateLabel || 'Windows Offline', tone: 'danger', blocking: true };
      return { code: 'connector_offline', label: 'Connector offline', tone: 'warn', blocking: true };
    }
    if (h.blocking) return { code: h.state || 'error', label: h.label || 'Needs attention', tone: 'danger', blocking: true };
    if (h.state === 'printing' || h.state === 'busy') return { code: h.state, label: h.label, tone: 'info', blocking: false };
    if (h.verified && h.state === 'ready') return { code: 'ready', label: 'Ready', tone: 'ok', blocking: false };
    if (scanned) {
      if (scanned.windowsBlocking) return { code: scanned.windowsState || 'offline', label: scanned.windowsStateLabel || 'Windows Offline', tone: 'danger', blocking: true };
      if (scanned.windowsState === 'ready') return { code: 'ready', label: 'Ready', tone: 'ok', blocking: false };
    }
    return { code: 'unknown', label: 'Connected · status pending', tone: 'neutral', blocking: false };
  }
  if (scanned) {
    if (hasConflict) return { code: 'conflict', label: 'Detected (other shop)', tone: 'neutral', blocking: false };
    if (scanned.windowsState === 'usb_missing') return { code: 'usb_missing', label: 'USB unplugged', tone: 'warn', blocking: true };
    if (scanned.windowsBlocking) return { code: scanned.windowsState || 'offline', label: 'Windows offline', tone: 'warn', blocking: true };
    if (scanned.windowsState === 'ready') return { code: 'detected_ready', label: 'Detected · Ready', tone: 'info', blocking: false };
    return { code: 'detected', label: 'Installed in Windows', tone: 'neutral', blocking: false };
  }
  return { code: 'unknown', label: 'Unknown', tone: 'neutral', blocking: false };
}

function buildUnifiedPrinters(pc, devices, reported) {
  const byKey = new Map();
  const keyOf = n => String(n || '').trim().toLowerCase();

  for (const s of (pc?.printers || [])) {
    byKey.set(keyOf(s.name), { name: s.name, scanned: s, device: null, link: null });
  }
  for (const r of (reported || [])) {
    const k = keyOf(r.name);
    if (!byKey.has(k)) byKey.set(k, { name: r.name, scanned: r, device: null, link: null });
  }
  for (const d of (devices || [])) {
    const k = keyOf(d.name);
    const existing = byKey.get(k);
    if (existing) existing.device = d;
    else if (d.active) byKey.set(k, { name: d.name, scanned: null, device: d, link: null });
  }
  for (const item of byKey.values()) {
    item.link = (pc?.linkedPrinters || []).find(l => sameName(l.name, item.name)) || null;
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const aConn = a.device?.active ? 1 : 0, bConn = b.device?.active ? 1 : 0;
    if (aConn !== bConn) return bConn - aConn;
    const aDef = (a.device?.is_default || a.scanned?.isDefault) ? 1 : 0;
    const bDef = (b.device?.is_default || b.scanned?.isDefault) ? 1 : 0;
    if (aDef !== bDef) return bDef - aDef;
    return a.name.localeCompare(b.name);
  });
}

function evaluateConnectorPanel(pc, connectorsData, connectedDevices) {
  const shop = connectorsData?.shop || null;
  const shopConnectors = connectorsData?.connectors || [];
  const differentServer = Boolean(pc && pc.linked && !pc.linkedHere);
  const differentShop = Boolean(pc && pc.linked && pc.shopId && shop?.id && pc.shopId !== shop.id);
  const hasConflict = differentServer || differentShop;

  const matchingDbConn = pc?.connectorId ? shopConnectors.find(c => c.id === pc.connectorId) : null;
  const latestDeviceBeat = connectedDevices.map(i => i.device?.heartbeat).filter(Boolean).sort().pop();
  const latestBeat = matchingDbConn?.last_heartbeat || latestDeviceBeat || (pc && !hasConflict ? pc.lastHeartbeatAt : null);
  const beatAge = latestBeat ? Date.now() - Date.parse(latestBeat) : Infinity;
  const heartbeatFresh = Number.isFinite(beatAge) && beatAge <= 180000;

  let statusLabel = 'Not detected on this PC';
  let statusTone = 'neutral';
  if (pc) {
    if (hasConflict) {
      statusLabel = 'Registered to another shop';
      statusTone = 'warn';
    } else if (pc.needsRelink) {
      statusLabel = 'Authentication expired';
      statusTone = 'danger';
    } else if (pc.linked && heartbeatFresh) {
      statusLabel = 'Connected & healthy';
      statusTone = 'ok';
    } else if (pc.linked && latestBeat) {
      statusLabel = 'Heartbeat stale';
      statusTone = 'warn';
    } else if (pc.linked) {
      statusLabel = 'Paired · awaiting heartbeat';
      statusTone = 'info';
    } else {
      statusLabel = 'Ready to pair';
      statusTone = 'info';
    }
  }

  return { shop, hasConflict, differentServer, differentShop, statusLabel, statusTone, latestBeat, heartbeatFresh };
}

function renderOverview(items, pc, connEval, escape) {
  const totalDetected = items.filter(i => i.scanned).length;
  const connected = items.filter(i => i.device?.active);
  const readyCount = connected.filter(i => resolvePrinterStatus(i.scanned, i.device, connEval.hasConflict).code === 'ready').length;
  const offlineCount = items.filter(i => ['offline', 'usb_missing', 'connector_offline'].includes(resolvePrinterStatus(i.scanned, i.device, connEval.hasConflict).code)).length;
  const attentionCount = connected.filter(i => {
    const st = resolvePrinterStatus(i.scanned, i.device, connEval.hasConflict);
    return (st.blocking && st.code !== 'disconnected' && st.code !== 'awaiting_heartbeat') || i.device?.abilities?.has_mismatch;
  }).length;

  return `
    <section class="pc-overview-grid" aria-label="Printer overview">
      <div class="pc-kpi"><span class="pc-kpi-label">Detected in Windows</span><strong class="pc-kpi-val">${totalDetected}</strong></div>
      <div class="pc-kpi"><span class="pc-kpi-label">Connected</span><strong class="pc-kpi-val">${connected.length}</strong></div>
      <div class="pc-kpi pc-kpi-ok"><span class="pc-kpi-label">Ready</span><strong class="pc-kpi-val">${readyCount}</strong></div>
      <div class="pc-kpi ${offlineCount ? 'pc-kpi-warn' : ''}"><span class="pc-kpi-label">Offline</span><strong class="pc-kpi-val">${offlineCount}</strong></div>
      <div class="pc-kpi ${attentionCount ? 'pc-kpi-danger' : ''}"><span class="pc-kpi-label">Needs attention</span><strong class="pc-kpi-val">${attentionCount}</strong></div>
      <div class="pc-kpi pc-kpi-connector">
        <span class="pc-kpi-label">Windows Connector ${connEval.shop ? `· ${escape(connEval.shop.name)}` : ''}</span>
        <div class="pc-conn-status">
          <span class="pc-dot pc-dot-${connEval.statusTone}"></span>
          <strong>${escape(connEval.statusLabel)}</strong>
        </div>
        <small class="muted pc-truncate" title="${escape(pc?.machineName || '')}">
          ${pc ? `${escape(pc.machineName || 'Windows PC')} · v${escape(pc.connectorVersion || '3.1.0')}` : 'Run start-connector.bat'}
          · ${connEval.latestBeat ? `Heartbeat ${fmtTime(connEval.latestBeat)}` : 'No authenticated heartbeat yet'}
        </small>
      </div>
    </section>
  `;
}

function renderConnectorBanner(pc, connEval, escape) {
  if (!pc) {
    return `
      <section class="panel pc-setup-guide">
        <div class="pc-setup-head">
          <div>
            <span class="pc-eyebrow">WINDOWS CONNECTOR REQUIRED</span>
            <h2>Connect your shop's Windows PC</h2>
            <p class="muted small">Run the SmartPrint Connector on the Windows PC connected to your printers (USB, Wi-Fi, LAN, or shared).</p>
          </div>
          <button type="button" class="primary small" id="pc-check-connector">${icon('refresh')} Retry Connection</button>
        </div>
        <div class="pc-setup-steps">
          <div class="pc-step"><span class="pc-step-num">1</span><div><strong>Install Printer in Windows</strong><p class="small muted">Connect USB or network printer and confirm a Windows test page prints.</p></div></div>
          <div class="pc-step"><span class="pc-step-num">2</span><div><strong>Start Connector</strong><p class="small muted">Run <code>start-connector.bat</code> or auto-start via <code>scripts\\install-connector-task.bat</code>.</p></div></div>
          <div class="pc-step"><span class="pc-step-num">3</span><div><strong>1-Click Connect</strong><p class="small muted">Printers appear automatically below within 5 seconds.</p></div></div>
        </div>
        <div class="pc-driver-links">
          <span class="small muted">Official drivers:</span>
          ${BRANDS.map(b => `<a class="pc-driver-chip" href="${SUPPORT[b]}" target="_blank" rel="noopener noreferrer">${b}</a>`).join('')}
        </div>
      </section>
    `;
  }
  if (connEval.hasConflict) {
    const ownerLabel = pc.shopName ? `${pc.shopName} (${pc.server})` : pc.server;
    return `
      <div class="pc-banner pc-banner-warn">
        ${icon('alert')}
        <div style="flex:1;min-width:0">
          <strong>Connector ownership conflict</strong>
          <p class="small muted">This PC's connector is currently registered to <strong>${escape(ownerLabel)}</strong>. SmartPrint does not silently move connectors between shops. Release it from the previous shop before connecting printers to <strong>${escape(connEval.shop?.name || 'this shop')}</strong>.</p>
        </div>
        <button type="button" class="primary small" id="pc-release-transfer">Release &amp; Pair to This Shop</button>
      </div>
    `;
  }
  if (pc.needsRelink) {
    return `<div class="pc-banner pc-banner-warn">${icon('alert')}<div><strong>Connector authentication expired</strong><p class="small muted">This PC's device keys were revoked or reset. Click <strong>Reconnect</strong> on your printers to pair again.</p></div></div>`;
  }
  return '';
}

function renderDiscoveryBar(pc, items, escape) {
  const usbCount = items.filter(i => i.scanned ? i.scanned.isWired : /usb/i.test(i.device?.connection_type || '')).length;
  const netCount = items.filter(i => i.scanned ? i.scanned.isWifi : /wi-?fi|network|tcp|ethernet|shared/i.test(i.device?.connection_type || '')).length;
  const lastScan = pc?.lastScanAt ? fmtTime(pc.lastScanAt) : (pc ? 'Just now' : '—');

  return `
    <section class="pc-discovery-bar panel">
      <div class="pc-discovery-top">
        <div class="pc-tabs" role="tablist" aria-label="Filter printers">
          <button type="button" class="pc-tab ${uiState.filterTab === 'all' ? 'is-active' : ''}" data-pc-tab="all">All <span class="pc-count">${items.length}</span></button>
          <button type="button" class="pc-tab ${uiState.filterTab === 'usb' ? 'is-active' : ''}" data-pc-tab="usb">USB <span class="pc-count">${usbCount}</span></button>
          <button type="button" class="pc-tab ${uiState.filterTab === 'network' ? 'is-active' : ''}" data-pc-tab="network">Wi-Fi / LAN / Shared <span class="pc-count">${netCount}</span></button>
          <button type="button" class="pc-tab ${uiState.filterTab === 'connected' ? 'is-active' : ''}" data-pc-tab="connected">Connected <span class="pc-count">${items.filter(i => i.device?.active).length}</span></button>
        </div>
        <div class="pc-discovery-controls">
          <div class="pc-search-wrap">
            ${icon('search')}
            <input type="search" id="pc-search" placeholder="Search printer, port, driver…" value="${escape(uiState.search)}" autocomplete="off">
          </div>
          <label class="pc-autorefresh-toggle" title="Automatically refresh status every 5 seconds">
            <input type="checkbox" id="pc-autorefresh" ${uiState.autoRefresh ? 'checked' : ''}>
            <span>Auto-refresh</span>
          </label>
          <button type="button" class="secondary small" id="pc-add-network">${icon('printer')} Add Network Printer</button>
          <button type="button" class="primary small" id="pc-scan-btn" ${uiState.scanning ? 'disabled' : ''}>${icon('refresh')} ${uiState.scanning ? 'Scanning…' : 'Scan Printers'}</button>
        </div>
      </div>
      <div class="pc-discovery-meta">
        <span>Last scan: <strong>${escape(lastScan)}</strong></span>
        ${uiState.scanStage ? `<span class="pc-scanning-pill">${escape(uiState.scanStage)}</span>` : ''}
        ${pc?.lastScanError || uiState.scanError ? `<span class="pc-error-inline">${icon('alert')} ${escape(uiState.scanError || pc.lastScanError)} <button type="button" class="link-btn" id="pc-retry-scan">Retry</button></span>` : ''}
      </div>
    </section>
  `;
}

function renderPrinterCard(item, pc, connEval, escape) {
  const { name, scanned, device, link } = item;
  const st = resolvePrinterStatus(scanned, device, connEval.hasConflict);
  const connected = Boolean(device?.active);
  const isDefault = Boolean(device?.is_default || scanned?.isDefault);
  const driver = scanned?.driverName || device?.driver_name || 'Windows driver';
  const port = scanned?.portName || device?.port_name || 'Unknown';
  const maker = scanned?.manufacturer || device?.manufacturer || 'Other';
  const connLabel = scanned?.connectionType || device?.connection_type || 'Local';
  const colorCap = device ? Number(device.color) === 1 : Boolean(scanned?.color);
  const duplexCap = device ? Number(device.duplex) === 1 : Boolean(scanned?.duplex);
  const papers = (scanned?.paperSizes?.length ? scanned.paperSizes : device?.paper_sizes) || [];
  const tp = device ? uiState.testPrints.get(device.id) : null;

  return `
    <article class="pc-card pc-card-${st.tone}" data-printer="${escape(name)}">
      <div class="pc-card-head">
        <div class="pc-card-icon">${icon('printer')}</div>
        <div class="pc-card-title-wrap">
          <h3 class="pc-card-title" title="${escape(name)}">${escape(name)}</h3>
          <div class="pc-card-badges">
            ${isDefault ? '<span class="pc-badge pc-badge-default">Default</span>' : ''}
            <span class="pc-badge pc-badge-${connected ? 'connected' : 'neutral'}">${connected ? 'Connected' : 'Not connected'}</span>
          </div>
        </div>
        <span class="pc-status-pill pc-status-${st.tone}">${escape(st.label)}</span>
      </div>

      <div class="pc-card-specs">
        <div class="pc-spec"><span>Manufacturer</span><strong title="${escape(maker)}">${escape(maker)}</strong></div>
        <div class="pc-spec"><span>Connection</span><strong class="pc-conn-pill" title="${escape(connLabel)}">${escape(connLabel)}</strong></div>
        <div class="pc-spec"><span>Port</span><strong title="${escape(port)}">${escape(port)}</strong></div>
        <div class="pc-spec"><span>Driver</span><strong title="${escape(driver)}">${escape(driver)}</strong></div>
      </div>

      <div class="pc-cap-row">
        <span class="pc-cap-chip">${colorCap ? 'Colour + B&amp;W' : 'Monochrome'}</span>
        <span class="pc-cap-chip">${duplexCap ? 'Duplex' : 'One-sided'}</span>
        ${papers.length ? `<span class="pc-cap-chip" title="${escape(papers.join(', '))}">${escape(papers.slice(0, 2).join(', '))}${papers.length > 2 ? ` +${papers.length - 2}` : ''}</span>` : ''}
      </div>

      ${device?.abilities?.has_mismatch ? `<p class="pc-card-alert pc-alert-warn">${icon('alert')} Settings differ from driver. <button type="button" class="link-btn" data-use-detected="${device.id}">Sync</button></p>` : ''}
      ${tp ? `<div class="pc-test-status pc-test-${tp.stage === 'failed' ? 'err' : tp.stage === 'spooler_accepted' || tp.stage === 'completed' ? 'ok' : 'info'}">
        <span>${escape(tp.label)}</span>${tp.detail ? `<small>${escape(tp.detail)}</small>` : ''}
      </div>` : ''}

      <div class="pc-card-actions">
        ${!connected ? `
          <button type="button" class="primary small" data-pc-connect="${escape(name)}" ${!pc || connEval.hasConflict ? `disabled title="${connEval.hasConflict ? 'Release connector from other shop first' : 'Start Windows Connector first'}"` : ''}>${link?.authFailed ? 'Reconnect' : 'Connect'}</button>
          <button type="button" class="secondary small" data-pc-config="${escape(name)}">${icon('sliders')} Details</button>
        ` : `
          <button type="button" class="secondary small" data-pc-test="${device.id}" ${isOnline(device) && !st.blocking ? '' : 'disabled title="Printer must be online and ready"'}>${icon('printer')} Test Print</button>
          <button type="button" class="secondary small" data-pc-config="${escape(name)}">${icon('sliders')} Details</button>
          <button type="button" class="secondary small" data-pc-diag="${device.id}" title="Diagnostics">${icon('info')}</button>
          <button type="button" class="danger small" data-pc-disconnect="${device.id}" data-printer-name="${escape(name)}">Disconnect</button>
        `}
      </div>
    </article>
  `;
}

function renderConfigModal(pc, devices, reported, escape) {
  if (!uiState.configPrinter) return '';
  const items = buildUnifiedPrinters(pc, devices, reported);
  const item = items.find(i => sameName(i.name, uiState.configPrinter));
  if (!item) return '';
  const { name, scanned, device } = item;
  const driverColor = scanned?.verified ? Boolean(scanned.color) : (device?.abilities?.detected ? Boolean(device.abilities.detected.colour) : null);
  const driverDuplex = scanned?.verified ? Boolean(scanned.duplex) : (device?.abilities?.detected ? Boolean(device.abilities.detected.two_sided) : null);
  const currentColor = device ? Number(device.color) === 1 : Boolean(scanned?.color);
  const currentDuplex = device ? Number(device.duplex) === 1 : Boolean(scanned?.duplex);
  const papers = (scanned?.paperSizes?.length ? scanned.paperSizes : device?.paper_sizes) || [];
  const dpi = scanned?.resolutionDpi || device?.resolution_dpi;
  const isDefault = Boolean(device?.is_default || scanned?.isDefault);

  return `
    <div class="pc-modal-backdrop" id="pc-config-backdrop">
      <div class="pc-modal" role="dialog" aria-modal="true" aria-labelledby="pc-config-title">
        <div class="pc-modal-head">
          <div style="min-width:0">
            <span class="pc-eyebrow">PRINTER DETAILS &amp; CONFIGURATION</span>
            <h2 id="pc-config-title" style="word-break:break-word">${escape(name)}</h2>
          </div>
          <button type="button" class="icon-button" id="pc-close-config" aria-label="Close">${icon('cross')}</button>
        </div>
        <div class="pc-modal-body">
          <div class="pc-detail-grid">
            <div><span>Windows Queue</span><strong>${escape(name)}</strong></div>
            <div><span>Driver</span><strong>${escape(scanned?.driverName || device?.driver_name || 'Unknown')}</strong></div>
            <div><span>Connection Type</span><strong>${escape(scanned?.connectionType || device?.connection_type || 'Unknown')}</strong></div>
            <div><span>Port</span><strong>${escape(scanned?.portName || device?.port_name || 'Unknown')}</strong></div>
            <div><span>Paper Sizes</span><strong>${papers.length ? escape(papers.join(', ')) : 'Standard (A4)'}</strong></div>
            <div><span>Max Resolution</span><strong>${dpi ? `${dpi} DPI` : 'Driver default'}</strong></div>
          </div>
          <hr class="pc-divider">
          <form id="pc-config-form">
            <div class="pc-form-row">
              <label class="field">Colour Capability
                <select name="color" ${!device?.active ? 'disabled' : ''}>
                  <option value="false" ${!currentColor ? 'selected' : ''}>Monochrome (Black &amp; White only)</option>
                  <option value="true" ${currentColor ? 'selected' : ''} ${driverColor === false ? 'disabled' : ''}>Colour + Black &amp; White${driverColor === false ? ' (Unsupported by driver)' : ''}</option>
                </select>
              </label>
              <label class="field">Duplex Capability
                <select name="duplex" ${!device?.active ? 'disabled' : ''}>
                  <option value="false" ${!currentDuplex ? 'selected' : ''}>One-sided (Simplex only)</option>
                  <option value="true" ${currentDuplex ? 'selected' : ''} ${driverDuplex === false ? 'disabled' : ''}>Automatic Two-sided (Duplex)${driverDuplex === false ? ' (Unsupported by driver)' : ''}</option>
                </select>
              </label>
            </div>
            ${device?.active ? `
              <div class="pc-form-toggles">
                <label class="pc-checkbox"><input type="checkbox" name="paused" ${device.is_paused ? 'checked' : ''}> Pause this printer in SmartPrint shop queue</label>
              </div>
              <div class="pc-modal-actions">
                ${!isDefault ? `<button type="button" class="secondary small" id="pc-cfg-default" data-id="${device.id}" data-name="${escape(name)}">Set as Default</button>` : ''}
                ${device.abilities?.source === 'owner' ? `<button type="button" class="secondary small" id="pc-cfg-sync">Reset to Driver</button>` : ''}
                <button type="submit" class="primary small">Save Configuration</button>
              </div>
            ` : `<p class="muted small">Connect this printer to configure SmartPrint settings.</p>`}
          </form>
        </div>
      </div>
    </div>
  `;
}

function renderNetworkModal(pc, escape) {
  if (!uiState.showNetworkModal || !pc) return '';
  const drivers = (pc.drivers || []).filter(d => d && typeof d.name === 'string');
  const groups = [...new Set(drivers.map(d => d.manufacturer || 'Other'))].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  return `
    <div class="pc-modal-backdrop" id="pc-net-backdrop">
      <div class="pc-modal" role="dialog" aria-modal="true" aria-labelledby="pc-net-title">
        <div class="pc-modal-head">
          <div>
            <span class="pc-eyebrow">TCP/IP &amp; WI-FI SETUP</span>
            <h2 id="pc-net-title">Add Network Printer by IP</h2>
          </div>
          <button type="button" class="icon-button" id="pc-close-net" aria-label="Close">${icon('cross')}</button>
        </div>
        <form id="add-network-printer" class="pc-modal-body" autocomplete="off" novalidate>
          <p class="muted small">Enter the printer's local IP address (e.g. <code>192.168.1.50</code>) and choose its installed Windows driver.</p>
          <label class="field">Printer IP Address<input name="ip" required placeholder="192.168.1.50" inputmode="decimal" maxlength="15"></label>
          <label class="field">Installed Windows Driver
            <select name="driver" required ${drivers.length ? '' : 'disabled'}>
              <option value="">${drivers.length ? 'Select installed driver…' : 'No printer driver found'}</option>
              ${groups.map(g => `<optgroup label="${escape(g)}">${drivers.filter(d => (d.manufacturer || 'Other') === g).map(d => `<option value="${escape(d.name)}">${escape(d.name)}</option>`).join('')}</optgroup>`).join('')}
            </select>
          </label>
          <label class="field">Queue Name (optional)<input name="name" maxlength="100" placeholder="Front Desk LaserJet"></label>
          <div id="network-result" class="network-result" role="status" aria-live="polite"></div>
          <div class="pc-modal-actions">
            <button type="button" class="secondary small" id="probe-printer">Test IP Connection</button>
            <button type="submit" class="primary small" ${drivers.length ? '' : 'disabled'}>Add to Windows</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderDiagnosticsModal(diag, escape) {
  if (!uiState.diagDeviceId || !diag) return '';
  return `
    <div class="pc-modal-backdrop" id="pc-diag-backdrop">
      <div class="pc-modal" role="dialog" aria-modal="true" aria-labelledby="pc-diag-title">
        <div class="pc-modal-head">
          <div style="min-width:0">
            <span class="pc-eyebrow">PRINTER DIAGNOSTICS</span>
            <h2 id="pc-diag-title" style="word-break:break-word">${escape(diag.name)}</h2>
          </div>
          <button type="button" class="icon-button" id="pc-close-diag" aria-label="Close">${icon('cross')}</button>
        </div>
        <div class="pc-modal-body">
          <div class="pc-detail-grid">
            <div><span>Health State</span><strong>${escape(diag.health?.label || 'Unknown')}</strong></div>
            <div><span>Spooler Flags</span><strong>${escape(diag.health?.detail || 'None')}</strong></div>
            <div><span>Connector ID</span><strong>${escape(diag.connector_id || '—')}</strong></div>
            <div><span>Machine / Version</span><strong>${escape(diag.machine_name || '—')} (${escape(diag.connector_version || '—')})</strong></div>
            <div><span>Last Heartbeat</span><strong>${escape(fmtTime(diag.heartbeat))}</strong></div>
            <div><span>Last Windows Check</span><strong>${escape(fmtTime(diag.health?.checked_at))}</strong></div>
          </div>
          <h4 style="margin:16px 0 8px">Recent Print Attempts</h4>
          ${diag.recent_jobs?.length ? `<div class="pc-diag-jobs">${diag.recent_jobs.map(j => `
            <div class="pc-diag-job">
              <span>${escape(j.file_name || j.order_id.slice(0, 8))}</span>
              <span class="pc-badge pc-badge-${j.state === 'failed' ? 'danger' : 'neutral'}">${escape(j.state)} (${escape(j.order_status)})</span>
              ${j.detail ? `<small class="muted">${escape(j.detail)}</small>` : ''}
            </div>
          `).join('')}</div>` : '<p class="muted small">No recent print jobs recorded for this printer.</p>'}
        </div>
      </div>
    </div>
  `;
}

export async function renderPrinterConnectPage({ api, workspace, escape, notify }) {
  uiState.scanning = uiState.freshScan;
  if (uiState.freshScan) uiState.scanStage = 'Reading Windows printers & capabilities…';
  let devices = [], reported = [], connectorsData = null, pc = null, diagData = null;
  try {
    [devices, reported, connectorsData, pc] = await Promise.all([
      api('/api/owner/devices'),
      api('/api/owner/printers/scan').catch(() => []),
      api('/api/owner/connectors').catch(() => null),
      connectorCall(uiState.freshScan ? '/status?fresh=1&drivers=1' : '/status?drivers=1').catch(() => null)
    ]);
    uiState.scanError = '';
    if (uiState.freshScan) uiState.scanStage = 'Discovery complete.';
  } catch (err) {
    uiState.scanError = err.message || 'Failed to load printer data.';
    uiState.scanStage = '';
  } finally {
    uiState.freshScan = false;
    uiState.scanning = false;
  }

  if (uiState.diagDeviceId) {
    diagData = await api(`/api/owner/devices/${uiState.diagDeviceId}/diagnostics`).catch(() => null);
  }

  const allItems = buildUnifiedPrinters(pc, devices, reported);
  const connected = allItems.filter(i => i.device?.active);
  const connEval = evaluateConnectorPanel(pc, connectorsData, connected);

  const needle = uiState.search.trim().toLowerCase();
  const filtered = allItems.filter(item => {
    if (uiState.filterTab === 'usb' && !(item.scanned ? item.scanned.isWired : /usb/i.test(item.device?.connection_type || ''))) return false;
    if (uiState.filterTab === 'network' && !(item.scanned ? item.scanned.isWifi : /wi-?fi|network|tcp|ethernet|shared/i.test(item.device?.connection_type || ''))) return false;
    if (uiState.filterTab === 'connected' && !item.device?.active) return false;
    if (needle) {
      const hay = [item.name, item.scanned?.portName, item.device?.port_name, item.scanned?.driverName, item.device?.driver_name, item.scanned?.manufacturer, item.device?.manufacturer].join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  workspace(`
    <div class="workhead">
      <div>
        <h1>Printer Connect Setup</h1>
        <p class="muted">Detect Windows printers, verify driver capabilities, and connect with one click.</p>
      </div>
    </div>
    ${renderOverview(allItems, pc, connEval, escape)}
    ${renderConnectorBanner(pc, connEval, escape)}
    ${renderDiscoveryBar(pc, allItems, escape)}
    <section class="pc-cards-section">
      ${filtered.length
        ? `<div class="pc-cards-grid">${filtered.map(item => renderPrinterCard(item, pc, connEval, escape)).join('')}</div>`
        : `<div class="panel pc-empty-state">${icon('printer')}<strong>No printers match this view</strong><p class="muted small">${allItems.length ? 'Try clearing your search or switching tabs.' : 'Connect a USB or network printer in Windows, then click Scan Printers.'}</p></div>`}
    </section>
    ${renderConfigModal(pc, devices, reported, escape)}
    ${renderNetworkModal(pc, escape)}
    ${renderDiagnosticsModal(diagData, escape)}
  `, 'printers');

  const rerender = () => renderPrinterConnectPage({ api, workspace, escape, notify });

  document.querySelectorAll('[data-pc-tab]').forEach(btn => {
    btn.onclick = () => { uiState.filterTab = btn.dataset.pcTab; rerender(); };
  });
  const searchInput = document.querySelector('#pc-search');
  if (searchInput) searchInput.oninput = e => { uiState.search = e.target.value; rerender(); };
  const autoChk = document.querySelector('#pc-autorefresh');
  if (autoChk) autoChk.onchange = e => { uiState.autoRefresh = e.target.checked; };

  document.querySelector('#pc-scan-btn')?.addEventListener('click', () => { uiState.freshScan = true; rerender(); });
  document.querySelector('#pc-retry-scan')?.addEventListener('click', () => { uiState.freshScan = true; rerender(); });
  document.querySelector('#pc-check-connector')?.addEventListener('click', () => rerender());
  document.querySelector('#pc-add-network')?.addEventListener('click', () => {
    if (!pc) return notify('Start the Windows Connector on this PC first.');
    uiState.showNetworkModal = true; rerender();
  });

  // Release & transfer ownership
  document.querySelector('#pc-release-transfer')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    if (!confirm(`Release this PC's connector from ${pc.shopName || pc.server} and pair it to ${connEval.shop?.name || 'this shop'}?`)) return;
    btn.disabled = true; btn.textContent = 'Releasing…';
    try {
      if (pc.connectorId) {
        await api('/api/owner/connectors/release', { method: 'POST', body: { connectorId: pc.connectorId } }).catch(() => {});
      }
      await connectorCall('/release', { method: 'POST' });
      if (pc.connectorId) {
        const pt = await api('/api/owner/connectors/pairing-token', { method: 'POST' });
        await api('/api/owner/connectors/pair', {
          method: 'POST',
          body: { connectorId: pc.connectorId, machineId: pc.machineId, machineName: pc.machineName, version: pc.connectorVersion, pairingToken: pt.pairingToken }
        });
      }
      notify(`Connector paired to ${connEval.shop?.name || 'this shop'}. You can now connect printers.`);
    } catch (err) {
      notify(err.message);
    }
    rerender();
  });

  // 1-Click Connect Printer
  document.querySelectorAll('[data-pc-connect]').forEach(btn => btn.onclick = async () => {
    const name = btn.dataset.pcConnect;
    const item = allItems.find(i => sameName(i.name, name));
    const s = item?.scanned;
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      if (pc?.connectorId) {
        const pt = await api('/api/owner/connectors/pairing-token', { method: 'POST' });
        await api('/api/owner/connectors/pair', {
          method: 'POST',
          body: { connectorId: pc.connectorId, machineId: pc.machineId, machineName: pc.machineName, version: pc.connectorVersion, pairingToken: pt.pairingToken }
        });
      }
      const linked = await api('/api/owner/printers/autoconnect', {
        method: 'POST',
        body: {
          name,
          color: Boolean(s?.color),
          duplex: Boolean(s?.duplex),
          manual: false,
          portName: s?.portName,
          driverName: s?.driverName,
          connectionType: s?.connectionType,
          isDefault: Boolean(s?.isDefault),
          paperSizes: s?.paperSizes,
          resolutionDpi: s?.resolutionDpi,
          machineName: pc?.machineName,
          connectorId: pc?.connectorId,
          connectorVersion: pc?.connectorVersion
        }
      });
      await connectorCall('/pair', {
        method: 'POST',
        body: { url: location.origin, token: linked.token, printer: name, shopId: connEval.shop?.id, shopName: connEval.shop?.name }
      });
      for (let i = 0; i < 10; i++) {
        await sleep(800);
        const latest = (await api('/api/owner/devices')).find(d => d.id === linked.id);
        if (isOnline(latest)) break;
      }
      notify(`${name} connected and verified.`);
    } catch (err) {
      notify(err.message);
    }
    rerender();
  });

  // Disconnect Printer
  document.querySelectorAll('[data-pc-disconnect]').forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.pcDisconnect, name = btn.dataset.printerName;
    if (!confirm(`Disconnect "${name}" from SmartPrint? Its Windows driver and historical print records are preserved.`)) return;
    btn.disabled = true;
    try {
      await api(`/api/owner/devices/${id}`, { method: 'DELETE' });
      if (pc) await connectorCall('/unpair', { method: 'POST', body: { printer: name } }).catch(() => {});
      notify(`${name} disconnected.`);
    } catch (err) { notify(err.message); }
    rerender();
  });

  // Genuine Test Print with live stage polling
  document.querySelectorAll('[data-pc-test]').forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.pcTest;
    btn.disabled = true;
    uiState.testPrints.set(id, { orderId: null, stage: 'queued', label: 'Submitting test page…', detail: '' });
    rerender();
    try {
      const res = await api(`/api/owner/devices/${id}/test-print`, { method: 'POST' });
      uiState.testPrints.set(id, { orderId: res.orderId, stage: 'queued', label: 'Queued for connector…', detail: '' });
      rerender();
      for (let i = 0; i < 20; i++) {
        await sleep(1500);
        const st = await api(`/api/owner/devices/${id}/test-print/${res.orderId}`).catch(() => null);
        if (!st) break;
        const labels = {
          queued: 'Queued for connector…',
          claimed_by_connector: 'Claimed by Windows connector…',
          spooler_submitting: 'Submitting to Windows spooler…',
          spooler_accepted: 'Accepted by Windows spooler — check physical paper output.',
          completed: 'Test print completed.',
          failed: 'Test print failed.'
        };
        uiState.testPrints.set(id, { orderId: res.orderId, stage: st.stage, label: labels[st.stage] || st.status, detail: st.detail || '' });
        if (['spooler_accepted', 'completed', 'failed', 'cancelled'].includes(st.stage)) {
          notify(st.stage === 'failed' ? `Test print failed: ${st.detail || 'Check printer'}` : labels[st.stage]);
          break;
        }
      }
    } catch (err) {
      uiState.testPrints.set(id, { orderId: null, stage: 'failed', label: 'Test print rejected', detail: err.message });
      notify(err.message);
    }
    rerender();
  });

  document.querySelectorAll('[data-use-detected]').forEach(btn => btn.onclick = async () => {
    try {
      await api(`/api/owner/devices/${btn.dataset.useDetected}`, { method: 'PATCH', body: { useDetected: true } });
      notify('Synced with Windows driver capabilities.');
      rerender();
    } catch (err) { notify(err.message); }
  });

  // Modals
  document.querySelectorAll('[data-pc-config]').forEach(btn => btn.onclick = () => { uiState.configPrinter = btn.dataset.pcConfig; rerender(); });
  document.querySelector('#pc-close-config')?.addEventListener('click', () => { uiState.configPrinter = null; rerender(); });
  document.querySelector('#pc-config-backdrop')?.addEventListener('click', e => { if (e.target.id === 'pc-config-backdrop') { uiState.configPrinter = null; rerender(); } });

  const cfgForm = document.querySelector('#pc-config-form');
  if (cfgForm) {
    const item = allItems.find(i => sameName(i.name, uiState.configPrinter));
    const dev = item?.device;
    document.querySelector('#pc-cfg-default')?.addEventListener('click', async e => {
      const { id, name } = e.currentTarget.dataset;
      try {
        await api(`/api/owner/devices/${id}/default`, { method: 'POST' });
        if (pc) await connectorCall('/set-default', { method: 'POST', body: { printer: name } }).catch(() => {});
        notify(`${name} set as default printer.`);
        uiState.configPrinter = null; rerender();
      } catch (err) { notify(err.message); }
    });
    document.querySelector('#pc-cfg-sync')?.addEventListener('click', async () => {
      try {
        await api(`/api/owner/devices/${dev.id}`, { method: 'PATCH', body: { useDetected: true } });
        notify('Capabilities synced with Windows driver.');
        uiState.configPrinter = null; rerender();
      } catch (err) { notify(err.message); }
    });
    cfgForm.onsubmit = async e => {
      e.preventDefault();
      if (!dev) return;
      const fd = new FormData(cfgForm);
      try {
        await api(`/api/owner/devices/${dev.id}`, {
          method: 'PATCH',
          body: { color: fd.get('color') === 'true', duplex: fd.get('duplex') === 'true' }
        });
        const wantPaused = fd.get('paused') === 'on';
        if (wantPaused !== Boolean(dev.is_paused)) {
          await api(`/api/owner/devices/${dev.id}/pause`, { method: 'POST' });
        }
        notify('Printer configuration saved.');
        uiState.configPrinter = null; rerender();
      } catch (err) { notify(err.message); }
    };
  }

  document.querySelectorAll('[data-pc-diag]').forEach(btn => btn.onclick = () => { uiState.diagDeviceId = btn.dataset.pcDiag; rerender(); });
  document.querySelector('#pc-close-diag')?.addEventListener('click', () => { uiState.diagDeviceId = null; rerender(); });
  document.querySelector('#pc-diag-backdrop')?.addEventListener('click', e => { if (e.target.id === 'pc-diag-backdrop') { uiState.diagDeviceId = null; rerender(); } });

  document.querySelector('#pc-close-net')?.addEventListener('click', () => { uiState.showNetworkModal = false; rerender(); });
  document.querySelector('#pc-net-backdrop')?.addEventListener('click', e => { if (e.target.id === 'pc-net-backdrop') { uiState.showNetworkModal = false; rerender(); } });

  const netForm = document.querySelector('#add-network-printer');
  if (netForm) {
    const resBox = netForm.querySelector('#network-result');
    const showNet = (msg, ok = false) => {
      resBox.innerHTML = `<p class="${ok ? 'network-ok' : 'network-error'}">${escape(msg)}</p>`;
    };
    netForm.querySelector('#probe-printer').onclick = async () => {
      const ip = new FormData(netForm).get('ip');
      showNet('Testing connection…', true);
      try {
        const found = await connectorCall('/probe', { method: 'POST', body: { ip } });
        showNet(found.reachable ? `Printer reachable at ${found.ip} (${found.ports.map(p => p.label).join(', ')}).` : `No response from ${found.ip}.`, found.reachable);
      } catch (err) { showNet(err.message, false); }
    };
    netForm.onsubmit = async e => {
      e.preventDefault();
      const { ip, driver, name } = Object.fromEntries(new FormData(netForm));
      try {
        const added = await connectorCall('/network-printer', { method: 'POST', body: { ip, driver, name } });
        uiState.showNetworkModal = false; uiState.freshScan = true;
        notify(`Added ${added.printer} in Windows. Click Connect on its card.`);
        rerender();
      } catch (err) { showNet(err.message, false); }
    };
  }

  if (uiState.autoRefresh) {
    const pcSnapshot = pc ? { linked: pc.linked, needsRelink: pc.needsRelink, linkedHere: pc.linkedHere, shopId: pc.shopId, printer: pc.printer } : null;
    watchUpdates(
      () => Promise.all([
        api('/api/owner/devices'),
        api('/api/owner/printers/scan').catch(() => []),
        connectorCall('/status?printers=0').then(s => ({ linked: s.linked, needsRelink: s.needsRelink, linkedHere: s.linkedHere, shopId: s.shopId, printer: s.printer })).catch(() => null)
      ]),
      [devices, reported, pcSnapshot],
      () => {
        if (!uiState.autoRefresh || uiState.configPrinter || uiState.diagDeviceId || uiState.showNetworkModal) return;
        if (document.activeElement?.id === 'pc-search') return;
        rerender();
      },
      5000
    );
  }
}
