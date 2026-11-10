'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateManifest, isSafeRelativePath } = require('../src/shared/pack');
const { resolveState, assetStateFor, STATES } = require('../src/shared/states');

const good = () => ({
  format: 'tplan-character-pack',
  formatVersion: 1,
  id: 'my-pet',
  name: '测试角色',
  version: '1.0.0',
  canvas: { width: 1200, height: 1600 },
  anchor: { x: 600, footY: 1560 },
  states: { idle: { type: 'static', src: 'states/idle.png' } },
});

test('a minimal pack with only idle is valid and reports the missing states', () => {
  const r = validateManifest(good());
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.manifest.display.defaultHeight, 260);
  assert.equal(r.manifest.hit.alphaThreshold, 40);
  assert.ok(r.warnings.some((w) => w.includes('focus')));
});

test('idle is required', () => {
  const m = good(); m.states = { focus: 'focus.png' };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('idle')));
});

test('wrong format, future version and bad anchor are errors', () => {
  assert.equal(validateManifest({ ...good(), format: 'x' }).ok, false);
  const v = validateManifest({ ...good(), formatVersion: 2 });
  assert.equal(v.ok, false);
  assert.ok(v.errors[0].includes('高于'));
  assert.equal(validateManifest({ ...good(), anchor: { x: 600, footY: 5000 } }).ok, false);
});

test('paths that escape the pack folder are rejected', () => {
  assert.equal(isSafeRelativePath('states/idle.png'), true);
  assert.equal(isSafeRelativePath('../idle.png'), false);
  assert.equal(isSafeRelativePath('C:\\x.png'), false);
  assert.equal(isSafeRelativePath('/etc/x.png'), false);
  const m = good(); m.states.idle.src = '../../secret.png';
  assert.equal(validateManifest(m).ok, false);
  const m2 = good(); m2.states.focus = { src: '../x.png' };
  const r2 = validateManifest(m2);
  assert.equal(r2.ok, true);
  assert.equal(r2.manifest.states.focus, undefined);
});

test('reserved animation types are accepted but fall back to idle for now', () => {
  const m = good();
  m.states.focus = { type: 'sequence', frames: ['f1.png'], fps: 8 };
  const r = validateManifest(m);
  assert.equal(r.ok, true);
  assert.equal(r.manifest.states.focus, undefined);
  assert.ok(r.warnings.some((w) => w.includes('sequence')));
});

test('unknown state names are ignored with a warning; string shorthand works', () => {
  const m = good();
  m.states.dance = 'dance.png';
  m.states.done = 'done.png';
  const r = validateManifest(m);
  assert.equal(r.ok, true);
  assert.equal(r.manifest.states.done.src, 'done.png');
  assert.ok(r.warnings.some((w) => w.includes('dance')));
});

test('state priority: dragging > done > timeUp > reminder > rest > focus > thinking > idle', () => {
  assert.equal(resolveState({}), 'idle');
  assert.equal(resolveState({ cardOpen: true }), 'thinking');
  assert.equal(resolveState({ timerPhase: 'running', cardOpen: true }), 'focus');
  assert.equal(resolveState({ timerPhase: 'paused' }), 'idle');
  assert.equal(resolveState({ resting: true }), 'rest');
  assert.equal(resolveState({ timerPhase: 'running', reminderOpen: true }), 'reminder');
  assert.equal(resolveState({ timerPhase: 'due', reminderOpen: true }), 'timeUp');
  assert.equal(resolveState({ timerPhase: 'due', doneFlash: true }), 'done');
  assert.equal(resolveState({ timerPhase: 'running', dragging: true }), 'dragging');
  // Releasing a drag returns to the state the business data implies.
  assert.equal(resolveState({ timerPhase: 'running', dragging: false }), 'focus');
});

test('missing state assets fall back to idle', () => {
  const avail = { idle: {}, focus: {} };
  assert.equal(assetStateFor('focus', avail), 'focus');
  for (const s of STATES.filter((x) => x !== 'idle' && x !== 'focus')) assert.equal(assetStateFor(s, avail), 'idle');
});

test('the documented pack template manifest is valid', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', '..', 'docs', 'desktop-pet', 'pack-template', 'manifest.json');
  const r = validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('the dev test pack manifest is valid', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'dev-fixtures', 'test-pack', 'manifest.json');
  const r = validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(r.ok, true, r.errors.join('\n'));
});
