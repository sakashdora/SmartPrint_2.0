// How many source pages land on one printed side. "card" is two images on one side, handled separately.
export const PAGES_PER_SIDE = Object.freeze({ single: 1, two: 2, four: 4, card: 1 });
export const LAYOUTS = Object.keys(PAGES_PER_SIDE);

export function validateOptions(input = {}) {
  const result = { color: input.color ?? 'bw', duplex: input.duplex ?? false, layout: input.layout ?? 'single', copies: Number(input.copies ?? 1), range: String(input.range ?? '').trim(), rotate: Number(input.rotate ?? 0), enhance: input.enhance ?? false, smartCrop: input.smartCrop ?? false, crop: Number(input.crop ?? 0) };
  if (!['bw', 'color'].includes(result.color) || !LAYOUTS.includes(result.layout) || typeof result.duplex !== 'boolean' || !Number.isInteger(result.copies) || result.copies < 1 || result.copies > 100 || ![0, 90, 180, 270].includes(result.rotate) || typeof result.enhance !== 'boolean' || typeof result.smartCrop !== 'boolean' || !Number.isFinite(result.crop) || result.crop < 0 || result.crop > 20) throw new Error('Choose valid print settings (1–100 copies; crop 0–20%).');
  if (result.layout === 'card' && result.duplex) throw new Error('Card pair uses one side of the sheet. Select single-sided.');
  return result;
}
// range: "" or "all" (every page), "odd" (1, 3, 5 ...), "even" (2, 4, 6 ...) or a list such as "1-3, 5".
export function selectedPages(range, count) {
  const word = String(range ?? '').trim().toLowerCase();
  if (!word || word === 'all') return Array.from({ length: count }, (_, i) => i);
  if (word === 'odd') return Array.from({ length: Math.ceil(count / 2) }, (_, i) => i * 2);
  if (word === 'even') {
    if (count < 2) throw new Error('This document has only one page, so there are no even pages to print.');
    return Array.from({ length: Math.floor(count / 2) }, (_, i) => i * 2 + 1);
  }
  const result = new Set();
  if (range.length > 500) throw new Error('Page range is too long.');
  for (const part of range.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error('Use a page range such as 1-3, 5.');
    const first = Number(match[1]), last = Number(match[2] ?? first);
    if (first < 1 || last > count || first > last) throw new Error(`Choose pages between 1 and ${count}.`);
    for (let n = first; n <= last; n++) result.add(n - 1);
  }
  return [...result].sort((a, b) => a - b);
}
export function price(pages, options, rates) {
  const sidesPerCopy = options.layout === 'card' ? 1 : Math.ceil(pages / PAGES_PER_SIDE[options.layout]);
  const sides = sidesPerCopy * options.copies;
  return { sides, sheets: Math.ceil(sidesPerCopy / (options.duplex ? 2 : 1)) * options.copies, amount: sides * (options.color === 'color' ? rates.color : rates.bw) };
}
