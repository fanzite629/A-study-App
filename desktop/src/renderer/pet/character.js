'use strict';
// Character rendering module.
//
// Responsibilities (and nothing else):
//   - show the asset for a requested state, falling back to idle when the pack
//     has no usable asset for that state;
//   - place it with a single uniform scale so the aspect ratio is kept, the
//     canvas is never cropped, and the feet anchor stays fixed across states;
//   - answer hit tests against the alpha mask of the asset currently shown.
//
// It knows nothing about timers, tasks, bubbles or windows. It never draws a
// character itself, never adds backgrounds, borders, shadows, filters or
// opacity changes to the artwork.
//
// Extension point: `BACKENDS` maps a manifest state `type` to a renderer.
// Only "static" (one transparent PNG per state) is implemented. Future
// "sequence" (frame animation) or "layered" backends would be added here and
// must provide the same interface: mount(), show(), hide(), maskAt(time).
(function (root) {
  const { assetStateFor } = root.PetStates;
  const { hitAt } = root.HitMask;

  /** One <img> per state; preloaded and stacked so switching never flickers. */
  const StaticBackend = {
    mount(container, asset) {
      const img = new Image();
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      img.className = 'char-layer';
      img.src = asset.url;
      img.hidden = true;
      container.appendChild(img);
      const ready = img.decode().then(() => true, () => false);
      return { el: img, ready, mask: () => asset.mask };
    },
    show(h) { h.el.hidden = false; },
    hide(h) { h.el.hidden = true; },
    place(h, rect) {
      const s = h.el.style;
      s.left = rect.x + 'px'; s.top = rect.y + 'px';
      s.width = rect.w + 'px'; s.height = rect.h + 'px';
    },
    unmount(h) { h.el.remove(); },
  };

  const BACKENDS = { static: StaticBackend };

  class CharacterRenderer {
    constructor(container) {
      this.container = container;
      this.handles = {};     // state -> backend handle (only states whose asset decoded)
      this.state = 'idle';
      this.shown = null;     // state whose asset is visible
      this.rect = null;
      this.packKey = null;
      this.listeners = [];
      this.blinking = false;
      setInterval(() => {
        if (this.state !== 'idle' || !this.handles.blink || document.hidden || document.body.classList.contains('reduced-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        this.blinking = true; this.apply();
        setTimeout(() => { this.blinking = false; this.apply(); }, 150);
      }, 6500);
    }

    /** @param {object|null} pack  payload from the main process (pet:pack) */
    async setPack(pack) {
      const key = pack && pack.loaded ? `${pack.id}@${pack.version}#${Object.values(pack.states).map((s) => s.url).join('|')}` : null;
      if (key === this.packKey) return;
      this.packKey = key;
      for (const h of Object.values(this.handles)) h.backend.unmount(h.h);
      this.handles = {};
      this.shown = null;
      if (!pack || !pack.loaded) { this.notify(); return; }

      const pending = Object.entries(pack.states).map(async ([name, asset]) => {
        const backend = BACKENDS[asset.type || 'static'];
        if (!backend) return;
        const h = backend.mount(this.container, asset);
        if (this.rect) backend.place(h, this.rect);
        const ok = await h.ready;
        if (key !== this.packKey) { backend.unmount(h); return; } // a newer pack replaced this one
        if (ok) this.handles[name] = { backend, h };
        else backend.unmount(h); // decode failed: this state falls back to idle
      });
      await Promise.all(pending);
      if (key === this.packKey) this.apply();
    }

    /** @param {{x:number,y:number,w:number,h:number}} rect  image rect in window px */
    setRect(rect) {
      this.rect = rect;
      for (const { backend, h } of Object.values(this.handles)) backend.place(h, rect);
    }

    setState(state) {
      this.state = state;
      this.apply();
    }

    apply() {
      const desired = this.blinking && this.state === 'idle' ? 'blink' : this.state;
      const want = this.handles.idle ? assetStateFor(desired, this.handles) : null;
      if (want === this.shown) { this.notify(); return; }
      if (this.shown && this.handles[this.shown]) {
        const o = this.handles[this.shown]; o.backend.hide(o.h);
      }
      if (want) { const n = this.handles[want]; n.backend.show(n.h); }
      this.shown = want;
      this.notify();
    }

    /** Is window point (x, y) on a visible pixel of the asset currently shown? */
    hitTest(x, y) {
      if (!this.shown || !this.rect) return false;
      const r = this.rect;
      return hitAt(this.handles[this.shown].h.mask(), (x - r.x) / r.w, (y - r.y) / r.h);
    }

    get hasCharacter() { return !!this.handles.idle; }

    onChange(cb) { this.listeners.push(cb); }
    notify() {
      const info = { state: this.state, assetState: this.shown, loaded: Object.keys(this.handles) };
      for (const cb of this.listeners) cb(info);
    }
  }

  root.CharacterRenderer = CharacterRenderer;
})(self);
