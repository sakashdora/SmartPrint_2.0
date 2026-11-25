import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const tokens = read('tokens.css'), premium = read('premium.css'), design = read('design.css'), index = read('index.html');

const lightBlock = tokens.match(/^:root \{([\s\S]*?)\n\}/m)[1];
const parse = block => Object.fromEntries([...block.matchAll(/--c-([0-9a-f]{6}):\s*(#[0-9a-f]{6});/g)].map(m => [m[1], m[2]]));
const light = parse(lightBlock);

const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every colour premium.css and design.css use is defined in tokens.css', () => {
  const used = new Set([...premium.matchAll(/var\(--c-([0-9a-f]{6})\)/g)].map(m => m[1]));
  const designUsed = new Set([...design.matchAll(/var\(--c-([0-9a-f]{6})\)/g)].map(m => m[1]));
  for (const name of [...used, ...designUsed]) assert.ok(light[name], `light value for --c-${name}`);
});

test('the light theme keeps exactly the colours the interface always used', () => {
  for (const [name, value] of Object.entries(light)) assert.equal(value, `#${name}`);
});

test('light theme body text keeps strong contrast', () => {
  assert.ok(contrast(light['0f172a'], light['ffffff']) >= 15);
  assert.ok(contrast(light['64748b'], light['ffffff']) >= 4.5);
});

test('the page loads the three style layers in order, uses light colour scheme, and has a skip link', () => {
  const order = ['tokens.css', 'premium.css', 'design.css'].map(f => index.indexOf(f));
  assert.ok(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2]);
  assert.match(index, /class="skip-link"/);
  assert.match(index, /name="color-scheme" content="light"/);
});

test('the design layer keeps phones usable: 44px targets, visible focus, reduced motion, no zoom on focus', () => {
  assert.match(design, /min-height: 44px/);
  assert.match(design, /:focus-visible/);
  assert.match(design, /prefers-reduced-motion: reduce/);
  assert.match(design, /font-size: max\(16px, 1em\)/);
});
