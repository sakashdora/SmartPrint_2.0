// Connector settings (settings.json). One PC can print for several printers, each with its own device key:
//   { Url, Printers: [{ Name, Token }], Token, Printer, ProcessorSecret, ... }
// `Token` / `Printer` mirror the first printer so older tools and an older connector keep working. A file written by
// the single-printer connector ({ Url, Token, Printer }) is read as one printer; nothing is lost when it is upgraded.
const stripSlash = value => String(value ?? '').trim().replace(/\/+$/, '');
const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

export function normalizeConfig(cfg = {}) {
  const printers = [], seen = new Set();
  const add = (name, token, allowEmptyName = false) => {
    name = String(name ?? '').trim(); token = String(token ?? '').trim();
    if (!token || (!name && !allowEmptyName)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key); printers.push({ Name: name, Token: token });
  };
  if (Array.isArray(cfg.Printers)) for (const p of cfg.Printers) add(p?.Name, p?.Token);
  // Single-printer file: the printer may be unnamed (the connector then picks the Windows default).
  else if (cfg.Token) add(cfg.Printer, cfg.Token, true);
  return { ...cfg, Url: cfg.Url ? stripSlash(cfg.Url) : cfg.Url, Printers: printers };
}

const withLegacyFields = cfg => ({ ...cfg, Token: cfg.Printers[0]?.Token ?? '', Printer: cfg.Printers[0]?.Name ?? '' });

// Adds or re-links one printer. Linking to a different SmartPrint server or shop replaces every other printer,
// because the existing ones belong to the old server/shop.
export function upsertPrinter(cfg, { url, name, token, shopId = null, shopName = null }) {
  const current = normalizeConfig(cfg), target = stripSlash(url);
  if (!name || !token) throw new Error('A printer name and device key are required.');
  const sameServer = !current.Url || stripSlash(current.Url) === target;
  const sameShop = !current.ShopId || !shopId || current.ShopId === shopId;
  const kept = (sameServer && sameShop) ? current.Printers.filter(p => p.Name && !sameName(p.Name, name)) : [];
  return withLegacyFields({
    ...current,
    Url: target,
    ShopId: shopId || (sameServer ? current.ShopId : null) || null,
    ShopName: shopName || (sameServer && sameShop ? current.ShopName : null) || null,
    Printers: [...kept, { Name: String(name).trim(), Token: token }],
    LastUpdated: new Date().toISOString()
  });
}

export function removePrinter(cfg, name) {
  const current = normalizeConfig(cfg);
  return withLegacyFields({ ...current, Printers: current.Printers.filter(p => !sameName(p.Name, name)), LastUpdated: new Date().toISOString() });
}

// Renames an entry after Windows resolved the configured name to the installed one.
export function renamePrinter(cfg, from, to) {
  const current = normalizeConfig(cfg);
  return withLegacyFields({ ...current, Printers: current.Printers.map(p => sameName(p.Name, from) ? { ...p, Name: to } : p) });
}
