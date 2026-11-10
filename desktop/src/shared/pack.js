'use strict';
// Validation and normalisation of a character resource pack manifest.
// Pure: no file system access. The main process loads files separately and
// reports image problems per state.

const { STATES } = require('./states');

const FORMAT = 'tplan-character-pack';
const FORMAT_VERSION = 1;
const SUPPORTED_TYPES = ['static'];             // implemented now
const RESERVED_TYPES = ['sequence', 'layered']; // accepted in manifests, not rendered yet

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;

/** Reject absolute paths, drive letters, and any `..` segment. */
function isSafeRelativePath(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('/') || p.startsWith('\\')) return false;
  return !p.split(/[\\/]+/).some((seg) => seg === '..');
}

/**
 * @param {unknown} raw  parsed manifest.json
 * @returns {{ok:boolean, errors:string[], warnings:string[], manifest:object|null}}
 */
function validateManifest(raw) {
  const errors = [];
  const warnings = [];
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!m) return { ok: false, errors: ['manifest.json 的内容必须是一个 JSON 对象'], warnings, manifest: null };

  if (m.format !== FORMAT) errors.push(`format 应为 "${FORMAT}"，实际为 ${JSON.stringify(m.format)}`);
  if (!Number.isInteger(m.formatVersion)) errors.push('缺少整数字段 formatVersion');
  else if (m.formatVersion > FORMAT_VERSION) {
    errors.push(`formatVersion ${m.formatVersion} 高于程序支持的 ${FORMAT_VERSION}，请更新 T计划`);
  }
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(m.id)) {
    errors.push('id 必须是小写字母、数字、点、下划线或连字符组成的字符串（≤64 字符）');
  }
  if (typeof m.name !== 'string' || !m.name.trim()) errors.push('缺少 name（资源包显示名称）');
  if (typeof m.version !== 'string' || !m.version.trim()) errors.push('缺少 version（资源包版本号，例如 "1.0.0"）');

  const canvas = m.canvas || {};
  if (!isPosInt(canvas.width) || !isPosInt(canvas.height)) {
    errors.push('canvas.width / canvas.height 必须是正整数（像素）');
  }

  const anchor = m.anchor || {};
  if (!isNum(anchor.x) || !isNum(anchor.footY)) {
    errors.push('anchor.x / anchor.footY 必须是数字（画布像素坐标）');
  } else if (isPosInt(canvas.width) && isPosInt(canvas.height)) {
    if (anchor.x < 0 || anchor.x > canvas.width) errors.push('anchor.x 超出画布宽度');
    if (anchor.footY <= 0 || anchor.footY > canvas.height) errors.push('anchor.footY 超出画布高度');
  }

  const display = m.display || {};
  let figureTop = null;
  if (display.figureTop !== undefined) {
    if (!isNum(display.figureTop) || display.figureTop < 0 || (isNum(anchor.footY) && display.figureTop >= anchor.footY)) {
      errors.push('display.figureTop 必须是小于 anchor.footY 的非负数字');
    } else figureTop = display.figureTop;
  }
  const defaultHeight = display.defaultHeight === undefined ? 260 : display.defaultHeight;
  if (!isNum(defaultHeight) || defaultHeight < 120 || defaultHeight > 600) {
    errors.push('display.defaultHeight 必须是 120–600 之间的数字（屏幕上人物高度，DIP）');
  }

  const hit = m.hit || {};
  const alphaThreshold = hit.alphaThreshold === undefined ? 40 : hit.alphaThreshold;
  const dilatePx = hit.dilatePx === undefined ? 8 : hit.dilatePx;
  if (!Number.isInteger(alphaThreshold) || alphaThreshold < 1 || alphaThreshold > 254) {
    errors.push('hit.alphaThreshold 必须是 1–254 的整数');
  }
  if (!isNum(dilatePx) || dilatePx < 0 || dilatePx > 64) errors.push('hit.dilatePx 必须是 0–64 的数字（画布像素）');

  const states = {};
  const rawStates = m.states && typeof m.states === 'object' ? m.states : null;
  if (!rawStates) errors.push('缺少 states 对象');
  else {
    for (const [name, def] of Object.entries(rawStates)) {
      if (!STATES.includes(name)) {
        warnings.push(`未知状态 "${name}" 已忽略（支持：${STATES.join(', ')}）`);
        continue;
      }
      const d = typeof def === 'string' ? { type: 'static', src: def } : def;
      if (!d || typeof d !== 'object') { warnings.push(`状态 ${name} 的定义无效，将回退到 idle`); continue; }
      const type = d.type || 'static';
      if (RESERVED_TYPES.includes(type)) {
        warnings.push(`状态 ${name} 使用 "${type}" 类型，当前版本尚未支持，暂时显示 idle`);
        continue;
      }
      if (!SUPPORTED_TYPES.includes(type)) { warnings.push(`状态 ${name} 的类型 "${type}" 无法识别，将回退到 idle`); continue; }
      if (!isSafeRelativePath(d.src)) {
        const msg = `状态 ${name} 的 src 必须是资源包内的相对路径（不能是绝对路径或包含 ..）`;
        if (name === 'idle') errors.push(msg); else { warnings.push(msg + '，将回退到 idle'); }
        continue;
      }
      states[name] = { type, src: d.src.replace(/\\/g, '/') };
    }
    if (!states.idle && !errors.some((e) => e.includes('idle'))) errors.push('缺少必需的默认状态 states.idle');
  }

  if (errors.length) return { ok: false, errors, warnings, manifest: null };

  const missing = STATES.filter((s) => !['idle','blink'].includes(s) && !states[s]);
  if (missing.length) warnings.push(`以下状态没有素材，将显示 idle：${missing.join(', ')}`);

  return {
    ok: true,
    errors,
    warnings,
    manifest: {
      format: FORMAT,
      formatVersion: m.formatVersion,
      id: m.id,
      name: m.name.trim(),
      version: m.version.trim(),
      author: typeof m.author === 'string' ? m.author : '',
      canvas: { width: canvas.width, height: canvas.height },
      anchor: { x: anchor.x, footY: anchor.footY },
      display: { defaultHeight, figureTop },
      hit: { alphaThreshold, dilatePx },
      states,
    },
  };
}

module.exports = { FORMAT, FORMAT_VERSION, SUPPORTED_TYPES, RESERVED_TYPES, validateManifest, isSafeRelativePath };
