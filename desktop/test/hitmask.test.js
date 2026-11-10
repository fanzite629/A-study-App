'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMaskFromPixels, alphaStats, hitAt } = require('../src/shared/hitmask');

function pixels(w, h, on) {
  const a = new Uint8Array(w * h * 4);
  for (const [x, y, alpha] of on) a[(y * w + x) * 4 + 3] = alpha;
  return a;
}

test('opaque pixels hit, transparent pixels pass through', () => {
  const m = buildMaskFromPixels(pixels(40, 40, [[20, 20, 255]]), 40, 40, { block: 4, dilatePx: 0 });
  assert.equal(hitAt(m, 20.5 / 40, 20.5 / 40), true);
  assert.equal(hitAt(m, 2 / 40, 2 / 40), false);
});

test('a 1-px strand survives block downsampling (max alpha per block)', () => {
  const on = []; for (let y = 0; y < 40; y++) on.push([13, y, 255]);
  const m = buildMaskFromPixels(pixels(40, 40, on), 40, 40, { block: 4, dilatePx: 0 });
  assert.equal(hitAt(m, 13 / 40, 0.5), true);
});

test('faint edge pixels below the threshold pass through', () => {
  const m = buildMaskFromPixels(pixels(40, 40, [[20, 20, 30]]), 40, 40, { block: 4, threshold: 40, dilatePx: 0 });
  assert.equal(hitAt(m, 20.5 / 40, 20.5 / 40), false);
});

test('dilation grows the hit area by about dilatePx canvas pixels', () => {
  const m = buildMaskFromPixels(pixels(40, 40, [[20, 20, 255]]), 40, 40, { block: 4, dilatePx: 4 });
  assert.equal(hitAt(m, 17 / 40, 20.5 / 40), true);  // one cell left
  assert.equal(hitAt(m, 10 / 40, 20.5 / 40), false); // well outside
});

test('alphaStats finds the figure box and detects missing transparency', () => {
  const s = alphaStats(pixels(10, 10, [[2, 3, 255], [7, 8, 255]]), 10, 10);
  assert.deepEqual(s.bbox, { left: 2, top: 3, right: 8, bottom: 9 });
  assert.equal(s.cornersTransparent, true);
  const opaque = new Uint8Array(4 * 4 * 4).fill(255);
  const o = alphaStats(opaque, 4, 4);
  assert.equal(o.cornersTransparent, false);
  assert.equal(o.clearFraction, 0);
  assert.equal(alphaStats(new Uint8Array(16), 2, 2).bbox, null);
});

test('out-of-range coordinates never hit', () => {
  const m = buildMaskFromPixels(pixels(4, 4, [[0, 0, 255]]), 4, 4, { block: 1, dilatePx: 0 });
  assert.equal(hitAt(m, -0.1, 0), false);
  assert.equal(hitAt(m, 1, 0), false);
  assert.equal(hitAt(null, 0.5, 0.5), false);
});
