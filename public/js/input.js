// Paddle input: keyboard rotation + pointer drag, plus obstacle placement mode.

import { sideU } from '/shared/geometry.js';
import { OBSTACLE } from '/shared/constants.js';
import { paddleSpeedFor } from '/shared/engine.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const CCW = -1;
const CW = 1;
const KEY_DIRS = {
  ArrowLeft: CCW, a: CCW, A: CCW,
  ArrowRight: CW, d: CW, D: CW,
};

export class InputController {
  constructor({ canvas, renderer, getContext, onInput }) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.getContext = getContext || (() => null);
    this.onInput = onInput || (() => {});

    this.keys = new Set();
    this.target = 0.5;
    this.lastSent = -1;
    this.lastSentAt = 0;
    this.dragging = false;

    this.placement = null;
    this.validate = () => ({ ok: false });
    this.confirm = () => {};
    this.onPlacementChange = () => {};
    this.onEscape = null;

    window.addEventListener('keydown', (e) => this._key(e, true));
    window.addEventListener('keyup', (e) => this._key(e, false));
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ----------------------------------------------------------------- setup

  setValidator(fn) { this.validate = fn; }
  setConfirmer(fn) { this.confirm = fn; }
  setPlacementListener(fn) { this.onPlacementChange = fn; }

  enterPlacement(kind) {
    this.placement = { kind, params: null, valid: false, origin: null, dragging: false };
    this.renderer.setPlacement(this.placement);
    this.onPlacementChange(kind);
  }

  cancelPlacement(silent = false) {
    if (!this.placement) return;
    this.placement = null;
    this.renderer.setPlacement(null);
    if (!silent) this.onPlacementChange(null);
  }

  // -------------------------------------------------------------- keyboard

  _key(e, down) {
    if (e.key === 'Escape') {
      if (!down) return;
      if (this.placement) {
        this.cancelPlacement();
      } else if (this.onEscape) {
        this.onEscape();
      }
      return;
    }
    const dir = KEY_DIRS[e.key];
    if (dir === undefined) return;
    if (down) this.keys.add(dir);
    else this.keys.delete(dir);
    e.preventDefault();
  }

  update(dt) {
    if (this.placement) return;
    const ctx = this.getContext();
    if (!ctx || !ctx.canControl) return;
    let dir = 0;
    for (const d of this.keys) dir += d;
    if (dir === 0) return;
    const usable = Math.max(1, ctx.side.len - ctx.paddleLen - 2 * (this.renderer.cornerInset || 0));
    let sign = 1;
    if (this.renderer.viewMode === 'own') {
      // In own-side view, ←/→ should track the screen, not the world winding order.
      const v = this.renderer.viewAngle;
      const tx = ctx.side.tx * Math.cos(v) - ctx.side.ty * Math.sin(v);
      sign = tx >= 0 ? 1 : -1;
    }
    this.target = clamp(this.target + (dir * sign * paddleSpeedFor(usable) * dt) / usable, 0, 1);
    this._emit(false);
  }

  _emit(force) {
    const now = performance.now();
    if (!force) {
      if (Math.abs(this.target - this.lastSent) < 0.002) return;
      if (now - this.lastSentAt < 40) return;
    }
    this.lastSent = this.target;
    this.lastSentAt = now;
    this.onInput(this.target);
  }

  // --------------------------------------------------------------- pointer

  _down(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    const world = this.renderer.screenToWorld(e.clientX, e.clientY);
    if (this.placement) {
      const pl = this.placement;
      if (pl.kind === 'vortex') {
        this._previewVortex(world);
        if (pl.valid && pl.params) this.confirm('vortex', pl.params);
      } else {
        pl.origin = world;
        pl.dragging = true;
        this._previewLine(world);
      }
      e.preventDefault();
      return;
    }
    this.dragging = true;
    this._aim(world);
    e.preventDefault();
  }

  _move(e) {
    const world = this.renderer.screenToWorld(e.clientX, e.clientY);
    if (this.placement) {
      const pl = this.placement;
      if (pl.kind === 'line' && pl.dragging) this._previewLine(world);
      else if (pl.kind === 'vortex') this._previewVortex(world);
      e.preventDefault();
      return;
    }
    if (this.dragging) {
      this._aim(world);
      e.preventDefault();
    }
  }

  _up(e) {
    if (this.placement) {
      const pl = this.placement;
      if (pl.kind === 'line' && pl.dragging) {
        const world = this.renderer.screenToWorld(e.clientX, e.clientY);
        this._previewLine(world);
        pl.dragging = false;
        if (pl.valid && pl.params) this.confirm('line', pl.params);
        e.preventDefault();
      }
      return;
    }
    this.dragging = false;
  }

  _aim(world) {
    const ctx = this.getContext();
    if (!ctx || !ctx.canControl) return;
    const u = sideU(ctx.side, world.x, world.y);
    const h = ctx.paddleLen / 2;
    const usable = Math.max(1, ctx.side.len - ctx.paddleLen);
    this.target = clamp((u - h) / usable, 0, 1);
    this._emit(true);
  }

  _previewVortex(world) {
    const pl = this.placement;
    const params = { x: world.x, y: world.y };
    const res = this.validate('vortex', params);
    pl.params = params;
    pl.valid = !!res.ok;
    this.renderer.setPlacement(pl);
  }

  _previewLine(world) {
    const pl = this.placement;
    const o = pl.origin || world;
    const dx = world.x - o.x;
    const dy = world.y - o.y;
    const d = Math.hypot(dx, dy);
    const angle = d > 14 ? Math.atan2(dy, dx) : 0;
    const half = OBSTACLE.LINE_LEN / 2;
    const params = { x: o.x + Math.cos(angle) * half, y: o.y + Math.sin(angle) * half, angle };
    const res = this.validate('line', params);
    pl.params = params;
    pl.valid = !!res.ok;
    this.renderer.setPlacement(pl);
  }
}
