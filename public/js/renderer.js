// Canvas 2D renderer: polygon arena, paddles, ball + trail, obstacles, ghosts.
// Snapshots arrive at 30 Hz; drawing interpolates ~120 ms in the past for smoothness.

import { polygon } from '/shared/geometry.js';
import { WORLD, OBSTACLE } from '/shared/constants.js';
import { paddleLenFor } from '/shared/engine.js';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;

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
    const pad = 130;
    this.scale = Math.min(this.w, this.h) / (2 * (WORLD.R + pad));
    this.cx = this.w / 2;
    this.cy = this.h / 2;
  }

  setArena(arena, players) {
    this.arena = arena || null;
    if (!arena) {
      this.poly = null;
      this.paddleLen = 0;
      this.metaById = new Map();
      this.metaBySide = new Map();
      this._computeViewAngle();
      return;
    }
    this.poly = polygon(arena.n, arena.r);
    this.paddleLen = paddleLenFor(this.poly);
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
  }

  setYou(id) {
    this.you = id;
    this._computeViewAngle();
  }

  setViewMode(mode) {
    this.viewMode = mode === 'shared' ? 'shared' : 'own';
    this._computeViewAngle();
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

  render(now) {
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

    this._drawArena(ctx, st);
    this._drawObstacles(ctx, st, now);
    if (st) this._drawBall(ctx, st);
    this._drawNames(ctx, st);
    this._drawPlacement(ctx);
  }

  _drawArena(ctx, st) {
    const byId = new Map((st?.players || []).map((p) => [p.id, p]));
    for (const side of this.poly.sides) {
      const meta = this.metaBySide.get(side.i);
      if (!meta) {
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = '#3b4d75';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(side.p0.x, side.p0.y);
        ctx.lineTo(side.p1.x, side.p1.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        continue;
      }
      const sp = byId.get(meta.id);
      const alive = sp ? sp.al === 1 : true;

      // wall tint
      ctx.globalAlpha = alive ? 0.35 : 0.14;
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(side.p0.x, side.p0.y);
      ctx.lineTo(side.p1.x, side.p1.y);
      ctx.stroke();
      ctx.globalAlpha = 1;

      if (!alive) {
        // eliminated: dashed ghost wall
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.setLineDash([9, 9]);
        ctx.strokeStyle = meta.color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(side.p0.x, side.p0.y);
        ctx.lineTo(side.p1.x, side.p1.y);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if (!sp) continue;
      const h = this.paddleLen / 2;
      const pc = (meta.id === this.you && this.selfPc !== null) ? this.selfPc : sp.pc;
      const u0 = Math.max(0, pc - h);
      const u1 = Math.min(side.len, pc + h);
      const a = { x: side.p0.x + side.tx * u0, y: side.p0.y + side.ty * u0 };
      const b = { x: side.p0.x + side.tx * u1, y: side.p0.y + side.ty * u1 };
      ctx.save();
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = WORLD.PADDLE_THICK;
      ctx.lineCap = 'round';
      ctx.shadowColor = meta.color;
      ctx.shadowBlur = meta.id === this.you ? 20 : 12;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawObstacles(ctx, st, now) {
    if (!st) return;
    for (const o of st.snap.obstacles || []) {
      const meta = this.metaById.get(o.o);
      const color = (meta && meta.color) || '#8ab4ff';
      const life = o.a ?? 1;
      if (o.k === 'l') {
        ctx.save();
        ctx.globalAlpha = 0.22 + 0.6 * life;
        ctx.strokeStyle = color;
        ctx.lineWidth = OBSTACLE.LINE_THICK;
        ctx.lineCap = 'round';
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.moveTo(o.x0, o.y0);
        ctx.lineTo(o.x1, o.y1);
        ctx.stroke();
        ctx.restore();
      } else {
        const outer = o.outer || OBSTACLE.VORTEX_OUTER;
        const rot = now * 2.4;
        ctx.save();
        ctx.translate(o.x, o.y);
        ctx.globalAlpha = 0.12 + 0.5 * life;
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
    this.trail.push({ x: ball.x, y: ball.y, t: now });
    while (this.trail.length && this.trail[0].t < now - 0.26) this.trail.shift();

    for (const p of this.trail) {
      const age = (now - p.t) / 0.26;
      ctx.globalAlpha = (1 - age) * 0.3;
      ctx.fillStyle = '#9ad6ff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, WORLD.BALL_R * (1 - age * 0.7), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.shadowColor = '#bfe6ff';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#f2fbff';
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, WORLD.BALL_R, 0, TAU);
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
      ctx.globalAlpha = alive ? 0.95 : 0.35;
      ctx.fillStyle = meta.color;
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
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
