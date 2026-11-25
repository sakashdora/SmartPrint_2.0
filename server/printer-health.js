// Printer health: what we actually know about a printer, and how sure we are.
//
// Two independent facts are kept apart on purpose:
//   1. Is the SmartPrint connector on the shop PC alive?   -> devices.heartbeat (every ~10 s)
//   2. What does Windows say the printer itself is doing?  -> devices.health*   (every ~60 s, from the spooler)
// A live connector says nothing about paper, toner or cables, so a printer is never called "ready" on the
// strength of the heartbeat alone. When Windows has not reported (older connector, scan failed, report too
// old) the state is `unknown` and the owner is told exactly that.
//
// The Windows spooler's PrinterStatus is a bitmask (PRINTER_STATUS_*). It is a best-effort signal: many USB
// printers report "normal" while unplugged, and ink or toner levels are exposed only by some drivers (SNMP is
// not used). Detection capability is therefore reported together with the time of the last check.
// A colour job needs a colour-capable printer and a two-sided job a duplex printer. Black & white and
// one-sided jobs run on any printer. Unknown capability is stored as 0, so it never qualifies.
export function printerSupports(device, options) {
  return (options.color !== 'color' || Number(device?.color) === 1) && (!options.duplex || Number(device?.duplex) === 1);
}

export const CONNECTOR_FRESH_MS = 180000; // same window the rest of the app uses for "online"
export const HEALTH_FRESH_MS = 300000;    // the connector reports every 60 s; allow a few missed scans

// PRINTER_STATUS_* flags from winspool.h, in the order they are judged when several are set.
const FLAGS = [
  [0x80, 'offline', 'Offline in Windows (cable, power or network)', true],
  [0x2, 'error', 'Printer error', true],
  [0x8, 'paper_jam', 'Paper jam', true],
  [0x10, 'paper_out', 'Out of paper', true],
  [0x40, 'paper_problem', 'Paper problem', true],
  [0x400000, 'door_open', 'Cover or door open', true],
  [0x40000, 'toner_out', 'Out of toner or ink', true],
  [0x100000, 'attention', 'Needs attention at the printer', true],
  [0x200000, 'out_of_memory', 'Printer out of memory', true],
  [0x1, 'paused', 'Windows print queue is paused', true],
  [0x800, 'output_bin_full', 'Output tray full', true],
  [0x1000, 'not_available', 'Not available', true],
  [0x20000, 'toner_low', 'Toner or ink is low', false],
  [0x1000000, 'ready', 'Power save', false],
  [0x400, 'printing', 'Printing', false],
  [0x200, 'busy', 'Busy', false],
  [0x4000, 'busy', 'Processing', false],
  [0x10000, 'busy', 'Warming up', false],
  [0x8000, 'busy', 'Initializing', false],
  [0x2000, 'busy', 'Waiting', false]
];

const BY_NAME = {
  normal: 'ready', ready: 'ready', idle: 'ready', offline: 'offline', error: 'error', paperjam: 'paper_jam', paperout: 'paper_out',
  paperproblem: 'paper_problem', dooropen: 'door_open', notoner: 'toner_out', tonerlow: 'toner_low', paused: 'paused',
  userintervention: 'attention', outofmemory: 'out_of_memory', printing: 'printing', busy: 'busy', outputbinfull: 'output_bin_full'
};

export const HEALTH_STATES = Object.freeze({
  ready: { label: 'Ready', blocking: false },
  printing: { label: 'Printing', blocking: false },
  busy: { label: 'Busy', blocking: false },
  toner_low: { label: 'Toner or ink is low', blocking: false },
  unknown: { label: 'Status not reported', blocking: false },
  offline: { label: 'Offline in Windows (cable, power or network)', blocking: true },
  error: { label: 'Printer error', blocking: true },
  paper_jam: { label: 'Paper jam', blocking: true },
  paper_out: { label: 'Out of paper', blocking: true },
  paper_problem: { label: 'Paper problem', blocking: true },
  door_open: { label: 'Cover or door open', blocking: true },
  toner_out: { label: 'Out of toner or ink', blocking: true },
  attention: { label: 'Needs attention at the printer', blocking: true },
  out_of_memory: { label: 'Printer out of memory', blocking: true },
  paused: { label: 'Windows print queue is paused', blocking: true },
  output_bin_full: { label: 'Output tray full', blocking: true },
  not_available: { label: 'Not available', blocking: true }
});

// code: the numeric/string PrinterStatus Windows returned (null/undefined/'' when it could not be read).
// Returns { state, label, blocking, flags }. `blocking` means a job sent now would very likely not print.
export function classifyPrinterHealth(code) {
  if (code === null || code === undefined || code === '') return { state: 'unknown', ...HEALTH_STATES.unknown, flags: [] };
  if (typeof code === 'string' && !/^\d+$/.test(code.trim())) {
    const state = BY_NAME[code.trim().toLowerCase().replace(/[\s_-]/g, '')];
    return state ? { state, ...HEALTH_STATES[state], flags: [] } : { state: 'unknown', ...HEALTH_STATES.unknown, flags: [] };
  }
  const value = Number(code);
  if (!Number.isInteger(value) || value < 0) return { state: 'unknown', ...HEALTH_STATES.unknown, flags: [] };
  if (value === 0) return { state: 'ready', ...HEALTH_STATES.ready, flags: [] };
  const flags = FLAGS.filter(([bit]) => value & bit);
  if (!flags.length) return { state: 'unknown', ...HEALTH_STATES.unknown, flags: [] }; // only bits we do not understand
  const [, state, , blocking] = flags.find(f => f[3]) ?? flags[0];
  return { state, ...HEALTH_STATES[state], flags: flags.map(f => f[2]) };
}

// The one place that decides what a device is, from its database row.
export function evaluateDevice(device, nowMs = Date.now()) {
  const beat = device?.heartbeat ? Date.parse(device.heartbeat) : NaN;
  const connectorOnline = Boolean(device?.active) && Number.isFinite(beat) && nowMs - beat <= CONNECTOR_FRESH_MS;
  const checked = device?.health_checked ? Date.parse(device.health_checked) : NaN;
  const reported = Boolean(device?.health) && Number.isFinite(checked);
  const fresh = reported && nowMs - checked <= HEALTH_FRESH_MS;
  const paused = Number(device?.paused) === 1;
  let state, label, blocking = false, verified = false;
  if (!device?.active) { state = 'disconnected'; label = 'Disconnected'; blocking = true; }
  else if (!connectorOnline) { state = 'connector_offline'; label = 'Connector not running on the shop PC'; blocking = true; }
  else if (paused) { state = 'paused_by_owner'; label = device.paused_note || 'Paused by owner'; blocking = true; }
  else if (fresh && HEALTH_STATES[device.health]) { state = device.health; label = HEALTH_STATES[device.health].label; blocking = HEALTH_STATES[device.health].blocking; verified = state !== 'unknown'; }
  else { state = 'unknown'; label = reported ? 'Connector online · printer status is out of date' : 'Connector online · printer status not reported'; }
  return {
    state, label, blocking, verified,
    detail: fresh ? (device.health_detail || null) : null,
    source: reported ? (device.health_source || 'windows-spooler') : null,
    checked_at: reported ? device.health_checked : null,
    connector_online: connectorOnline,
    // May the claim loop offer this printer work? Unknown health does not block (older connectors never report it).
    claimable: connectorOnline && !paused && !blocking
  };
}

// Can this shop print an order with these options right now? Shops with no registered printer print by hand
// (the owner downloads the file), so there is nothing to check and the answer is "yes, manually".
export async function shopPrinterAvailability(db, shopId, options, nowMs = Date.now()) {
  const devices = await db.query('SELECT * FROM devices WHERE shop_id=$1 AND active=1', [shopId]);
  if (!devices.length) return { available: true, manual: true, reason: null };
  const evaluated = devices.map(device => ({ device, health: evaluateDevice(device, nowMs) }));
  const claimable = evaluated.filter(e => e.health.claimable);
  if (!claimable.length) {
    const why = evaluated.find(e => e.health.connector_online)?.health.label ?? 'No printer connector is running at this shop.';
    return { available: false, manual: false, reason: `The shop's printer is not ready: ${why}.` };
  }
  if (!claimable.some(e => printerSupports(e.device, options))) {
    const needs = [options.color === 'color' && 'colour', options.duplex && 'two-sided'].filter(Boolean).join(' and ');
    return { available: false, manual: false, reason: `No ready printer at this shop supports ${needs || 'these'} printing.` };
  }
  return { available: true, manual: false, reason: null };
}
