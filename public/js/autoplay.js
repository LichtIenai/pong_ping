// Client-side autopilot: steers the local paddle toward the ball's projected
// arrival point using snapshots, so it works for both PvE and PvP.

import { interceptTarget } from '/shared/ai.js';

export class AutoPlayer {
  constructor({ getSnapshot, getView, onTarget }) {
    this.getSnapshot = getSnapshot || (() => null);
    this.getView = getView || (() => null);
    this.onTarget = onTarget || (() => {});
    this.active = false;
  }

  setActive(on) {
    this.active = !!on;
  }

  update() {
    if (!this.active) return;

    const snap = this.getSnapshot();
    const view = this.getView();
    if (!snap || !view || snap.phase !== 'play' || !snap.ball) return;

    const ball = snap.ball;
    if (!(ball.s > 0)) return;
    const vx = Number(ball.vx);
    const vy = Number(ball.vy);
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) return;

    // Only reposition while the ball is heading toward our wall (or already
    // close to it); otherwise the paddle would chase predictions needlessly.
    const side = view.side;
    if (vx * side.nx + vy * side.ny <= 0) return;

    const target = interceptTarget(
      view.poly,
      view.sideIdx,
      { x: ball.x, y: ball.y, vx, vy, speed: ball.s },
      view.paddleLen,
      view.cornerInset || 0,
      view.horizon ?? 4,
    );
    if (target !== null) this.onTarget(target);
  }
}
