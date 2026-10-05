// Bot controllers: paddle aiming with reaction lag/error and obstacle placement.

import { sideSD, sideU } from './geometry.js';
import { WORLD, BOT_SKILLS } from './constants.js';
import { checkPlacement } from './engine.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function skillFor(name) {
  return BOT_SKILLS[name] ?? BOT_SKILLS.normal;
}

/**
 * Forward-simulate the ball (walls bounce, paddles ignored) and return the
 * coordinate along `sideIdx` where it would arrive, or null within the horizon.
 */
export function predictHitU(game, sideIdx, horizon = 4) {
  const side = game.poly.sides[sideIdx];
  const b = game.ball;
  let x = b.x;
  let y = b.y;
  let vx = b.vx;
  let vy = b.vy;
  const speed = Math.hypot(vx, vy) || b.speed || 1;
  const dt = 1 / 60;
  for (let t = 0; t < horizon; t += dt) {
    x += vx * dt;
    y += vy * dt;
    if (sideSD(side, x, y) > -WORLD.BALL_R) return sideU(side, x, y);
    for (const s of game.poly.sides) {
      if (s.i === sideIdx) continue;
      const d = sideSD(s, x, y);
      if (d > -WORLD.BALL_R) {
        const push = -WORLD.BALL_R - d;
        x += s.nx * push;
        y += s.ny * push;
        const vn = vx * s.nx + vy * s.ny;
        if (vn > 0) {
          vx -= 2 * vn * s.nx;
          vy -= 2 * vn * s.ny;
        }
        const sp = Math.hypot(vx, vy) || 1;
        vx = (vx / sp) * speed;
        vy = (vy / sp) * speed;
        break;
      }
    }
  }
  return null;
}

export class BotController {
  constructor({ player, game, skill = 'normal' }) {
    this.player = player;
    this.game = game;
    this.skill = skillFor(skill);
    this.timer = Math.random() * this.skill.reaction;
    this.target = 0.5;
  }

  update(dt) {
    const p = this.player;
    if (!p.alive || p.removed) return this.target;
    this.timer -= dt;
    if (this.timer > 0) return this.target;
    this.timer = this.skill.reaction * (0.7 + Math.random() * 0.6);

    const g = this.game;
    const side = g.poly.sides[p.side];
    let u = null;
    if (Math.random() < this.skill.predict) u = predictHitU(g, p.side);
    if (u === null || u === undefined) u = sideU(side, g.ball.x, g.ball.y);
    u += (Math.random() * 2 - 1) * this.skill.error;

    const h = g.paddleLen / 2;
    const min = h;
    const max = side.len - h;
    this.target = clamp((u - min) / (max - min), 0, 1);
    return this.target;
  }
}

/**
 * Pick a spot to drop an obstacle near the ball's projected path.
 * Returns { kind, params } or null when no valid placement was found.
 */
export function chooseBotPlacement(game, skill = 'normal') {
  const s = skillFor(skill);
  const b = game.ball;
  const lead = 0.7 + Math.random() * 0.9;
  const baseX = b.x + b.vx * lead;
  const baseY = b.y + b.vy * lead;
  const spread = s.error * 0.8;

  for (let i = 0; i < 14; i++) {
    const kind = i < 7 ? 'vortex' : 'line';
    const x = clamp(baseX + (Math.random() - 0.5) * spread * 2, -WORLD.R, WORLD.R);
    const y = clamp(baseY + (Math.random() - 0.5) * spread * 2, -WORLD.R, WORLD.R);
    const params = kind === 'vortex'
      ? { x, y }
      : { x, y, angle: Math.atan2(b.vy, b.vx) + Math.PI / 2 + (Math.random() - 0.5) * 0.6 };
    if (checkPlacement(game.poly, game.obstacles, kind, params).ok) return { kind, params };
  }
  return null;
}
