// Client-side prediction for the local player's paddle in PvP.
// Uses the same movement rules as the server engine so the two agree closely;
// authoritative snapshots then gently correct any drift.

import { advancePaddle, paddleSpeedFor } from '/shared/engine.js';

const SNAP_DISTANCE = 40;   // units of divergence before we hard-snap
const BLEND = 0.25;         // fraction of the remaining error corrected per snapshot

export class PaddlePredictor {
  constructor() {
    this.pc = 0;
    this.target = 0.5;
    this.speed = 950;
    this.min = 0;
    this.max = 1;
    this.ready = false;
  }

  configure(sideLen, paddleLen, inset = 0) {
    const h = paddleLen / 2;
    this.min = h + inset;
    this.max = Math.max(this.min, sideLen - h - inset);
    this.speed = paddleSpeedFor(Math.max(1, sideLen - paddleLen));
  }

  setTarget(t) {
    if (Number.isFinite(t)) this.target = Math.max(0, Math.min(1, t));
  }

  reset(pc) {
    this.pc = pc;
    this.ready = true;
  }

  /** Merge an authoritative position: snap on big errors, ease on small ones. */
  reconcile(pc) {
    if (!this.ready) return this.reset(pc);
    const d = pc - this.pc;
    if (Math.abs(d) > SNAP_DISTANCE) this.pc = pc;
    else this.pc += d * BLEND;
    return this.pc;
  }

  step(dt) {
    if (!this.ready) return this.pc;
    this.pc = advancePaddle(this.pc, this.target, this.speed, dt, this.min, this.max);
    return this.pc;
  }
}
