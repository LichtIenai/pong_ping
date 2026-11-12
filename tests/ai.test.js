import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../shared/engine.js';
import { polygon, sideU } from '../shared/geometry.js';
import { predictHitUForBall, interceptTarget } from '../shared/ai.js';
import { WORLD } from '../shared/constants.js';

test('predictHitUForBall finds where a ball crosses the requested wall', () => {
  const poly = polygon(4, WORLD.R);
  const side = poly.sides[0];

  const center = predictHitUForBall(poly, 0, {
    x: 0, y: 0, vx: side.nx * 400, vy: side.ny * 400, speed: 400,
  });
  assert.notEqual(center, null);
  assert.ok(Math.abs(center - side.len / 2) < 2, `center arrival (got ${center})`);

  const targetU = side.len * 0.3;
  const target = {
    x: side.p0.x + side.tx * targetU,
    y: side.p0.y + side.ty * targetU,
  };
  const offset = predictHitUForBall(poly, 0, {
    x: target.x - side.nx * 120,
    y: target.y - side.ny * 120,
    vx: side.nx * 400,
    vy: side.ny * 400,
    speed: 400,
  });
  assert.notEqual(offset, null);
  assert.ok(Math.abs(offset - targetU) < 2, `offset arrival (got ${offset}, want ${targetU})`);
});

test('predictHitUForBall bounces with the polygon walls and stays on the side', () => {
  const poly = polygon(5, WORLD.R);
  // Fire diagonally so the straight line would leave the arena long before
  // reaching side 3; the predictor must reflect off the other walls.
  const u = predictHitUForBall(poly, 3, {
    x: 0, y: 0, vx: 300, vy: -180, speed: Math.hypot(300, 180),
  }, 6);
  assert.notEqual(u, null);
  assert.ok(u >= 0 && u <= poly.sides[3].len, `arrival inside the side (got ${u})`);
});

test('predictHitUForBall rejects non-finite input', () => {
  const poly = polygon(3, WORLD.R);
  assert.equal(predictHitUForBall(poly, 0, { x: NaN, y: 0, vx: 1, vy: 1 }), null);
  assert.equal(predictHitUForBall(poly, 0, { x: 0, y: 0, vx: Infinity, vy: 1 }), null);
});

test('interceptTarget returns a normalized target that defends against the ball', () => {
  const poly = polygon(4, WORLD.R);
  const side = poly.sides[0];
  const target = interceptTarget(poly, 0, {
    x: 0, y: 0, vx: 0, vy: 400, speed: 400,
  }, 120, 30);
  assert.notEqual(target, null);
  assert.ok(target >= 0 && target <= 1);
  assert.ok(Math.abs(target - 0.5) < 0.01, `center serve aims at the paddle center (got ${target})`);
});

test('autoplay tracking concedes no reachable goal over 30s', () => {
  const DT = 1 / 60;
  const colors = ['#f00', '#0f0', '#00f'];
  const game = new Game({
    participants: colors.map((color, i) => ({ id: `p${i}`, name: `P${i}`, color })),
    settings: {
      lives: 99, speed: 'normal', ramp: 'normal', maxPlayers: 20,
      obstacles: true, autoRematch: true,
    },
    roundNo: 1,
  });
  const me = game.players[0];
  const goals = [];
  for (let i = 0; i < 30 / DT; i++) {
    const inputs = new Map();
    if (game.phase === 'play') {
      for (const p of game.players) {
        if (!p.alive) continue;
        const side = game.poly.sides[p.side];
        const b = game.ball;
        if (b.vx * side.nx + b.vy * side.ny <= 0) continue;
        const t = interceptTarget(game.poly, p.side, b, game.paddleLen, game.cornerInset);
        if (t !== null) inputs.set(p.id, t);
      }
    }
    game.tick(DT, inputs);
    for (const e of game.drainEvents()) {
      if (e.t === 'goal' && e.id === me.id) goals.push(e);
    }
  }
  const defensible = goals.filter((e) => {
    const side = game.poly.sides[e.side];
    const u = sideU(side, e.x, e.y);
    const inset = game.cornerInset;
    return u > inset - WORLD.BALL_R && u < side.len - inset + WORLD.BALL_R;
  });
  assert.equal(defensible.length, 0, `autoplay conceded reachable goals: ${JSON.stringify(defensible)}`);
});
