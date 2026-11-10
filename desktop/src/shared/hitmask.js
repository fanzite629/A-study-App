'use strict';
// Alpha hit masks built from the actual loaded character image.
// Used by the main process (from nativeImage bitmaps) and by tests; the pet
// renderer only calls hitAt() on masks it receives over IPC.
(function (root) {
  /**
   * Build a hit mask from 32-bit pixel data (RGBA or BGRA — only alpha is used,
   * which is byte 3 in both layouts).
   * The image is reduced in `block` x `block` cells using the MAX alpha of each
   * cell, so thin strands never disappear; then thresholded; then dilated.
   *
   * @param {Uint8Array|Uint8ClampedArray|Buffer} px  length w*h*4
   * @param {number} w
   * @param {number} h
   * @param {{block?:number, threshold?:number, dilatePx?:number}} [opt]
   *   block: canvas px per mask cell (default 4)
   *   threshold: alpha (0-255) above which a pixel is "solid" (default 40)
   *   dilatePx: grow the solid area by this many canvas px (default 8)
   * @returns {{w:number,h:number,block:number,bits:Uint8Array}}
   */
  function buildMaskFromPixels(px, w, h, opt) {
    const block = Math.max(1, Math.round((opt && opt.block) || 4));
    const threshold = opt && opt.threshold != null ? opt.threshold : 40;
    const dilatePx = opt && opt.dilatePx != null ? opt.dilatePx : 8;
    const mw = Math.ceil(w / block), mh = Math.ceil(h / block);
    const solid = new Uint8Array(mw * mh);
    for (let y = 0; y < h; y++) {
      const row = (y / block | 0) * mw;
      for (let x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3] > threshold) solid[row + (x / block | 0)] = 1;
      }
    }
    const r = Math.ceil(dilatePx / block);
    return { w: mw, h: mh, block, bits: r > 0 ? dilate(solid, mw, mh, r) : solid };
  }

  /** Separable square dilation by r cells. */
  function dilate(src, w, h, r) {
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let on = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !on; k++) on = src[y * w + k];
        tmp[y * w + x] = on;
      }
    }
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let on = 0;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !on; k++) on = tmp[k * w + x];
        out[y * w + x] = on;
      }
    }
    return out;
  }

  /**
   * Bounding box of pixels with alpha > threshold, or null if fully transparent.
   * Also reports how many pixels are fully transparent (alpha 0), to detect
   * images exported without a transparent background.
   */
  function alphaStats(px, w, h, threshold) {
    const t = threshold != null ? threshold : 40;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, clear = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = px[(y * w + x) * 4 + 3];
        if (a <= 2) clear++; // tolerate <= 0.8% alpha quantisation in generated PNGs
        if (a > t) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]
      .map(([x, y]) => px[(y * w + x) * 4 + 3]);
    return {
      bbox: x1 < 0 ? null : { left: x0, top: y0, right: x1 + 1, bottom: y1 + 1 },
      clearFraction: clear / (w * h),
      cornersTransparent: corners.every((a) => a <= 2),
    };
  }

  /**
   * @param {{w:number,h:number,bits:Uint8Array}} mask
   * @param {number} fx  x as a fraction of the canvas width (0..1)
   * @param {number} fy  y as a fraction of the canvas height (0..1)
   */
  function hitAt(mask, fx, fy) {
    if (!mask || !(fx >= 0 && fx < 1 && fy >= 0 && fy < 1)) return false;
    const x = Math.floor(fx * mask.w), y = Math.floor(fy * mask.h);
    return mask.bits[y * mask.w + x] === 1;
  }

  const api = { buildMaskFromPixels, alphaStats, hitAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HitMask = api;
})(typeof self !== 'undefined' ? self : this);
