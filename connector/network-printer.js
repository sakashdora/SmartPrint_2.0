import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isVirtualPrinter, detectManufacturer } from '../server/printer-capabilities.js';

const runPowerShell = promisify(execFile);
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// Adding a Wi-Fi / network printer by address. This never downloads or installs a printer driver: it only creates a
// standard TCP/IP port and a printer that uses a driver ALREADY installed in Windows (the owner picks it from the
// list). Every value is validated here and reaches PowerShell through environment variables, never the command text.

// Printers live on the shop's own network. Public, loopback, multicast and link-local addresses are refused, so this
// cannot be turned into a probe of the internet or of the PC itself.
export function validatePrinterAddress(value) {
  const text = String(value ?? '').trim();
  // Four numbers without leading zeros ("192.168.001.050" can be read as octal by some tools, so it is refused).
  const match = text.match(/^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/);
  if (!match) throw fail(400, 'Enter the printer\'s address as four plain numbers, for example 192.168.1.50.');
  const [a, b, c, d] = match.slice(1).map(Number);
  if ([a, b, c, d].some(n => n > 255)) throw fail(400, 'Each part of the address must be between 0 and 255.');
  const privateNet = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!privateNet) throw fail(400, 'That address is not on a private network. Use the printer\'s address on your shop WiFi or LAN (it starts with 192.168, 10. or 172.16–31).');
  if (d === 0 || d === 255) throw fail(400, 'That is a network address, not a printer. Check the last number.');
  return `${a}.${b}.${c}.${d}`;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()\-]{0,99}$/;

// installedDrivers: names reported by Windows. `driver` must be one of them (case-insensitive); it is replaced by Windows's own spelling.
export function validateNetworkPrinter({ ip, name, driver }, installedDrivers = []) {
  const address = validatePrinterAddress(ip);
  const canonical = installedDrivers.find(d => String(d).toLowerCase() === String(driver ?? '').trim().toLowerCase());
  if (!canonical) throw fail(400, 'Choose a printer driver that is already installed in Windows. SmartPrint never installs drivers for you: install the driver from the maker\'s website first, then add the printer here.');
  if (isVirtualPrinter({ driver: canonical })) throw fail(400, 'That is a software driver (PDF, XPS, OneNote…). Choose the driver for your printer.');
  const label = String(name ?? '').trim() || `${detectManufacturer('', canonical) === 'Other' ? 'Network printer' : detectManufacturer('', canonical)} ${address}`;
  if (!NAME.test(label)) throw fail(400, 'Use letters, numbers, spaces and . _ ( ) - only in the printer name (up to 100 characters).');
  return { ip: address, name: label, driver: canonical, portName: `IP_${address}` };
}

// Which common printing ports answer at this address? A reachable port proves something is listening there, not that
// it is a working printer; the owner still prints a test page.
export const PRINT_PORTS = [{ port: 9100, label: 'RAW / JetDirect' }, { port: 631, label: 'IPP' }, { port: 515, label: 'LPR' }];
export function tcpOpen(host, port, timeoutMs = 2500) {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
export async function probePrinterAddress(ip, { open = tcpOpen } = {}) {
  const address = validatePrinterAddress(ip);
  const answered = (await Promise.all(PRINT_PORTS.map(async p => (await open(address, p.port)) ? p : null))).filter(Boolean);
  return { ip: address, reachable: answered.length > 0, ports: answered };
}

// Drivers already installed in Windows, without the software "printers" that never put paper out.
export async function listInstalledDrivers({ run = runPowerShell } = {}) {
  if (process.platform !== 'win32' && run === runPowerShell) return [];
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'ConvertTo-Json -Compress -InputObject @(Get-PrinterDriver -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)'], { timeout: 20000, windowsHide: true });
    const parsed = JSON.parse(String(stdout).trim() || '[]');
    return [...new Set((Array.isArray(parsed) ? parsed : [parsed]).filter(n => typeof n === 'string' && n && !isVirtualPrinter({ driver: n }) && !/point and print|easy print/i.test(n)))].sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$port = 'IP_' + $env:SP_IP",
  'if (-not (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue)) { Add-PrinterPort -Name $port -PrinterHostAddress $env:SP_IP }',
  "if (Get-Printer -Name $env:SP_NAME -ErrorAction SilentlyContinue) { throw 'A printer with this name already exists in Windows.' }",
  'Add-Printer -Name $env:SP_NAME -DriverName $env:SP_DRIVER -PortName $port'
].join('\n');

const quote = value => `'${String(value).replace(/'/g, "''")}'`;
// The same steps for a PowerShell window opened "as administrator" (Windows normally requires it to create a port).
export const adminCommand = ({ ip, name, driver, portName }) => `Add-PrinterPort -Name ${quote(portName)} -PrinterHostAddress ${quote(ip)}; Add-Printer -Name ${quote(name)} -DriverName ${quote(driver)} -PortName ${quote(portName)}`;

export async function addNetworkPrinter(input, { installedDrivers, existingNames = [], run = runPowerShell } = {}) {
  validatePrinterAddress(input?.ip); // the cheap check first: asking Windows for its drivers takes a few seconds
  const drivers = installedDrivers ?? await listInstalledDrivers();
  const printer = validateNetworkPrinter(input, drivers);
  if (existingNames.some(n => String(n).toLowerCase() === printer.name.toLowerCase())) throw fail(409, `A printer named "${printer.name}" is already installed. Choose a different name.`);
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      timeout: 60000, windowsHide: true,
      env: { ...process.env, SP_IP: printer.ip, SP_NAME: printer.name, SP_DRIVER: printer.driver }
    });
  } catch (error) {
    const text = `${error.stderr ?? ''} ${error.message ?? ''}`;
    if (/access is denied|0x80070005|administrator|elevat|permission/i.test(text)) {
      throw fail(403, 'Windows needs administrator permission to add a printer port. Open PowerShell as administrator, paste the command below, then click Scan again.', { needsAdmin: true, command: adminCommand(printer) });
    }
    throw fail(500, `Windows could not add the printer: ${String(error.stderr || error.message).trim().split(/\r?\n/)[0].slice(0, 200)}`);
  }
  return printer;
}
