// Admin: every printer connected to any shop, what it can do, where that knowledge comes from, and what it is doing now.
// The admin workspace refreshes on a timer, so this stays current without a reload.
const stateOf = d => {
  const h = d.health;
  if (h.state === 'paused_by_owner') return 'paused';
  if (!h.connector_online) return 'offline';
  return h.claimable ? 'ready' : 'attention';
};
const STATE_LABEL = { ready: 'Ready', attention: 'Needs attention', offline: 'Offline', paused: 'Paused by owner' };
const SOURCE_LABEL = { driver: 'Detected from driver', owner: 'Set by owner', unverified: 'Not verified' };

export function printerStats(devices) {
  const active = devices.filter(d => Number(d.active) === 1);
  const count = predicate => active.filter(predicate).length;
  return {
    total: active.length,
    ready: count(d => stateOf(d) === 'ready'),
    attention: count(d => stateOf(d) === 'attention'),
    offline: count(d => stateOf(d) === 'offline'),
    colour: count(d => d.abilities.colour),
    twoSided: count(d => d.abilities.two_sided),
    mismatch: count(d => d.abilities.has_mismatch),
    unverified: count(d => d.abilities.source === 'unverified')
  };
}

export function filterPrinters(devices, { q = '', state = 'all' } = {}) {
  const needle = q.trim().toLowerCase();
  return devices.filter(d => Number(d.active) === 1).filter(d => {
    if (state === 'mismatch' ? !d.abilities.has_mismatch : state !== 'all' && stateOf(d) !== state) return false;
    return !needle || [d.name, d.shop_name, d.manufacturer, d.health.label, d.abilities.summary].join(' ').toLowerCase().includes(needle);
  });
}

export function adminPrintersView({ devices, escape, filter = {}, time }) {
  const stats = printerStats(devices), rows = filterPrinters(devices, filter);
  const tile = (label, value, tone = '') => `<div class="printer-kpi ${tone}"><strong>${value}</strong><span>${escape(label)}</span></div>`;
  const row = d => {
    const state = stateOf(d), ab = d.abilities, h = d.health;
    const driverSays = ab.detected ? `${ab.detected.colour ? 'colour' : 'B&W only'}, ${ab.detected.two_sided ? 'two-sided' : 'one-sided'}` : '';
    return `<article class="printer-item state-${state}">
      <header>
        <div><strong>${escape(d.name)}</strong>${d.manufacturer && d.manufacturer !== 'Other' ? ` <span class="chip brand-chip">${escape(d.manufacturer)}</span>` : ''}<br><small class="muted">${escape(d.shop_name)} · ${escape(d.shop_slug || '')}</small></div>
        <span class="printer-state ${state}" title="${escape(h.detail || h.label)}">${escape(STATE_LABEL[state])}</span>
      </header>
      <div class="ability-chips"><span class="chip">${ab.colour ? '🎨 Colour + B&amp;W' : '⚫ B&amp;W only'}</span><span class="chip">${ab.two_sided ? '⇄ Two-sided + one-sided' : '▭ One-sided only'}</span></div>
      <p class="small">${escape(SOURCE_LABEL[ab.source])}${ab.has_mismatch ? ` <span class="printer-warn">⚠ the driver says ${escape(driverSays)}</span>` : ''}</p>
      <p class="small muted">${escape(h.label)}${h.detail ? ` (${escape(h.detail)})` : ''}<br>Windows check: ${h.checked_at ? escape(time(h.checked_at)) : 'never reported'} · Connector: ${d.heartbeat ? escape(time(d.heartbeat)) : 'never seen'}</p>
    </article>`;
  };
  return `<div class="workhead"><div><h1>Printers</h1><p class="muted">Every connected printer: what it can do, where that was detected or set, and what it is doing right now. Updates by itself.</p></div><button class="secondary" id="admin-refresh">Refresh</button></div>
  <section class="panel">
    <div class="printer-kpis">
      ${tile('Connected printers', stats.total)}${tile('Ready now', stats.ready, 'ok')}${tile('Need attention', stats.attention, stats.attention ? 'warn' : '')}${tile('Offline', stats.offline, stats.offline ? 'warn' : '')}
      ${tile('Colour-capable', stats.colour)}${tile('Two-sided', stats.twoSided)}${tile('Setting differs from driver', stats.mismatch, stats.mismatch ? 'warn' : '')}${tile('Not verified', stats.unverified, stats.unverified ? 'warn' : '')}
    </div>
    <div class="printer-filters">
      <label class="field">Search<input id="printer-search" type="search" placeholder="Shop, printer, brand or status" value="${escape(filter.q || '')}" autocomplete="off"></label>
      <label class="field">Show<select id="printer-state">${[['all', 'All printers'], ['ready', 'Ready'], ['attention', 'Needs attention'], ['offline', 'Offline'], ['paused', 'Paused'], ['mismatch', 'Setting differs from driver']].map(([v, l]) => `<option value="${v}" ${filter.state === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    ${rows.length ? `<div class="printer-list">${rows.map(row).join('')}</div>`
      : `<div class="empty"><strong>${stats.total ? 'No printer matches.' : 'No printers connected yet.'}</strong><span class="muted">${stats.total ? 'Change the search or the filter.' : 'Printers appear here when a shop owner connects one.'}</span></div>`}
  </section>`;
}
