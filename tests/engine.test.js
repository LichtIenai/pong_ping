import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, checkPlacement, arenaSidesFor, sideSlots, paddleSpeedFor, advancePaddle, paddleSegment } from '../shared/engine.js';
import { sideU, segSegDist } from '../shared/geometry.js';
import { WORLD, OBSTACLE } from '../shared/constants.js';

const DT = 1 / 60;

function participants(count) {
  const colors = ['#f00', '#0f0', '#00f', '#ff0', '#0ff', '#f0f'];
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`, name: `P${i}`, color: colors[i % colors.length],
  }));
}

function makeGame(count, settings = {}) {
  return new Game({
    participants: participants(count),
    settings: {
      lives: 3, speed: 'normal', ramp: 'off', maxPlayers: 20,
      obstacles: true, autoRematch: true, ...settings,
    },
    roundNo: 1,
  });
}

/** Inputs that put every (alive) paddle exactly where the ball will cross its side. */
function trackAll(game, inputs = new Map()) {
  const h = game.paddleLen / 2;
  for (const p of game.players) {
    if (!p.alive) continue;
    const side = game.poly.sides[p.side];
    const u = sideU(side, game.ball.x, game.ball.y);
    inputs.set(p.id, Math.max(0, Math.min(1, (u - h) / (side.len - h * 2))));
  }
  return inputs;
}

function run(game, seconds, inputFn) {
  const steps = Math.round(seconds / DT);
  const collected = [];
  for (let i = 0; i < steps; i++) {
    const inputs = inputFn ? inputFn(game, i) : null;
    game.tick(DT, inputs);
    collected.push(...game.drainEvents());
  }
  return collected;
}

test('arena sizing: 2 players use a square, everyone else a regular polygon', () => {
  assert.equal(arenaSidesFor(2), 4);
  assert.equal(arenaSidesFor(1), 4);
  assert.equal(arenaSidesFor(3), 3);
  assert.equal(arenaSidesFor(20), 20);
  assert.deepEqual(sideSlots(4, 2), [0, 2], 'heads-up uses opposite sides');
  assert.deepEqual(sideSlots(3, 3), [0, 1, 2]);
});

test('perfect tracking concedes nothing in reach and keeps the ball in bounds', () => {
  const game = makeGame(3, { lives: 99 });
  const events = run(game, 30, (g) => trackAll(g));
  const goals = events.filter((e) => e.t === 'goal');
  // With the corner inset, shots into the unreachable corner gap may score;
  // anything inside the reachable range would be a tracking failure.
  const defensible = goals.filter((e) => {
    const side = game.poly.sides[e.side];
    const u = sideU(side, e.x, e.y);
    const inset = game.cornerInset;
    return u > inset - WORLD.BALL_R && u < side.len - inset + WORLD.BALL_R;
  });
  assert.equal(defensible.length, 0, `defensible goals: ${JSON.stringify(defensible)}`);
  for (let i = 0; i < game.poly.sides.length; i++) {
    const sd = (game.ball.x * game.poly.sides[i].nx) + (game.ball.y * game.poly.sides[i].ny)
      - (game.poly.sides[i].p0.x * game.poly.sides[i].nx + game.poly.sides[i].p0.y * game.poly.sides[i].ny);
    assert.ok(sd < WORLD.BALL_R + 2, 'ball stays inside the arena');
  }
});

test('adjacent paddles never intersect at shared corners', () => {
  for (const count of [3, 4, 5, 6, 10, 20]) {
    const game = makeGame(count, { lives: 3 });
    const h = game.paddleLen / 2;
    for (const p of game.players) {
      const side = game.poly.sides[p.side];
      const next = game.players.find((q) => {
        const s2 = game.poly.sides[q.side];
        return Math.hypot(s2.p0.x - side.p1.x, s2.p0.y - side.p1.y) < 1;
      });
      if (!next) continue;
      p.pc = Math.max(h + game.cornerInset, side.len - h - game.cornerInset);
      next.pc = h + game.cornerInset;
      const sa = paddleSegment(game.poly, game.paddleLen, p.side, p.pc);
      const sb = paddleSegment(game.poly, game.paddleLen, next.side, next.pc);
      const d = segSegDist(sa.ax, sa.ay, sa.bx, sa.by, sb.ax, sb.ay, sb.bx, sb.by);
      assert.ok(
        d >= WORLD.PADDLE_THICK - 0.01,
        `${count}-gon corner clearance too small: ${d.toFixed(1)}`,
      );
    }
  }
});

test('covered center bounces; an uncovered spot on the same side concedes', () => {
  const game = makeGame(4, { lives: 1 });
  const idle = game.players[3];
  const side = game.poly.sides[idle.side];
  const h = game.paddleLen / 2;

  const aim = (u) => {
    const p = { x: side.p0.x + side.tx * u, y: side.p0.y + side.ty * u };
    game.phase = 'play';
    game.serveTimer = 0;
    game.ball.x = p.x - side.nx * 60;
    game.ball.y = p.y - side.ny * 60;
    game.ball.vx = side.nx * 300;
    game.ball.vy = side.ny * 300;
    game.ball.speed = 300;
  };

  // 1) dead center of the paddle: returned
  aim(idle.pc);
  let hit = false;
  for (let i = 0; i < 120 && !hit; i++) {
    game.tick(DT, null);
    const ev = game.drainEvents();
    if (ev.some((e) => e.t === 'hit' && e.id === idle.id)) hit = true;
    if (ev.some((e) => e.t === 'goal' && e.id === idle.id)) break;
  }
  assert.ok(hit, 'center shot is returned by the stationary paddle');
  assert.equal(idle.lives, 1);

  // 2) just outside the paddle's reach, still far from the corners: concedes
  aim(idle.pc + h + 30);
  let conceded = false;
  for (let i = 0; i < 120 && !conceded; i++) {
    game.tick(DT, null);
    for (const e of game.drainEvents()) {
      if (e.t === 'goal' && e.id === idle.id) conceded = true;
    }
  }
  assert.ok(conceded, 'the idle player conceded on the uncovered spot');
  assert.equal(idle.lives, 0);
  assert.equal(idle.alive, false);
  assert.equal(idle.charges, 2, 'elimination grants two obstacle charges');
});

test('paddles float in front of the goal line', () => {
  const game = makeGame(4, { lives: 1 });
  const p = game.players[0];
  const side = game.poly.sides[p.side];
  const u = p.pc;
  const px = side.p0.x + side.tx * u;
  const py = side.p0.y + side.ty * u;

  game.phase = 'play';
  game.serveTimer = 0;
  game.ball.x = px - side.nx * 120;
  game.ball.y = py - side.ny * 120;
  game.ball.vx = side.nx * 400;
  game.ball.vy = side.ny * 400;
  game.ball.speed = 400;

  let hitSd = null;
  for (let i = 0; i < 120; i++) {
    game.tick(DT, null);
    const ev = game.drainEvents();
    if (ev.some((e) => e.t === 'hit' && e.id === p.id)) {
      hitSd = (game.ball.x - side.p0.x) * side.nx + (game.ball.y - side.p0.y) * side.ny;
      break;
    }
    if (ev.some((e) => e.t === 'goal')) break;
  }
  assert.ok(hitSd !== null, 'ball bounced off the paddle');
  const expected = -(WORLD.PADDLE_OFFSET + WORLD.PADDLE_THICK + WORLD.BALL_R);
  assert.ok(
    hitSd <= expected + 1 && hitSd >= expected - 12,
    `bounce happens at the paddle's front face (sd=${hitSd.toFixed(1)}, expected ~${expected})`,
  );
});

test('speed ramp builds while nobody concedes and resets on a goal', () => {
  const game = makeGame(3, { ramp: 'fast' });
  const inputs = new Map();
  run(game, 10, (g) => trackAll(g, inputs));
  assert.ok(game.mult > 1.5, `ramp should build (got ${game.mult})`);
  assert.ok(game.ball.speed > game.baseSpeed * 1.5, 'ball speed follows the ramp');

  // stop playing and aim at an uncovered spot: the goal must reset the multiplier
  inputs.clear();
  for (const p of game.players) p.pc = game.poly.sides[p.side].len / 2;
  const victim = game.players[0];
  const side = game.poly.sides[victim.side];
  const u = victim.pc + game.paddleLen / 2 + 30;
  const point = { x: side.p0.x + side.tx * u, y: side.p0.y + side.ty * u };
  game.ball.x = point.x - side.nx * 40;
  game.ball.y = point.y - side.ny * 40;
  game.ball.vx = side.nx * 300;
  game.ball.vy = side.ny * 300;
  game.ball.speed = 300;

  let goal = false;
  for (let i = 0; i < 120 && !goal; i++) {
    game.tick(DT, null);
    for (const e of game.drainEvents()) if (e.t === 'goal') goal = true;
  }
  assert.ok(goal, 'a goal should happen on the uncovered spot');
  assert.equal(game.mult, 1);
});

test('obstacle placement rules: charges, margins, overlaps', () => {
  const game = makeGame(3);
  const p0 = game.players[0];
  // still alive: not allowed
  assert.equal(game.placeObstacle(p0.id, 'vortex', { x: 0, y: -100 }).ok, false);

  // eliminate them by hand (charges mirror the goal path)
  p0.alive = false;
  p0.charges = 2;
  game.ownerBySide.delete(p0.side);

  const first = game.placeObstacle(p0.id, 'vortex', { x: 0, y: -100 });
  assert.equal(first.ok, true, first.reason);
  assert.equal(p0.charges, 1);

  const tooClose = game.placeObstacle(p0.id, 'vortex', { x: 0, y: -150 });
  assert.equal(tooClose.ok, false, 'overlapping vortex rejected');

  const second = game.placeObstacle(p0.id, 'vortex', { x: 0, y: 100 });
  assert.equal(second.ok, true, second.reason);
  assert.equal(p0.charges, 0);

  const third = game.placeObstacle(p0.id, 'line', { x: 0, y: 0, angle: 0 });
  assert.equal(third.ok, false, 'no charges left');
  assert.match(third.reason, /charge/i);

  // wall margin
  const g2 = makeGame(3);
  const q = g2.players[1];
  q.alive = false;
  q.charges = 2;
  g2.ownerBySide.delete(q.side);
  assert.equal(g2.placeObstacle(q.id, 'line', { x: 0, y: 0, angle: 0 }).ok, true);
  assert.equal(g2.placeObstacle(q.id, 'line', { x: 0, y: -460, angle: 0 }).ok, false);
  assert.equal(g2.placeObstacle(q.id, 'line', { x: 0, y: 0, angle: 0 }).ok, false, 'duplicate rejected');
});

test('vortex captures the ball and ejects it with randomized speed', () => {
  const game = makeGame(3);
  const p0 = game.players[0];
  p0.alive = false;
  p0.charges = 2;
  game.ownerBySide.delete(p0.side);

  const res = game.placeObstacle(p0.id, 'vortex', { x: 0, y: 0 });
  assert.equal(res.ok, true, res.reason);
  assert.equal(game.obstacles.length, 1);

  game.phase = 'play';
  game.ball.x = 5;
  game.ball.y = 0;
  game.ball.vx = 100;
  game.ball.vy = 0;
  game.ball.speed = 200;
  game.serveTimer = 0;

  game.tick(DT, null);
  const events = game.drainEvents();
  assert.ok(events.some((e) => e.t === 'vortex'), 'capture event emitted');
  assert.equal(game.obstacles.length, 0, 'vortex is consumed');
  assert.ok(game.ball.speed >= 140, 'eject speed randomized but sane');
  assert.ok(Math.hypot(game.ball.x, game.ball.y) > OBSTACLE.VORTEX_CORE, 'ball leaves the core');
});

test('line obstacle validates via checkPlacement and reflects the ball', () => {
  const game = makeGame(3);
  const ok = checkPlacement(game.poly, [], 'line', { x: 0, y: 0, angle: Math.PI / 2 });
  assert.equal(ok.ok, true);

  const p0 = game.players[0];
  p0.alive = false;
  p0.charges = 1;
  game.ownerBySide.delete(p0.side);
  assert.equal(game.placeObstacle(p0.id, 'line', { x: 0, y: 0, angle: Math.PI / 2 }).ok, true);

  game.phase = 'play';
  game.ball.x = -30;
  game.ball.y = 0;
  game.ball.vx = 200;
  game.ball.vy = 0;
  game.ball.speed = 200;
  let bounced = false;
  for (let i = 0; i < 60 && !bounced; i++) {
    game.tick(DT, null);
    const ev = game.drainEvents();
    if (ev.some((e) => e.t === 'bounce' && e.o === 'line')) bounced = true;
  }
  assert.ok(bounced, 'ball bounced off the barrier');
  assert.ok(game.ball.vx < 0, 'velocity reversed by the barrier');
});

test('paddle speed scales with side length and keeps traversal ~0.3s', () => {
  assert.equal(paddleSpeedFor(70), WORLD.PADDLE_SPEED_MIN);
  assert.equal(paddleSpeedFor(100000), WORLD.PADDLE_SPEED_MAX);
  const big = paddleSpeedFor(489);
  assert.ok(Math.abs(big - 489 / WORLD.PADDLE_TRAVERSE) < 1e-6);
  assert.equal(advancePaddle(0, 1, big, WORLD.PADDLE_TRAVERSE, 0, 489), 489);
  assert.equal(advancePaddle(0, 0.5, 100, 1, 0, 100), 50);
  assert.equal(advancePaddle(0, 2, 1000, 1, 0, 100), 100, 'targets are clamped');
});

test('arena morphs as players are eliminated (4 -> 3 -> 2)', () => {
  const game = makeGame(4, { lives: 1 });
  const [a, b, c, d] = game.players;
  assert.equal(game.n, 4);

  game._goal(a, game.poly.sides[a.side]);
  assert.equal(a.alive, false);
  assert.equal(game.n, 3, 'square becomes a triangle');
  assert.ok(game.events.some((e) => e.t === 'shrink' && e.n === 3));
  assert.equal(a.charges, 2);
  const sides = new Set([b, c, d].map((p) => p.side));
  assert.equal(sides.size, 3, 'survivors get unique sides');
  assert.ok([...sides].every((s) => s >= 0 && s < 3));
  assert.equal(game.ball.x, 0, 'ball is parked for the serve');

  game._goal(b, game.poly.sides[b.side]);
  assert.equal(game.n, 4, 'two survivors get the head-to-head rectangle');
  assert.deepEqual([c, d].map((p) => p.side).sort(), [0, 2], 'walls are bottom and top');
  assert.ok(!game.ownerBySide.has(1) && !game.ownerBySide.has(3), 'end walls are neutral');

  const meta = game.meta;
  assert.equal(meta.find((m) => m.id === a.id).side, null, 'eliminated players have no side');
  assert.equal(meta.filter((m) => m.side !== null).length, 2);
});

test('arena shrink washes away obstacles that no longer fit', () => {
  const game = makeGame(4, { lives: 1 });
  game.obstacles.push({
    kind: 'vortex', x: 0, y: 200, outer: 72, core: 22, ownerId: 'x', life: 10, lifeMax: 15,
  });
  const a = game.players[0];
  game._goal(a, game.poly.sides[a.side]);
  assert.equal(game.n, 3);
  assert.equal(game.obstacles.length, 0, 'vortex near the old bottom wall is washed away');
  assert.ok(game.events.some((e) => e.t === 'wash'), 'wash event emitted');
});

test('removing a player mid-rally queues the morph until the next serve', () => {
  const game = makeGame(4, { lives: 3 });
  game._serve();
  assert.equal(game.phase, 'play');
  game.removePlayer(game.players[3].id);
  assert.equal(game.n, 4, 'shape stays during the rally');
  assert.equal(game._shrinkPending, true);
  game._serve();
  assert.equal(game.n, 3, 'morph applied on the next serve');
});

test('20-player soak: no crashes, NaN, or escapees', () => {
  const game = makeGame(20, { lives: 10 });
  const inputs = new Map();
  let rngState = 42;
  const rng = () => {
    rngState = (rngState * 1103515245 + 12345) % 2147483648;
    return rngState / 2147483648;
  };
  for (let i = 0; i < Math.round(20 / DT); i++) {
    if (i % 18 === 0) {
      for (const p of game.players) inputs.set(p.id, rng());
    }
    game.tick(DT, inputs);
    game.drainEvents();
    assert.ok(Number.isFinite(game.ball.x) && Number.isFinite(game.ball.y), 'ball position finite');
    assert.ok(Math.hypot(game.ball.x, game.ball.y) < WORLD.R * 1.5, 'ball inside a sane bound');
    for (const p of game.players) {
      assert.ok(p.lives >= 0, 'lives never negative');
      assert.ok(Number.isFinite(p.pc), 'paddle coordinate finite');
    }
  }
});
