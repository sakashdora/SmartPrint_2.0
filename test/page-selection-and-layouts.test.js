import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { validateOptions, selectedPages, price, PAGES_PER_SIDE } from '../server/print-options.js';
import { prepare } from '../server/printing.js';
import { countSelectedPages, estimatePrint, PAGES_PER_SIDE as CLIENT_PAGES_PER_SIDE } from '../public/customer.js';

const source = async pages => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595.28, 841.89]).drawText(`page ${i + 1}`, { x: 50, y: 700, size: 24 });
  return { data: Buffer.from(await doc.save()).toString('base64') };
};

test('page selection: all, odd, even and ranges', () => {
  assert.deepEqual(selectedPages('', 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(selectedPages('all', 3), [0, 1, 2]);
  assert.deepEqual(selectedPages('ALL', 3), [0, 1, 2]);
  assert.deepEqual(selectedPages('odd', 5), [0, 2, 4], 'pages 1, 3, 5');
  assert.deepEqual(selectedPages('Odd', 4), [0, 2]);
  assert.deepEqual(selectedPages('even', 5), [1, 3], 'pages 2, 4');
  assert.deepEqual(selectedPages('even', 2), [1]);
  assert.deepEqual(selectedPages('1', 9), [0], 'one page');
  assert.deepEqual(selectedPages('1-2', 9), [0, 1], 'two pages');
  assert.deepEqual(selectedPages('3, 1-2, 2', 9), [0, 1, 2], 'sorted and de-duplicated');
  assert.deepEqual(selectedPages('odd', 1), [0]);
  assert.throws(() => selectedPages('even', 1), /only one page/);
  assert.throws(() => selectedPages('0-2', 5), /between 1 and 5/);
  assert.throws(() => selectedPages('4-9', 5), /between 1 and 5/);
  assert.throws(() => selectedPages('3-1', 5));
  assert.throws(() => selectedPages('odds', 5), /page range/i);
  assert.throws(() => selectedPages('1,'.repeat(300), 5), /too long/);
});

test('layouts: four-up is accepted, unknown layouts are not, and pricing follows pages per sheet', () => {
  assert.equal(validateOptions({ layout: 'four' }).layout, 'four');
  assert.throws(() => validateOptions({ layout: 'six' }));
  assert.throws(() => validateOptions({ layout: 'card', duplex: true }), /one side/);
  const rates = { bw: 200, color: 1000 };
  assert.deepEqual(price(10, validateOptions({ layout: 'four' }), rates), { sides: 3, sheets: 3, amount: 600 });
  assert.deepEqual(price(10, validateOptions({ layout: 'four', duplex: true, copies: 2 }), rates), { sides: 6, sheets: 4, amount: 1200 });
  assert.deepEqual(price(1, validateOptions({ layout: 'four' }), rates), { sides: 1, sheets: 1, amount: 200 });
  assert.deepEqual(price(5, validateOptions({ layout: 'two', duplex: true, copies: 2 }), rates), { sides: 6, sheets: 4, amount: 1200 }, 'existing two-up pricing is unchanged');
});

test('prepare: four-up puts four pages on each A4 side; odd/even/ranges choose the pages that are charged', async () => {
  const run = async (pages, options) => prepare([await source(pages)], validateOptions(options));
  let result = await run(9, { layout: 'four' });
  assert.deepEqual([result.pages, result.outputPages], [9, 3], '9 pages -> 4 + 4 + 1');
  result = await run(8, { layout: 'four', range: 'odd' });
  assert.deepEqual([result.pages, result.outputPages], [4, 1], 'pages 1, 3, 5, 7 fill one sheet');
  result = await run(8, { layout: 'single', range: 'even' });
  assert.deepEqual([result.pages, result.outputPages], [4, 4]);
  result = await run(6, { layout: 'two', range: '1-2' });
  assert.deepEqual([result.pages, result.outputPages], [2, 1]);
  result = await run(6, { range: '1' });
  assert.deepEqual([result.pages, result.outputPages], [1, 1]);
  await assert.rejects(run(1, { range: 'even' }), /only one page/);
  const output = await PDFDocument.load((await run(5, { layout: 'four' })).bytes);
  const [first, second] = output.getPages();
  assert.deepEqual([first.getWidth().toFixed(2), first.getHeight().toFixed(2)], ['595.28', '841.89'], 'output is A4');
  assert.ok(first && second);
});

test('what the customer sees is what the server charges', async () => {
  assert.deepEqual(CLIENT_PAGES_PER_SIDE, PAGES_PER_SIDE, 'browser and server use the same pages-per-sheet table');
  const rates = { bw: 200, color: 1000 };
  const ranges = ['', 'all', '1', '1-2', 'odd', 'even', '2-4', '1, 3, 5-6', '7'];
  let compared = 0;
  for (const total of [1, 2, 3, 7, 12]) for (const range of ranges) for (const layout of ['single', 'two', 'four']) for (const duplex of [false, true]) for (const color of ['bw', 'color']) for (const copies of [1, 3]) {
    let serverPages;
    try { serverPages = selectedPages(range, total).length; } catch { serverPages = null; }
    const client = countSelectedPages(range, total);
    if (serverPages === null) { assert.ok(client.error, `client flags the same bad range "${range}" of ${total}`); continue; }
    assert.equal(client.error, null);
    assert.equal(client.count, serverPages, `pages for "${range}" of ${total}`);
    const options = validateOptions({ layout, duplex, color, copies });
    const expected = price(serverPages, options, rates);
    assert.deepEqual(estimatePrint(client.count, { layout, duplex, copies, color }, rates), expected, `${total}p ${range} ${layout} duplex=${duplex} ${color} x${copies}`);
    compared++;
  }
  assert.ok(compared > 500, `compared ${compared} combinations`);
});

test('client page counting handles unknown totals and typing mistakes without throwing', () => {
  assert.deepEqual(countSelectedPages('1-3', null), { count: null, error: null });
  assert.deepEqual(countSelectedPages('1-3', 0), { count: null, error: null });
  assert.match(countSelectedPages('1-', 5).error, /Type pages/);
  assert.match(countSelectedPages('abc', 5).error, /Type pages/);
  assert.match(countSelectedPages('9', 5).error, /between 1 and 5/);
  assert.match(countSelectedPages('even', 1).error, /only one page/);
  assert.equal(countSelectedPages(' 2 - 4 ', 5).count, 3);
  assert.equal(countSelectedPages('ODD', 5).count, 3);
});
