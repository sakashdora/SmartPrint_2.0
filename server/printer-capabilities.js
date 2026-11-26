import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Asks each Windows printer driver whether it can print colour, duplex, paper sizes, and resolution
// (System.Drawing.Printing.PrinterSettings + System.Printing.LocalPrintServer). Names travel through
// an environment variable, never the command text. Printers the driver cannot describe are left out:
// callers must treat them as unknown.
// Colour comes from the driver's PrintCapabilities (System.Printing) where available: the older
// DeviceCapabilities answer claims colour for mono drivers such as the HP LaserJet 1020.
const script = [
  'Add-Type -AssemblyName System.Drawing',
  'try { Add-Type -AssemblyName System.Printing; $srv = New-Object System.Printing.LocalPrintServer } catch { $srv = $null }',
  '$names = $env:SMARTPRINT_PRINTER_NAMES | ConvertFrom-Json',
  '$out = @(foreach ($n in $names) { $s = New-Object System.Drawing.Printing.PrinterSettings; $s.PrinterName = [string]$n;',
  'if ($s.IsValid) { $color = [bool]$s.SupportsColor; $duplex = [bool]$s.CanDuplex;',
  '$papers = @($s.PaperSizes | ForEach-Object { $_.PaperName } | Where-Object { $_ } | Select-Object -Unique -First 12);',
  '$dpi = @($s.PrinterResolutions | ForEach-Object { [Math]::Max($_.X, $_.Y) } | Where-Object { $_ -gt 0 } | Measure-Object -Maximum).Maximum;',
  'if ($srv) { try { $c = $srv.GetPrintQueue([string]$n).GetPrintCapabilities();',
  '$color = @($c.OutputColorCapability | Where-Object { "$_" -eq "Color" }).Count -gt 0;',
  '$duplex = $duplex -and (@($c.DuplexingCapability | Where-Object { "$_" -like "TwoSided*" }).Count -gt 0);',
  '$capPapers = @($c.PageMediaSizeCapability | ForEach-Object { "$($_.PageMediaSizeName)" } | Where-Object { $_ -and $_ -ne "Unknown" } | Select-Object -Unique -First 12);',
  'if ($capPapers.Count -gt 0) { $papers = $capPapers };',
  '$capDpi = @($c.PageResolutionCapability | ForEach-Object { [Math]::Max($_.X, $_.Y) } | Where-Object { $_ -gt 0 } | Measure-Object -Maximum).Maximum;',
  'if ($capDpi -gt 0) { $dpi = $capDpi } } catch {} }',
  '$driver = [string](Get-Printer -Name ([string]$n) -ErrorAction SilentlyContinue).DriverName;',
  '[pscustomobject]@{ name = [string]$n; driver = $driver; color = $color; duplex = $duplex; paperSizes = $papers; resolutionDpi = if ($dpi -gt 0) { [int]$dpi } else { $null } } } })',
  'ConvertTo-Json -Compress -InputObject $out'
].join('\n');

const PAPER_LABELS = {
  ISOA4: 'A4', ISOA3: 'A3', ISOA5: 'A5', ISOA6: 'A6',
  JISB4: 'B4', JISB5: 'B5',
  NorthAmericaLetter: 'Letter', NorthAmericaLegal: 'Legal', NorthAmericaExecutive: 'Executive',
  NorthAmericaStatement: 'Statement', NorthAmerica11x17: '11x17',
  NorthAmericaNumber10Envelope: 'Env #10', ISODLEnvelope: 'Env DL'
};
export function normalizePaperSizes(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const item of raw) {
    const clean = PAPER_LABELS[String(item || '').trim()] || String(item || '').trim();
    if (clean && !seen.has(clean)) seen.add(clean);
    if (seen.size >= 12) break;
  }
  return [...seen];
}

// Software printers that accept a job but never put paper out. Picking one of these as the fallback
// printer makes jobs "print" successfully while nothing comes out.
const VIRTUAL_NAME = /OneNote|Fax|XPS|PDF|PaperPort|Image Printer|AnyDesk|TeamViewer|Snagit|Send To|CutePDF|doPDF|novaPDF|Bullzip|PDFCreator|Foxit|Nitro|Print to|Document Writer|ePrint/i;
const VIRTUAL_PORT = /^(nul:?|PORTPROMPT:|FILE:|XPSPort:|SHRFAX:|PDF.*|.*Writer Port.*|AnyDesk.*)$/i;
export function isVirtualPrinter({ name = '', port = '', driver = '' } = {}) {
  return VIRTUAL_NAME.test(name) || VIRTUAL_NAME.test(driver) || VIRTUAL_PORT.test(String(port).trim());
}

// The company that made a printer, from its Windows name or driver. Used only to label cards and suggest the right
// support page; it never selects or installs a driver.
const MAKERS = [
  ['HP', /\bHP\b|hewlett|laserjet|deskjet|officejet|photosmart|pagewide|\benvy\b|\bsmart tank\b/i],
  ['Brother', /brother|\b(DCP|MFC|HL|MFC)-[A-Z]?\d|\bBRN|\bBRW/i],
  ['Epson', /epson|ecotank|workforce|expression|surecolor|\bET-\d|\bL\d{3,4}\b/i],
  ['Canon', /canon|pixma|maxify|imageclass|selphy|\bLBP\d|\bi-sensys|\bG\d{4}\b/i],
  ['Samsung', /samsung|\bML-\d|\bSCX|\bCLP-\d|xpress/i],
  ['Xerox', /xerox|workcentre|phaser|versalink/i],
  ['Ricoh', /ricoh|\bSP \d|aficio/i],
  ['Kyocera', /kyocera|ecosys|taskalfa/i],
  ['Lexmark', /lexmark/i],
  ['Konica Minolta', /konica|minolta|bizhub/i],
  ['Pantum', /pantum/i],
  ['Sharp', /\bsharp\b/i],
  ['Dell', /\bdell\b/i],
  ['OKI', /\bOKI\b|oki data/i]
];
export function detectManufacturer(name = '', driver = '') {
  const text = `${name} ${driver}`;
  return MAKERS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'Other';
}

// Port naming used by Windows and the vendor port monitors (HP, Brother, Canon, Epson). Vendor USB ports are
// checked before network ones because several vendors name both kinds with the same prefix letters.
export function classifyConnection({ name = '', port = '', driver = '', shared = false } = {}) {
  const p = String(port).trim();
  const n = String(name).trim();
  if (isVirtualPrinter({ name: n, port: p, driver })) return { kind: 'virtual', connectionType: 'Virtual / PDF', isWifi: false, isWired: false };
  if (/^\\\\/.test(n) || /^\\\\/.test(p) || /point and print/i.test(driver)) {
    return { kind: 'shared', connectionType: 'Shared Network Printer', isWifi: true, isWired: false };
  }
  if (/^(USB|DOT4|LPT|COM|BRUSB|EPUSB|CNUSB|CNBJNP[_-]?USB|MFPUSB|HPUSB)\d*/i.test(p) || /^HPUSB|usb/i.test(p) || /\busb\b/i.test(n)) {
    return { kind: 'usb', connectionType: 'Wired USB Cable', isWifi: false, isWired: true };
  }
  if (/^(IP_|TCP|LPR|RAW)/i.test(p) || /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(p)) {
    const isLan = /\b(ethernet|lan)\b/i.test(n);
    return { kind: isLan ? 'ethernet' : 'tcpip', connectionType: isLan ? 'Ethernet / LAN' : 'TCP/IP Network', isWifi: true, isWired: false };
  }
  if (/^(WSD|IPP|BRW|CNB)/i.test(p) || /^https?:/i.test(p) || /wifi|wireless/i.test(n)) {
    return { kind: 'wifi', connectionType: 'WiFi / Wireless Network', isWifi: true, isWired: false };
  }
  if (/^(NPI|HP[0-9A-F]{6}|BRN|EP[0-9A-F]{6}|EPSON)/i.test(p) || /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(p) || /network/i.test(n)) {
    return { kind: 'ethernet', connectionType: 'Ethernet / Network', isWifi: true, isWired: false };
  }
  if (shared) return { kind: 'shared', connectionType: 'Shared Network Printer', isWifi: true, isWired: false };
  return { kind: 'local', connectionType: 'Local Spooler', isWifi: false, isWired: false };
}

// Display-only guess from the model name, used until the driver is probed. It errs on "no": a mono
// laser such as the HP LaserJet 1020 must never be advertised as colour or two-sided.
export function guessCapabilities(name = '', driver = '') {
  const text = `${name} ${driver}`;
  const mono = /mono|black|\bB&?W\b/i.test(text) || (/laser|LBP|HL-|\bML-|SCX|imageCLASS/i.test(text) && !/colou?r|\bCP\d|\bCM\d|\bM[2-4]5\d|\bM[2-4]8\d|\bM47\d|\bMFC-L3|\bHL-L3|\bDCP-L3/i.test(text));
  const color = !mono && /colou?r|DeskJet|OfficeJet|ENVY|Ink ?Tank|Smart ?Tank|PIXMA|MAXIFY|EcoTank|Epson|Photo|\bDCP-T|\bMFC-T|\bDCP-J|\bMFC-J|\bG\d{4}\b|\bL\d{3,4}\b/i.test(text);
  const duplex = /duplex/i.test(text) || /\d+[a-z]*d[nw]?\b/i.test(name);
  return { color, duplex };
}

export async function probePrinterCapabilities(names) {
  const list = [...new Set((Array.isArray(names) ? names : [names]).map(n => String(n ?? '').trim()).filter(Boolean))].slice(0, 50);
  const result = new Map();
  if (process.platform !== 'win32' || !list.length) return result;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 15000,
      windowsHide: true,
      env: { ...process.env, SMARTPRINT_PRINTER_NAMES: JSON.stringify(list) }
    });
    const parsed = JSON.parse(stdout.trim() || '[]');
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (item && typeof item.name === 'string' && typeof item.color === 'boolean' && typeof item.duplex === 'boolean') {
        // Drivers of simplex lasers (HP LaserJet 1020, P1108, M1005 ...) advertise *manual* duplex, which
        // needs someone to turn the paper over. Only an automatic-duplex model counts as two-sided.
        const automaticDuplex = guessCapabilities(item.name).duplex || guessCapabilities(String(item.driver || '')).duplex;
        result.set(item.name, {
          color: item.color,
          duplex: item.duplex && automaticDuplex,
          paperSizes: normalizePaperSizes(item.paperSizes),
          resolutionDpi: Number.isFinite(Number(item.resolutionDpi)) && Number(item.resolutionDpi) > 0 ? Number(item.resolutionDpi) : null
        });
      }
    }
  } catch {}
  return result;
}
