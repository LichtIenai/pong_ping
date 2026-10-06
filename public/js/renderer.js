// Canvas 2D renderer: polygon arena, paddles, ball + trail, obstacles, particles.
// Snapshots arrive at 30 Hz; drawing interpolates behind `delay` for smoothness.
// The world can rotate per player so their own wall sits flat at the bottom.

import { polygon } from '/shared/geometry.js';
import { WORLD, OBSTACLE } from '/shared/constants.js';
import { paddleLenFor, cornerInsetFor, paddleSegment } from '/shared/engine.js';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function hexA(hex, a) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.arena = null;
    this.poly = null;
    this.paddleLen = 0;
    this.metaById = new Map();
    this.metaBySide = new Map();
    this.you = null;
    this.snaps = [];
    this.trail = [];
    this.placement = null;
    this.viewMode = 'own';    // 'own' = your side flat at the bottom, 'shared' = side 0 at the bottom
    this.viewAngle = 0;
    this.delay = 0.07;        // interpolation delay in seconds
    this.selfPc = null;       // predicted paddle position override for the local player
    this.maxLives = 3;
    this.particles = [];
    this.rings = [];
    this.shake = 0;
    this.morph = null;
    this.flash = null;
    this.fade = 1;
    this.lastT = 0;
    this._now = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this._computeView();
  }

  _computeView() {
    const pad = 160;
    const lift = this.viewMode === 'own' ? this.h * 0.05 : 0; // field sits a bit higher than the player
    this.scale = Math.min(this.w, this.h) / (2 * (WORLD.R + pad));
    this.cx = this.w / 2;
    this.cy = this.h / 2 - lift;
  }

  setArena(arena, players) {
    const oldPoly = this.poly;
    this.arena = arena || null;
    if (!arena) {
      this.poly = null;
      this.paddleLen = 0;
      this.metaById = new Map();
      this.metaBySide = new Map();
      this.morph = null;
      this.fade = 1;
      this._computeViewAngle();
      return;
    }
    this.poly = polygon(arena.n, arena.r);
    this.paddleLen = paddleLenFor(this.poly);
    this.cornerInset = cornerInsetFor(arena.n);
    this.metaById = new Map((players || []).map((p) => [p.id, p]));
    // Eliminated players have side null; they must not claim a wall.
    this.metaBySide = new Map(
      (players || []).filter((p) => p.side !== null && p.side !== undefined).map((p) => [p.side, p]),
    );
    this.snaps = [];
    this.trail = [];
    this.selfPc = null;
    this.resize();
    this._computeViewAngle();

    // Morph animation when the arena changes shape (players eliminated).
    if (oldPoly && oldPoly.n !== this.poly.n) {
      this.morph = {
        prev: this._outlinePoints(oldPoly, 96),
        next: this._outlinePoints(this.poly, 96),
        t: 0,
        dur: 0.85,
      };
      this._spawnShrinkBurst(oldPoly);
      this.shake = Math.max(this.shake, 9);
    } else {
      this.morph = null;
      this.fade = 1;
    }
  }

  setYou(id) {
    this.you = id;
    this._computeViewAngle();
  }

  setViewMode(mode) {
    this.viewMode = mode === 'shared' ? 'shared' : 'own';
    this._computeView();
    this._computeViewAngle();
  }

  setMaxLives(n) {
    this.maxLives = Math.max(1, Number(n) || 3);
  }

  _computeViewAngle() {
    if (!this.poly || this.viewMode !== 'own') {
      this.viewAngle = 0;
      return;
    }
    const me = this.metaById.get(this.you);
    const side = me && me.side !== null && me.side !== undefined
      ? this.poly.sides[me.side]
      : null;
    if (!side) {
      this.viewAngle = 0; // spectators / eliminated: side 0 is already at the bottom
      return;
    }
    this.viewAngle = Math.PI / 2 - Math.atan2(side.cy, side.cx);
  }

  pushSnapshot(snap) {
    this.snaps.push({ t: performance.now() / 1000, s: snap });
    if (this.snaps.length > 90) this.snaps.splice(0, this.snaps.length - 90);
  }

  setPlacement(p) {
    this.placement = p;
  }

  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = (clientX - rect.left - this.cx) / this.scale;
    const sy = (clientY - rect.top - this.cy) / this.scale;
    if (!this.viewAngle) return { x: sx, y: sy };
    const c = Math.cos(this.viewAngle);
    const s = Math.sin(this.viewAngle);
    // inverse of the render rotation
    return { x: sx * c + sy * s, y: -sx * s + sy * c };
  }

  // ------------------------------------------------------------- particles

  burst(x, y, color, opts = {}) {
    const {
      count = 10, speed = [80, 260], life = [0.35, 0.75], size = [2, 5],
      alpha = 1, inward = false, spread = TAU, angle = 0,
    } = opts;
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const sp = lerp(speed[0], speed[1], Math.random());
      let vx = Math.cos(a) * sp;
      let vy = Math.sin(a) * sp;
      if (inward) {
        const d = Math.hypot(x, y) || 1;
        vx = (-x / d) * sp + vx * 0.35;
        vy = (-y / d) * sp + vy * 0.35;
      }
      const lf = lerp(life[0], life[1], Math.random());
      this.particles.push({
        x, y, vx, vy, life: lf, maxLife: lf,
        size: lerp(size[0], size[1], Math.random()), color, alpha,
      });
    }
  }

  ring(x, y, color, opts = {}) {
    const { r0 = 8, r1 = 120, life = 0.5, width = 3, alpha = 0.9 } = opts;
    this.rings.push({
      x, y, r: r0, r1, vr: (r1 - r0) / life,
      life, maxLife: life, width, color, alpha,
    });
  }

  /** Small spark burst for paddle / wall / obstacle hits. */
  impact(x, y, color, scale = 1) {
    this.burst(x, y, color, {
      count: Math.round(7 * scale), speed: [60, 240], life: [0.25, 0.5], size: [1.5, 4],
    });
  }

  wallHit(x, y) {
    this.burst(x, y, '#9ad6ff', { count: 5, speed: [50, 180], life: [0.2, 0.4], size: [1.5, 3.5] });
  }

  /** Big burst + shockwave + shake when a player loses a life. */
  damage(x, y, color) {
    this.burst(x, y, color, { count: 26, speed: [90, 420], life: [0.45, 1.0], size: [2.5, 7] });
    this.burst(x, y, '#ffffff', { count: 8, speed: [140, 500], life: [0.2, 0.45], size: [1.5, 4] });
    this.ring(x, y, color, { r1: 150, life: 0.5, width: 4 });
    this.shake = Math.max(this.shake, 12);
  }

  /**
   * Dramatic goal: area shading, a particle crash along the wall and a big burst.
   * `sideIdx` is the conceding side so debris can skitter along the wall.
   */
  goalImpact(x, y, color, sideIdx = null) {
    this.flash = { x, y, color, t: 0, dur: 0.6 };
    this.burst(x, y, color, { count: 30, speed: [120, 480], life: [0.45, 1.0], size: [2.5, 7] });
    this.burst(x, y, '#ffffff', { count: 10, speed: [160, 520], life: [0.2, 0.5], size: [1.5, 4] });
    this.ring(x, y, color, { r1: 170, life: 0.5, width: 4 });
    this.ring(x, y, '#ffffff', { r0: 4, r1: 90, life: 0.3, width: 2 });

    const side = sideIdx !== null && this.poly ? this.poly.sides[sideIdx] : null;
    if (side) {
      // debris that crashes along the wall and bounces inward
      for (let i = 0; i < 16; i++) {
        const along = (Math.random() * 2 - 1) * 90;
        const inward = 60 + Math.random() * 160;
        const tangential = (Math.random() * 2 - 1) * 260;
        const lf = 0.3 + Math.random() * 0.45;
        this.particles.push({
          x: x + side.tx * along,
          y: y + side.ty * along,
          vx: -side.nx * inward + side.tx * tangential,
          vy: -side.ny * inward + side.ty * tangential,
          life: lf,
          maxLife: lf,
          size: 1.5 + Math.random() * 3.5,
          color,
          alpha: 1,
        });
      }
    }
    this.shake = Math.max(this.shake, 14);
  }

  vortexBurst(x, y, color) {
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * TAU;
      const r = 20 + Math.random() * 60;
      const tang = a + Math.PI / 2;
      const sp = 120 + Math.random() * 180;
      const lf = 0.35 + Math.random() * 0.5;
      this.particles.push({
        x: x + Math.cos(a) * r, y: y + Math.sin(a) * r,
        vx: Math.cos(tang) * sp, vy: Math.sin(tang) * sp,
        life: lf, maxLife: lf, size: 2 + Math.random() * 3, color, alpha: 1,
      });
    }
    this.ring(x, y, color, { r0: 10, r1: 110, life: 0.45, width: 3 });
  }

  placeBurst(x, y, color) {
    this.ring(x, y, color, { r0: 6, r1: 70, life: 0.35, width: 2.5 });
    this.burst(x, y, color, { count: 8, speed: [40, 140], life: [0.25, 0.5], size: [1.5, 3.5] });
  }

  _spawnShrinkBurst(oldPoly) {
    for (const s of oldPoly.sides) {
      this.burst(s.cx, s.cy, '#4aa8ff', {
        count: 10, speed: [60, 260], life: [0.4, 0.9], size: [2, 5], inward: true,
      });
    }
    this.ring(0, 0, '#4aa8ff', { r1: WORLD.R * 0.9, life: 0.6, width: 4 });
    this.ring(0, 0, '#9ad6ff', { r1: WORLD.R * 0.5, life: 0.4, width: 2 });
  }

  _updateEffects(dt) {
    if (dt <= 0) return;
    const damp = Math.pow(0.08, dt);
    for (const p of this.particles) {
      p.life -= dt;
      p.vx *= damp;
      p.vy *= damp;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    if (this.particles.some((p) => p.life <= 0)) {
      this.particles = this.particles.filter((p) => p.life > 0);
    }
    for (const r of this.rings) {
      r.life -= dt;
      r.r += r.vr * dt;
    }
    if (this.rings.some((r) => r.life <= 0)) {
      this.rings = this.rings.filter((r) => r.life > 0);
    }
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 40);
    if (this.flash) {
      this.flash.t += dt;
      if (this.flash.t >= this.flash.dur) this.flash = null;
    }
    if (this.morph) {
      this.morph.t += dt;
      if (this.morph.t >= this.morph.dur) this.morph = null;
    }
  }

  // ------------------------------------------------------------ frame loop

  render(now) {
    this._now = now;
    const dt = this.lastT ? Math.min(0.05, Math.max(0, now - this.lastT)) : 0.016;
    this.lastT = now;
    this._updateEffects(dt);

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.poly) return;

    const st = this._interp();
    const scale = this.scale * this.dpr;
    ctx.setTransform(scale, 0, 0, scale, this.cx * this.dpr, this.cy * this.dpr);
    if (this.viewAngle) ctx.rotate(this.viewAngle);
    if (this.shake > 0.01) {
      ctx.translate((Math.random() - 0.5) * this.shake * 2, (Math.random() - 0.5) * this.shake * 2);
    }

    // fade the new arena in while the morph plays
    if (this.morph) {
      const t = this.morph.t / this.morph.dur;
      this.fade = clamp01((t - 0.35) / 0.65);
    } else {
      this.fade = 1;
    }

    this._drawArena(ctx, st);
    this._drawFlash(ctx);
    this._drawObstacles(ctx, st, now);
    if (st) this._drawBall(ctx, st);
    this._drawNames(ctx, st);
    this._drawEffects(ctx);
    if (this.morph) this._drawMorph(ctx);
    this._drawPlacement(ctx);
  }

  _interp() {
    const arr = this.snaps;
    if (!arr.length) return null;
    const now = performance.now() / 1000;
    const target = now - this.delay;
    if (arr.length === 1 || arr[arr.length - 1].t <= target) {
      const s = arr[arr.length - 1].s;
      return { ball: s.ball, players: s.players, snap: s };
    }
    let a = arr[0];
    let b = arr[arr.length - 1];
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i].t <= target && arr[i + 1].t >= target) {
        a = arr[i];
        b = arr[i + 1];
        break;
      }
    }
    const span = b.t - a.t || 1;
    const k = Math.max(0, Math.min(1, (target - a.t) / span));
    const players = a.s.players.map((pa) => {
      const pb = b.s.players.find((x) => x.id === pa.id) || pa;
      return { ...pb, pc: lerp(pa.pc, pb.pc, k) };
    });
    return {
      ball: {
        x: lerp(a.s.ball.x, b.s.ball.x, k),
        y: lerp(a.s.ball.y, b.s.ball.y, k),
      },
      players,
      snap: b.s,
    };
  }

  // -------------------------------------------------------------- drawing

  _line(ctx, a, b) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  /** Glowing wall; dims and breaks apart as the owner's health drops. */
  _drawWall(ctx, side, color, health, dim = 1) {
    const fade = this.fade;
    if (fade <= 0.01) return;
    const h = clamp01(health);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    // soft outer glow
    ctx.globalAlpha = (0.1 + 0.3 * h) * fade * dim;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14 + 16 * h;
    ctx.lineWidth = 7;
    this._line(ctx, side.p0, side.p1);
    // bright core, broken as health drops
    ctx.globalAlpha = (0.3 + 0.65 * h) * fade * dim;
    ctx.shadowBlur = 6 + 14 * h;
    ctx.lineWidth = 3;
    if (h < 0.999) {
      const dash = 12 + 26 * h;
      const gap = 5 + 30 * (1 - h);
      ctx.setLineDash([dash, gap]);
      ctx.lineDashOffset = -((this._now * (8 + 26 * (1 - h))) % (dash + gap));
    }
    this._line(ctx, side.p0, side.p1);
    ctx.restore();
  }

  _drawArena(ctx, st) {
    const byId = new Map((st?.players || []).map((p) => [p.id, p]));
    for (const side of this.poly.sides) {
      const meta = this.metaBySide.get(side.i);
      if (!meta) {
        this._drawWall(ctx, side, '#3b4d75', 1, 0.45);
        continue;
      }
      const sp = byId.get(meta.id);
      const alive = sp ? sp.al === 1 : true;
      const health = this.maxLives > 1 && sp ? clamp01(sp.lv / this.maxLives) : 1;
      this._drawWall(ctx, side, meta.color, alive ? health : 0);
      if (!alive || !sp) continue;

      const h = this.paddleLen / 2;
      const pc = (meta.id === this.you && this.selfPc !== null) ? this.selfPc : sp.pc;
      // float the paddle just in front of the goal line, like classic Pong
      const seg = paddleSegment(this.poly, this.paddleLen, side.i, pc);
      const a = { x: seg.ax, y: seg.ay };
      const b = { x: seg.bx, y: seg.by };
      ctx.save();
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = WORLD.PADDLE_THICK;
      ctx.lineCap = 'round';
      ctx.globalAlpha = (0.5 + 0.5 * health) * this.fade;
      ctx.shadowColor = meta.color;
      ctx.shadowBlur = (10 + 14 * health) * (meta.id === this.you ? 1.3 : 1);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawFlash(ctx) {
    const f = this.flash;
    if (!f || !this.poly) return;
    const t = clamp01(f.t / f.dur);
    const a = 1 - t;
    ctx.save();
    ctx.beginPath();
    this.poly.verts.forEach((v, i) => (i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y)));
    ctx.closePath();
    // full-arena wash
    ctx.globalAlpha = 0.14 * a;
    ctx.fillStyle = f.color;
    ctx.fill();
    // radial shading focused on the goal point
    const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, WORLD.R * 1.15);
    grad.addColorStop(0, hexA(f.color, 0.5 * a));
    grad.addColorStop(0.45, hexA(f.color, 0.22 * a));
    grad.addColorStop(1, hexA(f.color, 0));
    ctx.globalAlpha = 1;
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
  }

  _drawObstacles(ctx, st, now) {
    if (!st) return;
    for (const o of st.snap.obstacles || []) {
      const meta = this.metaById.get(o.o);
      const color = (meta && meta.color) || '#8ab4ff';
      const life = o.a ?? 1;
      if (o.k === 'l') {
        ctx.save();
        ctx.globalAlpha = (0.22 + 0.6 * life) * this.fade;
        ctx.strokeStyle = color;
        ctx.lineWidth = OBSTACLE.LINE_THICK;
        ctx.lineCap = 'round';
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        this._line(ctx, { x: o.x0, y: o.y0 }, { x: o.x1, y: o.y1 });
        ctx.restore();
      } else {
        const outer = o.outer || OBSTACLE.VORTEX_OUTER;
        const rot = now * 2.4;
        ctx.save();
        ctx.translate(o.x, o.y);
        ctx.globalAlpha = (0.12 + 0.5 * life) * this.fade;
        ctx.strokeStyle = color;
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          ctx.arc(0, 0, outer * 0.78, rot + k * (TAU / 3), rot + k * (TAU / 3) + 1.1);
          ctx.stroke();
        }
        ctx.globalAlpha *= 0.45;
        ctx.beginPath();
        ctx.arc(0, 0, outer * 0.32, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  _drawBall(ctx, st) {
    const now = performance.now() / 1000;
    const ball = st.ball;
    const speed = st.snap?.ball?.s ?? WORLD.BASE_SPEED;
    const heat = clamp01((speed - WORLD.BASE_SPEED) / 900);
    this.trail.push({ x: ball.x, y: ball.y, t: now });
    while (this.trail.length && this.trail[0].t < now - 0.28) this.trail.shift();

    for (const p of this.trail) {
      const age = (now - p.t) / 0.28;
      ctx.globalAlpha = (1 - age) * (0.28 + 0.3 * heat);
      ctx.fillStyle = heat > 0.55 ? '#ffd08a' : '#9ad6ff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, WORLD.BALL_R * (1 - age * 0.7) * (1 + 0.25 * heat), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.shadowColor = heat > 0.55 ? '#ffcf8a' : '#bfe6ff';
    ctx.shadowBlur = 18 + 24 * heat;
    ctx.fillStyle = heat > 0.6 ? '#fff4d6' : '#f2fbff';
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, WORLD.BALL_R * (1 + 0.3 * heat), 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  _drawNames(ctx, st) {
    if (!st) return;
    const byId = new Map(st.players.map((p) => [p.id, p]));
    const fs = 13 / this.scale;
    ctx.save();
    ctx.font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [sideIdx, meta] of this.metaBySide) {
      const side = this.poly.sides[sideIdx];
      if (!side) continue;
      const sp = byId.get(meta.id);
      const alive = sp ? sp.al === 1 : true;
      const x = side.cx + side.nx * 26;
      const y = side.cy + side.ny * 26;
      const label = meta.id === this.you ? `${meta.name} (you)` : meta.name;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-this.viewAngle);
      ctx.globalAlpha = (alive ? 0.95 : 0.35) * this.fade;
      ctx.fillStyle = meta.color;
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  _drawEffects(ctx) {
    if (!this.particles.length && !this.rings.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const r of this.rings) {
      const a = Math.max(0, r.life / r.maxLife);
      ctx.globalAlpha = a * 0.8 * r.alpha;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * (0.5 + a);
      ctx.beginPath();
      ctx.arc(r.x, r.y, Math.max(0.01, r.r), 0, TAU);
      ctx.stroke();
    }
    for (const p of this.particles) {
      const a = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = a * p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.01, p.size * (0.4 + 0.6 * a)), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Sample a polygon perimeter evenly, starting at the bottom side midpoint. */
  _outlinePoints(poly, k = 96) {
    const sides = poly.sides;
    const s0 = sides[0];
    const segs = [{ ax: s0.cx, ay: s0.cy, bx: s0.p1.x, by: s0.p1.y, len: s0.len / 2 }];
    for (let i = 1; i < sides.length; i++) {
      const s = sides[i];
      segs.push({ ax: s.p0.x, ay: s.p0.y, bx: s.p1.x, by: s.p1.y, len: s.len });
    }
    segs.push({ ax: s0.p0.x, ay: s0.p0.y, bx: s0.cx, by: s0.cy, len: s0.len / 2 });
    const total = segs.reduce((acc, s) => acc + s.len, 0);
    const pts = [];
    for (let i = 0; i < k; i++) {
      let d = (i / k) * total;
      let p = { x: 0, y: 0 };
      for (const s of segs) {
        if (d <= s.len) {
          const t = s.len > 0 ? d / s.len : 0;
          p = { x: lerp(s.ax, s.bx, t), y: lerp(s.ay, s.by, t) };
          break;
        }
        d -= s.len;
      }
      pts.push(p);
    }
    return pts;
  }

  _drawMorph(ctx) {
    const m = this.morph;
    const t = clamp01(m.t / m.dur);
    const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2; // easeInOutQuad
    const pts = m.prev.map((p, i) => ({
      x: lerp(p.x, m.next[i].x, e),
      y: lerp(p.y, m.next[i].y, e),
    }));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = '#9ad6ff';
    ctx.shadowColor = '#4aa8ff';
    ctx.shadowBlur = 26;
    ctx.globalAlpha = 0.9 * (1 - Math.abs(t - 0.5) * 0.5);
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  _drawPlacement(ctx) {
    const pl = this.placement;
    if (!pl || !pl.params) return;
    const ok = pl.valid;
    const color = ok ? '#3ddc97' : '#ff5d5d';
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    if (pl.kind === 'vortex') {
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(pl.params.x, pl.params.y, OBSTACLE.VORTEX_OUTER, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(pl.params.x, pl.params.y, OBSTACLE.VORTEX_CORE, 0, TAU);
      ctx.stroke();
    } else if (pl.kind === 'line') {
      const hx = Math.cos(pl.params.angle) * (OBSTACLE.LINE_LEN / 2);
      const hy = Math.sin(pl.params.angle) * (OBSTACLE.LINE_LEN / 2);
      ctx.lineWidth = OBSTACLE.LINE_THICK;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pl.params.x - hx, pl.params.y - hy);
      ctx.lineTo(pl.params.x + hx, pl.params.y + hy);
      ctx.stroke();
      if (pl.origin) {
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(pl.origin.x, pl.origin.y, 7, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}
