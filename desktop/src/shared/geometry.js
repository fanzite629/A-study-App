'use strict';
// Pure layout and screen-clamping logic for the pet window.
// All screen coordinates are Electron DIP (device-independent pixels).
// Character geometry comes from the loaded resource pack (canvas size, foot
// anchor, measured figure box) — nothing here is tied to a particular image.

const MIN_WIN_W_RATIO = 2.4;  // window at least 2.4 x figure height wide (room for bubbles; the extra area is click-through)
const BOTTOM_PAD = 6;         // gap between canvas bottom and window bottom
const BUBBLE_SPACE = 150;     // free DIP above the head reserved for bubbles
const MIN_VISIBLE = 0.6;      // at least 60% of the figure must stay on a work area
const EDGE_MARGIN = 24;       // margin used when recovering to a screen corner
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;

function clampHeight(h, fallback = 260) {
  const n = Math.round(Number(h));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, n));
}

/**
 * @typedef {object} PackGeometry  (canvas pixel units)
 * @property {number} canvasW
 * @property {number} canvasH
 * @property {number} anchorX     x of the foot anchor
 * @property {number} footY       y of the feet baseline
 * @property {number} figureTop   top of the visible figure (head/ornaments)
 * @property {number} figureLeft  left edge of the visible figure
 * @property {number} figureRight right edge of the visible figure
 */

/**
 * Compute window size, image placement and figure rectangle (window coords).
 * `figureHeight` is the on-screen height from figureTop to footY, in DIP.
 * The whole canvas always fits inside the window (nothing is cropped) and the
 * image keeps its aspect ratio (one uniform scale factor).
 */
function computeLayout(geom, figureHeight) {
  const h = clampHeight(figureHeight);
  const s = h / (geom.footY - geom.figureTop);           // canvas px -> DIP
  const imgW = geom.canvasW * s;
  const imgH = geom.canvasH * s;
  // Window is symmetric around the anchor so the feet stay centred.
  const halfSpan = Math.max(geom.anchorX, geom.canvasW - geom.anchorX) * s;
  const winW = Math.ceil(Math.max(h * MIN_WIN_W_RATIO, 2 * halfSpan + 2 * BOTTOM_PAD));
  const extraTop = Math.max(0, BUBBLE_SPACE - geom.figureTop * s);
  const winH = Math.ceil(extraTop + imgH + BOTTOM_PAD);
  const img = { x: winW / 2 - geom.anchorX * s, y: winH - BOTTOM_PAD - imgH, w: imgW, h: imgH };
  const foot = { x: winW / 2, y: img.y + geom.footY * s };
  const fig = {
    x: img.x + geom.figureLeft * s,
    y: img.y + geom.figureTop * s,
    w: (geom.figureRight - geom.figureLeft) * s,
    h: (geom.footY - geom.figureTop) * s,
  };
  return { figureHeight: h, scale: s, winW, winH, img, foot, fig };
}

/** Window top-left for a given screen position of the foot anchor. */
function posFromFoot(foot, layout) {
  return { x: Math.round(foot.x - layout.foot.x), y: Math.round(foot.y - layout.foot.y) };
}
/** Screen position of the foot anchor for a window at `pos`. */
function footFromPos(pos, layout) {
  return { x: Math.round(pos.x + layout.foot.x), y: Math.round(pos.y + layout.foot.y) };
}

function intersectArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function figScreenRect(pos, layout) {
  return { x: pos.x + layout.fig.x, y: pos.y + layout.fig.y, width: layout.fig.w, height: layout.fig.h };
}

/** Fraction (0..1) of the figure that lies on any display work area. */
function visibleFraction(pos, layout, workAreas) {
  const r = figScreenRect(pos, layout);
  const area = r.width * r.height;
  if (!area) return 0;
  const sum = workAreas.reduce((acc, wa) => acc + intersectArea(r, wa), 0);
  return Math.min(1, Math.round((sum / area) * 1e6) / 1e6);
}

function distToRect(px, py, r) {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.width));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.height));
  return Math.hypot(dx, dy);
}

function nearestWorkArea(pos, layout, workAreas) {
  const r = figScreenRect(pos, layout);
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  let best = workAreas[0], bd = Infinity;
  for (const wa of workAreas) {
    const d = distToRect(cx, cy, wa);
    if (d < bd) { bd = d; best = wa; }
  }
  return best;
}

/** Move the window so the whole figure fits inside `wa`. */
function fitInto(pos, layout, wa) {
  const minX = wa.x - layout.fig.x;
  const maxX = wa.x + wa.width - layout.fig.x - layout.fig.w;
  const minY = wa.y - layout.fig.y;
  const maxY = wa.y + wa.height - layout.fig.y - layout.fig.h;
  return {
    x: Math.round(Math.min(Math.max(pos.x, minX), Math.max(minX, maxX))),
    y: Math.round(Math.min(Math.max(pos.y, minY), Math.max(minY, maxY))),
  };
}

/** Bottom-right of the primary work area, used for recovery and first run. */
function recoveryPosition(layout, primaryWorkArea) {
  const wa = primaryWorkArea;
  return {
    x: Math.round(wa.x + wa.width - EDGE_MARGIN - layout.fig.x - layout.fig.w),
    y: Math.round(wa.y + wa.height - EDGE_MARGIN - layout.fig.y - layout.fig.h),
  };
}

/** After a drag: pull the figure fully into the nearest work area if < 60% visible. */
function clampAfterDrag(pos, layout, workAreas) {
  if (!workAreas.length) return { pos, moved: false };
  if (visibleFraction(pos, layout, workAreas) >= MIN_VISIBLE) return { pos, moved: false };
  const next = fitInto(pos, layout, nearestWorkArea(pos, layout, workAreas));
  return { pos: next, moved: next.x !== pos.x || next.y !== pos.y };
}

/** On startup / display change: recover to the primary corner if not visible enough. */
function validateOrRecover(pos, layout, workAreas, primaryWorkArea) {
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) &&
      visibleFraction(pos, layout, workAreas) >= MIN_VISIBLE) {
    return { pos: { x: Math.round(pos.x), y: Math.round(pos.y) }, recovered: false };
  }
  return { pos: recoveryPosition(layout, primaryWorkArea), recovered: true };
}

/** Which side bubbles open on: towards the larger free space. */
function bubbleSide(pos, layout, workAreas) {
  const wa = nearestWorkArea(pos, layout, workAreas);
  if (!wa) return 'left';
  const r = figScreenRect(pos, layout);
  return r.x + r.width / 2 > wa.x + wa.width / 2 ? 'left' : 'right';
}

module.exports = {
  MIN_VISIBLE, MIN_HEIGHT, MAX_HEIGHT, BUBBLE_SPACE,
  clampHeight, computeLayout, posFromFoot, footFromPos, intersectArea, figScreenRect,
  visibleFraction, nearestWorkArea, fitInto, recoveryPosition, clampAfterDrag, validateOrRecover, bubbleSide,
};
