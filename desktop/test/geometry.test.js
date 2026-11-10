'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../src/shared/geometry');

// Geometry of an arbitrary pack: 1200x1600 canvas, feet at y=1560, figure
// spans x 300..900 and y 80..1560. Nothing here depends on a specific image.
const geom = { canvasW: 1200, canvasH: 1600, anchorX: 600, footY: 1560, figureTop: 80, figureLeft: 300, figureRight: 900 };
const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 2560, height: 1400 };

test('layout keeps aspect ratio, never crops the canvas, and centres the feet', () => {
  const L = g.computeLayout(geom, 260);
  assert.ok(Math.abs(L.img.w / L.img.h - 1200 / 1600) < 1e-9);  // uniform scale
  assert.ok(L.img.x >= 0 && L.img.y >= 0);
  assert.ok(L.img.x + L.img.w <= L.winW && L.img.y + L.img.h <= L.winH);
  assert.equal(L.foot.x, L.winW / 2);
  assert.ok(Math.abs(L.fig.h - 260) < 1e-9);
});

test('there is room for bubbles above the head', () => {
  const L = g.computeLayout(geom, 260);
  assert.ok(L.fig.y >= g.BUBBLE_SPACE - 1e-9);
});

test('a wide canvas widens the window instead of cropping', () => {
  const wide = { ...geom, canvasW: 3000, anchorX: 1500, figureLeft: 1200, figureRight: 1800 };
  const L = g.computeLayout(wide, 260);
  assert.ok(L.img.x >= 0 && L.img.x + L.img.w <= L.winW);
});

test('changing size keeps the feet at the same screen point', () => {
  const L1 = g.computeLayout(geom, 260);
  const L2 = g.computeLayout(geom, 360);
  const foot = { x: 1500, y: 1000 };
  assert.deepEqual(g.footFromPos(g.posFromFoot(foot, L1), L1), foot);
  assert.deepEqual(g.footFromPos(g.posFromFoot(foot, L2), L2), foot);
});

test('height is clamped', () => {
  assert.equal(g.computeLayout(geom, 10).figureHeight, g.MIN_HEIGHT);
  assert.equal(g.computeLayout(geom, 9999).figureHeight, g.MAX_HEIGHT);
  assert.equal(g.computeLayout(geom, 'abc').figureHeight, 260);
});

test('the transparent margin may go off-screen while the figure is visible', () => {
  const L = g.computeLayout(geom, 260);
  const pos = { x: -L.fig.x, y: 300 };
  assert.equal(g.visibleFraction(pos, L, [primary]), 1);
  assert.equal(g.clampAfterDrag(pos, L, [primary]).moved, false);
});

test('dragging mostly off-screen snaps the figure fully back', () => {
  const L = g.computeLayout(geom, 260);
  const pos = { x: 1920 - L.fig.x - L.fig.w * 0.2, y: 300 };
  const r = g.clampAfterDrag(pos, L, [primary]);
  assert.equal(r.moved, true);
  assert.equal(g.visibleFraction(r.pos, L, [primary]), 1);
});

test('a figure straddling two monitors counts both parts', () => {
  const L = g.computeLayout(geom, 260);
  const pos = { x: 1920 - L.fig.x - L.fig.w / 2, y: 300 };
  assert.equal(g.visibleFraction(pos, L, [primary, second]), 1);
});

test('position on an unplugged monitor recovers to the primary bottom-right', () => {
  const L = g.computeLayout(geom, 260);
  const r = g.validateOrRecover({ x: 2500, y: 600 }, L, [primary], primary);
  assert.equal(r.recovered, true);
  const c = g.figScreenRect(r.pos, L);
  assert.ok(Math.abs(c.x + c.width - (1920 - 24)) <= 1);
  assert.ok(Math.abs(c.y + c.height - (1040 - 24)) <= 1);
});

test('missing or garbage saved positions recover; negative-coordinate monitors work', () => {
  const L = g.computeLayout(geom, 260);
  assert.equal(g.validateOrRecover(null, L, [primary], primary).recovered, true);
  assert.equal(g.validateOrRecover({ x: NaN, y: 1 }, L, [primary], primary).recovered, true);
  const left = { x: -1280, y: 0, width: 1280, height: 984 };
  assert.equal(g.validateOrRecover({ x: -900, y: 100 }, L, [primary, left], primary).recovered, false);
});

test('bubble opens towards the larger free side', () => {
  const L = g.computeLayout(geom, 260);
  assert.equal(g.bubbleSide({ x: 1400, y: 300 }, L, [primary]), 'left');
  assert.equal(g.bubbleSide({ x: 0, y: 300 }, L, [primary]), 'right');
});
