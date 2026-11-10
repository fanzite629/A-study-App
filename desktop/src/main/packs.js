'use strict';
// Loads a character resource pack from disk (main process only).
// Produces everything the renderer needs: per-state image URLs, per-state hit
// masks built from the real alpha channel, and the pack geometry used by
// layout and screen clamping. Any failure is returned as readable messages —
// it never throws into the app and never touches T计划 data or the timer.

const fs = require('node:fs');
const path = require('node:path');
const { validateManifest } = require('../shared/pack');
const { STATES } = require('../shared/states');
const { buildMaskFromPixels, alphaStats } = require('../shared/hitmask');

const MANIFEST = 'manifest.json';
let loadSeq = 0;

function insideDir(dir, file) {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function parseJsonWithPosition(text) {
  try {
    return { value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (e) {
    const m = /position (\d+)/.exec(e.message);
    let where = '';
    if (m) {
      const pos = Number(m[1]);
      const line = text.slice(0, pos).split('\n').length;
      where = `（第 ${line} 行附近）`;
    }
    return { error: `manifest.json 不是有效的 JSON${where}：${e.message}` };
  }
}

/**
 * @param {string} dir  pack folder
 * @param {{nativeImage: Electron.NativeImage}} electron
 * @returns {{ok:boolean, errors:string[], warnings:string[], pack:object|null}}
 */
function loadPack(dir, { nativeImage }) {
  const errors = [];
  const warnings = [];
  const fail = (msg) => ({ ok: false, errors: [...errors, ...(msg ? [msg] : [])], warnings, pack: null });

  if (!dir) return fail('没有指定资源包文件夹');
  dir = path.resolve(dir);
  let realDir;
  try { realDir = fs.realpathSync(dir); } catch { return fail(`找不到资源包文件夹：${dir}`); }

  const mfile = path.join(realDir, MANIFEST);
  let text;
  try { text = fs.readFileSync(mfile, 'utf8'); } catch { return fail(`找不到 ${MANIFEST}：${mfile}`); }
  const parsed = parseJsonWithPosition(text);
  if (parsed.error) return fail(parsed.error);

  const v = validateManifest(parsed.value);
  warnings.push(...v.warnings);
  if (!v.ok) { errors.push(...v.errors); return fail(); }
  const m = v.manifest;

  const assets = {};
  const block = Math.max(1, Math.round(m.canvas.height / 400)); // ~400-row masks
  const stats = {};

  for (const name of STATES) {
    const def = m.states[name];
    if (!def) continue;
    const isIdle = name === 'idle';
    const problem = (msg) => {
      if (isIdle) errors.push(msg); else warnings.push(`${msg}；${name} 将显示 idle`);
    };

    let file = path.resolve(realDir, def.src);
    try { file = fs.realpathSync(file); } catch { problem(`找不到 ${name} 的图片：${def.src}`); continue; }
    if (!insideDir(realDir, file)) { problem(`${name} 的图片路径超出了资源包文件夹`); continue; }
    if (!/\.png$/i.test(file)) { problem(`${name} 的图片不是 PNG：${def.src}（当前只支持带透明通道的 PNG）`); continue; }

    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { problem(`读取 ${def.src} 失败：${e.message}`); continue; }
    // createFromBuffer uses scale factor 1, so the size is the real pixel size
    // regardless of "@2x" in the file name.
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) { problem(`无法解码 ${def.src}（文件损坏或不是 PNG）`); continue; }
    const { width: w, height: h } = img.getSize();
    if (w !== m.canvas.width || h !== m.canvas.height) {
      problem(`${def.src} 的尺寸是 ${w}×${h}，与 canvas ${m.canvas.width}×${m.canvas.height} 不一致（所有状态图必须同一画布，否则切换时会跳动）`);
      continue;
    }
    const px = img.toBitmap(); // BGRA; alpha is byte 3 of each pixel
    const st = alphaStats(px, w, h, m.hit.alphaThreshold);
    if (!st.bbox) { problem(`${def.src} 完全透明，没有可显示的人物`); continue; }
    if (!st.cornersTransparent || st.clearFraction < 0.05) {
      warnings.push(`${def.src} 看起来没有透明背景（四角不透明或几乎没有全透明像素），透明区域穿透会失效`);
    }
    stats[name] = st;
    assets[name] = {
      src: def.src,
      file,
      bytes: buf.length,
      bbox: st.bbox,
      mask: buildMaskFromPixels(px, w, h, { block, threshold: m.hit.alphaThreshold, dilatePx: m.hit.dilatePx }),
    };
  }

  if (errors.length || !assets.idle) return fail(assets.idle ? null : (errors.length ? null : 'idle 图片不可用'));

  // Feet baseline sanity check: each state's lowest visible pixel should sit
  // near anchor.footY, otherwise the figure appears to float or sink.
  const tol = Math.max(4, Math.round(m.canvas.height * 0.03));
  for (const [name, st] of Object.entries(stats)) {
    const gap = st.bbox.bottom - m.anchor.footY;
    if (Math.abs(gap) > tol) {
      warnings.push(`${name}：人物最低点 y=${st.bbox.bottom}，与 anchor.footY=${m.anchor.footY} 相差 ${gap} px，请检查脚底基准`);
    }
  }

  const idle = stats.idle.bbox;
  const figureTop = m.display.figureTop != null ? m.display.figureTop : idle.top;
  if (figureTop >= m.anchor.footY) return fail('无法确定人物高度：figureTop 不在 footY 上方');

  const id = ++loadSeq;
  return {
    ok: true,
    errors,
    warnings,
    pack: {
      loadId: id,
      dir: realDir,
      manifest: m,
      geom: {
        canvasW: m.canvas.width, canvasH: m.canvas.height,
        anchorX: m.anchor.x, footY: m.anchor.footY,
        figureTop, figureLeft: idle.left, figureRight: idle.right,
      },
      assets,
      loadedAt: Date.now(),
    },
  };
}

/** List pack folders (those containing manifest.json) directly under `root`. */
function listPacks(root) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const mf = path.join(dir, MANIFEST);
    if (!fs.existsSync(mf)) continue;
    let name = e.name, version = '';
    try {
      const j = JSON.parse(fs.readFileSync(mf, 'utf8').replace(/^﻿/, ''));
      if (typeof j.name === 'string') name = j.name;
      if (typeof j.version === 'string') version = j.version;
    } catch { /* listed anyway; loading will report the error */ }
    out.push({ dir, name, version });
  }
  return out;
}

module.exports = { loadPack, listPacks, insideDir, MANIFEST };
