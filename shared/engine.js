// Server-authoritative Pong simulation. Pure JS: no DOM, no Node APIs.
// Runs on the Node server for PvP and in the browser for PvE vs bots.

import {
  polygon, sideSD, sideU, segClosest, segSegDist, pointSegDist, insideMargin,
} from './geometry.js';
import { WORLD, OBSTACLE, SPEED_PRESETS, RAMP_PRESETS } from './constants.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

/** Sides in the arena for a given number of participants (2 players get a square). */
export function arenaSidesFor(count) {
  if (count <= 2) return 4;
  return Math.max(3, count);
}

/** Which side index each participant defends. 2 players face off on a square. */
export function sideSlots(n, count) {
  if (count === 2) return [0, Math.floor(n / 2)];
  return Array.from({ length: count }, (_, i) => i % n);
}

export function paddleLenFor(poly) {
  return clamp(poly.sides[0].len * WORLD.PADDLE_LEN_FRAC, WORLD.PADDLE_MIN, WORLD.PADDLE_MAX);
}

/**
 * How far the paddle must stop short of each corner so that two adjacent
 * paddles (both offset inward) can never cross at a shared vertex.
 * The offset lines intersect off*tan(pi/n) from the corner; the tip must pass
 * that point by r/cos(pi/n) for the capsules to clear each other.
 */
export function cornerInsetFor(n) {
  const r = WORLD.PADDLE_THICK / 2;
  const off = WORLD.PADDLE_OFFSET + r;
  return off * Math.tan(Math.PI / n) + r / Math.cos(Math.PI / n) + 4;
}

/** The paddle's drawn/collided segment in world space (offset in front of the wall). */
export function paddleSegment(poly, paddleLen, sideIdx, pc) {
  const s = poly.sides[sideIdx];
  const h = paddleLen / 2;
  const off = WORLD.PADDLE_OFFSET + WORLD.PADDLE_THICK / 2;
  const u0 = Math.max(0, pc - h);
  const u1 = Math.min(s.len, pc + h);
  return {
    ax: s.p0.x + s.tx * u0 - s.nx * off,
    ay: s.p0.y + s.ty * u0 - s.ny * off,
    bx: s.p0.x + s.tx * u1 - s.nx * off,
    by: s.p0.y + s.ty * u1 - s.ny * off,
  };
}

/** Paddle speed scales with the usable edge so every arena slides in ~PADDLE_TRAVERSE seconds. */
export function paddleSpeedFor(usableLen, speedFactor = 1) {
  const base = clamp(usableLen / WORLD.PADDLE_TRAVERSE, WORLD.PADDLE_SPEED_MIN, WORLD.PADDLE_SPEED_MAX);
  return base * speedFactor;
}

/** Move a paddle along its side toward a normalized target. Shared by the engine and prediction. */
export function advancePaddle(pc, target, speed, dt, min, max) {
  const t = Number(target);
  const desired = min + clamp(Number.isFinite(t) ? t : 0, 0, 1) * (max - min);
  const step = speed * dt;
  return clamp(pc + clamp(desired - pc, -step, step), min, max);
}

/** Normalize obstacle entries coming from snapshots ({k:'l'|'v'}) for checkPlacement. */
export function normalizeObstacle(o) {
  if (o.kind === 'line' || o.kind === 'vortex') return o;
  if (o.k === 'l') return { kind: 'line', x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1 };
  return { kind: 'vortex', x: o.x, y: o.y, outer: o.outer ?? OBSTACLE.VORTEX_OUTER };
}

/**
 * Validate an obstacle placement against the arena and existing obstacles.
 * Returns { ok:true, ...resolvedCoords } or { ok:false, reason }.
 */
export function checkPlacement(poly, obstacles, kind, params, margin = OBSTACLE.MARGIN) {
  const x = Number(params?.x);
  const y = Number(params?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'Invalid position' };

  if (kind === 'line') {
    const angle = Number.isFinite(Number(params?.angle)) ? Number(params.angle) : 0;
    const hx = (Math.cos(angle) * OBSTACLE.LINE_LEN) / 2;
    const hy = (Math.sin(angle) * OBSTACLE.LINE_LEN) / 2;
    const x0 = x - hx, y0 = y - hy, x1 = x + hx, y1 = y + hy;
    if (!insideMargin(poly, x0, y0, margin) || !insideMargin(poly, x1, y1, margin)) {
      return { ok: false, reason: 'Too close to the wall' };
    }
    for (const o of obstacles) {
      const n = normalizeObstacle(o);
      if (n.kind === 'line') {
        if (segSegDist(x0, y0, x1, y1, n.x0, n.y0, n.x1, n.y1) < OBSTACLE.MIN_GAP) {
          return { ok: false, reason: 'Too close to another barrier' };
        }
      } else if (pointSegDist(n.x, n.y, x0, y0, x1, y1) < (n.outer ?? OBSTACLE.VORTEX_OUTER) + OBSTACLE.MIN_GAP * 0.6) {
        return { ok: false, reason: 'Too close to a vortex' };
      }
    }
    return { ok: true, x, y, angle, x0, y0, x1, y1 };
  }

  if (kind === 'vortex') {
    if (!insideMargin(poly, x, y, margin + OBSTACLE.VORTEX_OUTER)) {
      return { ok: false, reason: 'Too close to the wall' };
    }
    for (const o of obstacles) {
      const n = normalizeObstacle(o);
      if (n.kind === 'line') {
        if (pointSegDist(x, y, n.x0, n.y0, n.x1, n.y1) < OBSTACLE.VORTEX_OUTER + OBSTACLE.MIN_GAP * 0.6) {
          return { ok: false, reason: 'Too close to a barrier' };
        }
      } else if (Math.hypot(n.x - x, n.y - y) < (n.outer ?? OBSTACLE.VORTEX_OUTER) + OBSTACLE.VORTEX_OUTER + OBSTACLE.MIN_GAP * 0.5) {
        return { ok: false, reason: 'Too close to another vortex' };
      }
    }
    return { ok: true, x, y };
  }

  return { ok: false, reason: 'Unknown obstacle type' };
}

/** Client-side preview when only a snapshot is available (no live Game object). */
export function canPlaceInSnapshot(arena, obstacles, settings, kind, params) {
  if (!settings || !settings.obstacles) return { ok: false, reason: 'Obstacles are disabled' };
  if (!arena) return { ok: false, reason: 'No arena' };
  return checkPlacement(polygon(arena.n, arena.r), obstacles ?? [], kind, params);
}

export class Game {
  /**
   * @param {object} opts
   * @param {Array<{id:string,name:string,color:string,isBot?:boolean,speedFactor?:number,botSkill?:string}>} opts.participants
   * @param {object} opts.settings cleaned settings
   * @param {number} opts.roundNo
   */
  constructor({ participants, settings, roundNo = 1 }) {
    this.settings = { ...settings };
    this.roundNo = roundNo;

    const count = participants.length;
    this.n = arenaSidesFor(count);
    this.poly = polygon(this.n, WORLD.R);
    this.paddleLen = paddleLenFor(this.poly);
    this.cornerInset = cornerInsetFor(this.n);
    const slots = sideSlots(this.n, count);

    this.players = participants.map((p, idx) => {
      const side = slots[idx];
      const s = this.poly.sides[side];
      const usable = Math.max(1, s.len - this.paddleLen);
      const speedFactor = p.speedFactor ?? 1;
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        isBot: !!p.isBot,
        botSkill: p.botSkill ?? null,
        side,
        pc: s.len / 2,
        pv: 0,
        lives: this.settings.lives,
        alive: true,
        removed: false,
        connected: true,
        charges: 0,
        speedFactor,
        paddleSpeed: paddleSpeedFor(usable, speedFactor),
      };
    });
    this.byId = new Map(this.players.map((p) => [p.id, p]));
    this.ownerBySide = new Map(this.players.map((p) => [p.side, p]));
    this.ball = { x: 0, y: 0, vx: 0, vy: 0, speed: this.baseSpeed };
    this.phase = 'serve';       // 'serve' | 'play' | 'over'
    this.serveTimer = WORLD.SERVE_DELAY;
    this.mult = 1;
    this.rampTimer = 0;
    this.obstacles = [];
    this.events = [];
    this.tickCount = 0;
    this.time = 0;
    this.winnerId = null;
    this._serveBias = null;
    this._shrinkPending = false;
  }

  get baseSpeed() {
    return SPEED_PRESETS[this.settings.speed] ?? SPEED_PRESETS.normal;
  }

  get aliveCount() {
    let c = 0;
    for (const p of this.players) if (p.alive && !p.removed) c++;
    return c;
  }

  /** Participant metadata for the arena/roster message (eliminated players have side null). */
  get meta() {
    return this.players.map((p) => ({
      id: p.id,
      side: p.alive && !p.removed ? p.side : null,
      name: p.name,
      color: p.color,
      isBot: p.isBot,
    }));
  }

  /** Advance the simulation. `inputs` maps playerId -> target in [0,1]. */
  tick(dt, inputs) {
    dt = clamp(Number(dt) || 0, 0, 0.05);
    if (dt === 0) return;
    this.tickCount++;
    this.time += dt;
    if (this.phase === 'over') return;

    this._updatePaddles(dt, inputs);
    if (this.phase === 'serve') {
      this.serveTimer -= dt;
      if (this.serveTimer <= 0) this._serve();
    } else if (this.phase === 'play') {
      this._updateRamp(dt);
      this._moveBall(dt);
    }
    this._updateObstacles(dt);
  }

  drainEvents() {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  // ---------------------------------------------------------------- obstacles

  canPlace(playerId, kind, params) {
    if (!this.settings.obstacles) return { ok: false, reason: 'Obstacles are disabled in this room' };
    const p = this.byId.get(playerId);
    if (!p || p.removed) return { ok: false, reason: 'Unknown player' };
    if (p.alive) return { ok: false, reason: 'Only eliminated players can place obstacles' };
    if (p.charges <= 0) return { ok: false, reason: 'No obstacle charges left' };
    return checkPlacement(this.poly, this.obstacles, kind, params);
  }

  placeObstacle(playerId, kind, params) {
    const check = this.canPlace(playerId, kind, params);
    if (!check.ok) return check;
    if (this.phase === 'over') return { ok: false, reason: 'The round is over' };
    if (this.obstacles.length >= OBSTACLE.MAX_TOTAL) return { ok: false, reason: 'The arena is full of obstacles' };

    const p = this.byId.get(playerId);
    p.charges--;
    if (kind === 'line') {
      this.obstacles.push({
        kind: 'line',
        x0: check.x0, y0: check.y0, x1: check.x1, y1: check.y1,
        ownerId: p.id,
        life: OBSTACLE.LINE_LIFE, lifeMax: OBSTACLE.LINE_LIFE, hits: 0,
      });
    } else {
      this.obstacles.push({
        kind: 'vortex',
        x: check.x, y: check.y,
        outer: OBSTACLE.VORTEX_OUTER, core: OBSTACLE.VORTEX_CORE,
        ownerId: p.id,
        life: OBSTACLE.VORTEX_LIFE, lifeMax: OBSTACLE.VORTEX_LIFE,
      });
    }
    this.events.push({ t: 'place', kind, id: p.id, x: r1(check.x), y: r1(check.y) });
    return { ok: true };
  }

  // ------------------------------------------------------------- connections

  setConnected(playerId, val) {
    const p = this.byId.get(playerId);
    if (p) p.connected = !!val;
  }

  removePlayer(playerId) {
    const p = this.byId.get(playerId);
    if (!p || p.removed) return;
    p.removed = true;
    p.alive = false;
    p.charges = 0;
    this.ownerBySide.delete(p.side);
    this._maybeFinish();
    if (this.phase !== 'over' && this.players.filter((q) => q.alive && !q.removed).length >= 2) {
      this._shrinkPending = true;
    }
  }

  /**
   * Morph the arena to the current survivors: alive >= 3 keeps a flat-bottom
   * regular polygon, alive == 2 becomes two parallel player walls (a rectangle
   * with bounce end-walls). Survivors keep angular order and their normalized
   * position along the new side; obstacles that no longer fit are washed away.
   */
  _rebuildArena() {
    const alive = this.players.filter((p) => p.alive && !p.removed);
    if (alive.length < 2) return;

    const oldPoly = this.poly;
    const oldPaddleLen = this.paddleLen;
    const order = alive
      .map((p) => ({ p, ang: Math.atan2(oldPoly.sides[p.side].cy, oldPoly.sides[p.side].cx) }))
      .sort((a, b) => a.ang - b.ang);

    const n = arenaSidesFor(alive.length);
    const poly = polygon(n, WORLD.R);
    this.n = n;
    this.poly = poly;
    this.paddleLen = paddleLenFor(poly);
    this.cornerInset = cornerInsetFor(n);
    const slots = sideSlots(n, alive.length);

    this.ownerBySide = new Map();
    order.forEach(({ p }, idx) => {
      const oldSide = oldPoly.sides[p.side];
      const oldUsable = Math.max(1, oldSide.len - oldPaddleLen);
      const tNorm = clamp((p.pc - oldPaddleLen / 2) / oldUsable, 0, 1);
      const sideIdx = slots[idx % slots.length];
      const newSide = poly.sides[sideIdx];
      const h = this.paddleLen / 2;
      const inset = this.cornerInset;
      const lo = h + inset;
      const hi = Math.max(lo, newSide.len - h - inset);
      const usable = Math.max(1, hi - lo);
      p.side = sideIdx;
      p.pc = clamp(lo + tNorm * usable, lo, hi);
      p.pv = 0;
      p.paddleSpeed = paddleSpeedFor(Math.max(1, newSide.len - this.paddleLen), p.speedFactor);
      this.ownerBySide.set(sideIdx, p);
    });

    // Wash away obstacles that no longer fit the smaller hull.
    const kept = [];
    let dropped = 0;
    for (const o of this.obstacles) {
      const norm = normalizeObstacle(o);
      const params = norm.kind === 'line'
        ? {
            x: (norm.x0 + norm.x1) / 2,
            y: (norm.y0 + norm.y1) / 2,
            angle: Math.atan2(norm.y1 - norm.y0, norm.x1 - norm.x0),
          }
        : { x: norm.x, y: norm.y };
      if (checkPlacement(poly, kept, norm.kind, params).ok) kept.push(o);
      else dropped++;
    }
    if (dropped > 0) {
      this.obstacles = kept;
      this.events.push({ t: 'wash', count: dropped });
    }

    this.events.push({ t: 'shrink', n, alive: alive.length });
  }

  // ----------------------------------------------------------------- internals

  _updatePaddles(dt, inputs) {
    for (const p of this.players) {
      if (!p.alive || p.removed) continue;
      const side = this.poly.sides[p.side];
      const h = this.paddleLen / 2;
      const min = h + this.cornerInset;
      const max = Math.max(min, side.len - h - this.cornerInset);
      let t;
      if (inputs) t = typeof inputs.get === 'function' ? inputs.get(p.id) : inputs[p.id];
      const prev = p.pc;
      if (t !== undefined && t !== null) {
        p.pc = advancePaddle(p.pc, t, p.paddleSpeed, dt, min, max);
      } else {
        p.pc = clamp(p.pc, min, max);
      }
      p.pv = dt > 0 ? (p.pc - prev) / dt : 0;
    }
  }

  _serve() {
    if (this._shrinkPending) {
      this._shrinkPending = false;
      this._rebuildArena();
    }
    const bias = this._serveBias;
    this._serveBias = null;
    let ang;
    if (bias) {
      ang = Math.atan2(bias.y, bias.x) + (Math.random() - 0.5) * 1.2;
    } else {
      ang = Math.random() * Math.PI * 2;
    }
    this.ball.x = 0;
    this.ball.y = 0;
    this.ball.speed = this.baseSpeed * this.mult;
    this.ball.vx = Math.cos(ang) * this.ball.speed;
    this.ball.vy = Math.sin(ang) * this.ball.speed;
    this.phase = 'play';
    this.rampTimer = 0;
    this.events.push({ t: 'serve' });
  }

  _updateRamp(dt) {
    const target = Math.min(WORLD.MAX_SPEED, this.baseSpeed * this.mult);
    this.ball.speed += (target - this.ball.speed) * Math.min(1, dt * 2.5);
    const rate = RAMP_PRESETS[this.settings.ramp] ?? 0;
    if (rate > 0 && this.aliveCount > 1) {
      this.rampTimer += dt;
      if (this.rampTimer > WORLD.RAMP_DELAY) {
        this.mult = Math.min(WORLD.MAX_MULT, this.mult + rate * dt);
      }
    }
  }

  _moveBall(dt) {
    const ball = this.ball;
    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp > 0) {
      ball.vx = (ball.vx / sp) * ball.speed;
      ball.vy = (ball.vy / sp) * ball.speed;
    }
    const steps = Math.max(1, Math.ceil((ball.speed * dt) / (WORLD.BALL_R * 0.9)));
    const h = dt / steps;
    for (let s = 0; s < steps && this.phase === 'play'; s++) {
      this._vortexForces(h);
      ball.x += ball.vx * h;
      ball.y += ball.vy * h;
      this._obstacleCollisions();
      this._sideCollisions();
    }
  }

  _vortexForces(dt) {
    const ball = this.ball;
    for (const o of this.obstacles) {
      if (o.kind !== 'vortex' || o.dead) continue;
      const dx = o.x - ball.x;
      const dy = o.y - ball.y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) continue;
      if (d < o.core) {
        this._vortexEject(o);
        continue;
      }
      if (d < o.outer) {
        const f = OBSTACLE.VORTEX_FORCE * (1 - d / o.outer);
        const ux = dx / d;
        const uy = dy / d;
        // inward pull plus a tangential swirl
        ball.vx += (ux * f - uy * f * 0.45) * dt;
        ball.vy += (uy * f + ux * f * 0.45) * dt;
      }
    }
  }

  _vortexEject(o) {
    const ang = Math.random() * Math.PI * 2;
    const speed = clamp(this.ball.speed * (0.8 + Math.random() * 0.8), 140, WORLD.MAX_SPEED);
    this.ball.x = o.x + Math.cos(ang) * (o.outer + WORLD.BALL_R + 6);
    this.ball.y = o.y + Math.sin(ang) * (o.outer + WORLD.BALL_R + 6);
    this.ball.speed = speed;
    this.ball.vx = Math.cos(ang) * speed;
    this.ball.vy = Math.sin(ang) * speed;
    o.dead = true;
    this.events.push({ t: 'vortex', id: o.ownerId, x: r1(o.x), y: r1(o.y) });
  }

  _obstacleCollisions() {
    const ball = this.ball;
    for (const o of this.obstacles) {
      if (o.kind !== 'line' || o.dead) continue;
      const c = segClosest(o.x0, o.y0, o.x1, o.y1, ball.x, ball.y);
      const rad = WORLD.BALL_R + OBSTACLE.LINE_THICK / 2;
      if (c.dist >= rad) continue;
      let nx = ball.x - c.x;
      let ny = ball.y - c.y;
      const nd = Math.hypot(nx, ny);
      if (nd < 1e-6) {
        nx = -ball.vx;
        ny = -ball.vy;
        const d2 = Math.hypot(nx, ny) || 1;
        nx /= d2;
        ny /= d2;
      } else {
        nx /= nd;
        ny /= nd;
      }
      ball.x = c.x + nx * rad;
      ball.y = c.y + ny * rad;
      const vn = ball.vx * nx + ball.vy * ny;
      if (vn < 0) {
        ball.vx -= 2 * vn * nx;
        ball.vy -= 2 * vn * ny;
        const sp = Math.hypot(ball.vx, ball.vy) || 1;
        ball.vx = (ball.vx / sp) * ball.speed;
        ball.vy = (ball.vy / sp) * ball.speed;
        o.hits = (o.hits || 0) + 1;
        this.events.push({ t: 'bounce', o: 'line', x: r1(ball.x), y: r1(ball.y) });
        if (o.hits >= OBSTACLE.LINE_HITS) o.dead = true;
      }
    }
  }

  _sideCollisions() {
    const ball = this.ball;

    // 1) Paddles float in front of the wall, like classic Pong: the ball
    //    bounces off the paddle's arena-side face before it can reach the goal line.
    const face = -(WORLD.PADDLE_OFFSET + WORLD.PADDLE_THICK + WORLD.BALL_R);
    for (const s of this.poly.sides) {
      const owner = this.ownerBySide.get(s.i);
      if (!owner || !owner.alive) continue;
      const d = sideSD(s, ball.x, ball.y);
      if (d <= face) continue;
      const h = this.paddleLen / 2;
      const u = sideU(s, ball.x, ball.y);
      if (u < owner.pc - h - WORLD.BALL_R || u > owner.pc + h + WORLD.BALL_R) continue;
      const vn = ball.vx * s.nx + ball.vy * s.ny;
      if (vn <= 0) continue;
      this._paddleBounce(s, owner, u);
      return;
    }

    // 2) Goal lines: a ball that got past the paddle scores or bounces.
    let side = null;
    let sd = -Infinity;
    for (const s of this.poly.sides) {
      const d = sideSD(s, ball.x, ball.y);
      if (d > -WORLD.BALL_R && d > sd) {
        sd = d;
        side = s;
      }
    }
    if (!side) return;

    const owner = this.ownerBySide.get(side.i);
    if (owner && owner.alive) {
      this._goal(owner, side);
    } else {
      this._wallBounce(side, sd);
    }
  }

  _paddleBounce(side, owner, u) {
    const ball = this.ball;
    const sd = sideSD(side, ball.x, ball.y);
    const push = -(WORLD.PADDLE_OFFSET + WORLD.PADDLE_THICK + WORLD.BALL_R) - sd;
    ball.x += side.nx * push;
    ball.y += side.ny * push;

    const vn = ball.vx * side.nx + ball.vy * side.ny;
    if (vn > 0) {
      ball.vx -= 2 * vn * side.nx;
      ball.vy -= 2 * vn * side.ny;
    }

    const h = this.paddleLen / 2;
    const off = clamp((u - owner.pc) / h, -1, 1);
    const inward = Math.atan2(-side.ny, -side.nx);
    let rel = wrapPi(Math.atan2(ball.vy, ball.vx) - inward);
    rel += off * WORLD.PADDLE_SPIN;
    rel += clamp(owner.pv / owner.paddleSpeed, -1, 1) * WORLD.PADDLE_SPIN * 0.7;
    rel = clamp(rel, -WORLD.PADDLE_MAX_ANGLE, WORLD.PADDLE_MAX_ANGLE);
    const ang = inward + rel;
    ball.vx = Math.cos(ang) * ball.speed;
    ball.vy = Math.sin(ang) * ball.speed;
    this.events.push({ t: 'hit', id: owner.id, x: r1(ball.x), y: r1(ball.y) });
  }

  _wallBounce(side, sd) {
    const ball = this.ball;
    const push = -WORLD.BALL_R - sd;
    ball.x += side.nx * push;
    ball.y += side.ny * push;
    const vn = ball.vx * side.nx + ball.vy * side.ny;
    if (vn > 0) {
      ball.vx -= 2 * vn * side.nx;
      ball.vy -= 2 * vn * side.ny;
    }
    const sp = Math.hypot(ball.vx, ball.vy) || 1;
    ball.vx = (ball.vx / sp) * ball.speed;
    ball.vy = (ball.vy / sp) * ball.speed;
    this.events.push({ t: 'bounce', o: 'wall', x: r1(ball.x), y: r1(ball.y) });
  }

  _goal(owner, side) {
    owner.lives -= 1;
    this.events.push({
      t: 'goal', id: owner.id, side: side.i, lives: owner.lives,
      x: r1(this.ball.x), y: r1(this.ball.y),
    });

    this.mult = 1;
    this.rampTimer = 0;
    this.ball.speed = this.baseSpeed;
    this.ball.x = 0;
    this.ball.y = 0;
    this.ball.vx = 0;
    this.ball.vy = 0;

    if (owner.lives <= 0) {
      owner.alive = false;
      this.ownerBySide.delete(owner.side);
      owner.charges = this.settings.obstacles ? 2 : 0;
      this.events.push({ t: 'elim', id: owner.id });
    }

    const alive = this.players.filter((p) => p.alive && !p.removed);
    if (alive.length <= 1) {
      this.winnerId = alive.length === 1 ? alive[0].id : null;
      this.phase = 'over';
      this.events.push({ t: 'over', id: this.winnerId });
    } else {
      if (!owner.alive) this._rebuildArena();
      this.phase = 'serve';
      this.serveTimer = WORLD.SERVE_DELAY;
      // serve back toward the player who just conceded
      this._serveBias = { x: side.cx, y: side.cy };
      this.events.push({ t: 'serve' });
    }
  }

  _maybeFinish() {
    if (this.phase === 'over') return;
    const alive = this.players.filter((p) => p.alive && !p.removed);
    if (alive.length <= 1) {
      this.winnerId = alive.length === 1 ? alive[0].id : null;
      this.phase = 'over';
      this.ball.vx = 0;
      this.ball.vy = 0;
      this.events.push({ t: 'over', id: this.winnerId });
    }
  }

  _updateObstacles(dt) {
    let hasDead = false;
    for (const o of this.obstacles) {
      o.life -= dt;
      if (o.life <= 0 && !o.dead) {
        o.dead = true;
        this.events.push({ t: 'expire', kind: o.kind });
      }
      if (o.dead) hasDead = true;
    }
    if (hasDead) this.obstacles = this.obstacles.filter((o) => !o.dead);
  }

  /** Compact state for the wire and the renderer. */
  snapshot() {
    return {
      tick: this.tickCount,
      phase: this.phase,
      cd: this.phase === 'serve' ? Math.round(Math.max(0, this.serveTimer) * 10) / 10 : 0,
      mult: r2(this.mult),
      winner: this.winnerId,
      ball: {
        x: r1(this.ball.x), y: r1(this.ball.y),
        vx: r1(this.ball.vx), vy: r1(this.ball.vy), s: r1(this.ball.speed),
      },
      players: this.players.map((p) => ({
        id: p.id,
        side: p.side,
        pc: r1(p.pc),
        lv: p.lives,
        al: p.alive && !p.removed ? 1 : 0,
        ch: p.charges,
        cn: p.connected ? 1 : 0,
      })),
      obstacles: this.obstacles.map((o) => (o.kind === 'line'
        ? {
            k: 'l', x0: r1(o.x0), y0: r1(o.y0), x1: r1(o.x1), y1: r1(o.y1),
            o: o.ownerId, a: r2(o.life / o.lifeMax), hits: o.hits,
          }
        : {
            k: 'v', x: r1(o.x), y: r1(o.y), o: o.ownerId,
            a: r2(o.life / o.lifeMax), outer: o.outer,
          })),
    };
  }
}
