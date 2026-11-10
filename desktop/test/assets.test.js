'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { validateManifest } = require('../src/shared/pack');
const { alphaStats, buildMaskFromPixels, hitAt } = require('../src/shared/hitmask');
const dir = path.join(__dirname, '../assets/characters/warm-scholar');
test('bundled nine-state character pack decodes, has alpha, and yields usable hit masks', () => {
  const result = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'))));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.warnings, []);
  assert.equal(Object.keys(result.manifest.states).length, 9);
  for (const [state, asset] of Object.entries(result.manifest.states)) {
    const png = PNG.sync.read(fs.readFileSync(path.join(dir, asset.src)));
    assert.equal(png.width, 1024, state);
    assert.equal(png.height, 1536, state);
    const stats = alphaStats(png.data, png.width, png.height, 40);
    assert.ok(stats.cornersTransparent, state);
    assert.ok(stats.clearFraction > 0.12, state);
    assert.ok(stats.bbox.bottom <= 1536 && stats.bbox.top < 180, state);
    const mask = buildMaskFromPixels(png.data, png.width, png.height, { threshold: 40, dilatePx: 4 });
    assert.equal(hitAt(mask, 0, 0), false, state);
    assert.equal(hitAt(mask, 0.5, 0.4), true, state);
  }
});
