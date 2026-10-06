import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';

function mockClient() {
  return {
    room: null,
    playerId: null,
    msgs: [],
    raw: [],
    send(o) { this.msgs.push(o); },
    sendRaw(r) { this.raw.push(r); },
    ws: null,
  };
}

function makeRoom(memberCount = 2) {
  const room = new Room('TEST1', {});
  const clients = [];
  const members = [];
  for (let i = 0; i < memberCount; i++) {
    const c = mockClient();
    const res = room.addMember(c, `P${i}`);
    assert.ok(res.member, res.error);
    clients.push(c);
    members.push(res.member);
  }
  return { room, clients, members };
}

/** Every message a mock client received (direct sends + broadcasts). */
function received(c) {
  return c.msgs.concat(c.raw.map((r) => JSON.parse(r)));
}

test('room lifecycle: start, input, elimination, obstacle placement', () => {
  const { room, clients, members } = makeRoom(3);
  assert.equal(room.hostId, members[0].id);

  const res = room.startRound();
  assert.equal(res.ok, true);
  assert.equal(room.phase, 'playing');
  assert.equal(room.game.n, 3, 'three players get a triangle arena');

  // input is clamped and stored
  room.handle(clients[0], { t: 'input', target: 4 });
  assert.equal(room.inputs.get(members[0].id), 1);

  // alive player cannot place obstacles
  room.handle(clients[0], { t: 'place', kind: 'vortex', x: 0, y: 0 });
  assert.ok(clients[0].msgs.some((m) => m.t === 'err' && /eliminated/i.test(m.msg)));

  // eliminate the guest, then place two obstacles
  const bob = room.game.byId.get(members[1].id);
  bob.lives = 1;
  room.game._goal(bob, room.game.poly.sides[bob.side]);
  assert.equal(bob.alive, false);
  assert.equal(bob.charges, 2);

  room.handle(clients[1], { t: 'place', kind: 'vortex', x: 0, y: -50 });
  assert.equal(room.game.obstacles.length, 1);
  room.handle(clients[1], { t: 'place', kind: 'line', x: 0, y: 80, angle: 0 });
  assert.equal(room.game.obstacles.length, 2);
  room.handle(clients[1], { t: 'place', kind: 'vortex', x: 0, y: 150 });
  assert.equal(room.game.obstacles.length, 2, 'third placement is rejected');
  assert.equal(bob.charges, 0);

  // only the host can start or change settings
  room.handle(clients[1], { t: 'start' });
  assert.ok(clients[1].msgs.some((m) => m.msg === 'Only the host can start'));
  room.handle(clients[1], { t: 'settings', settings: { lives: 9 } });
  assert.ok(clients[1].msgs.some((m) => m.msg === 'Only the host can change settings'));
});

test('room: startRound requires two players and sends arena + state', () => {
  const { room, clients } = makeRoom(1);
  assert.equal(room.startRound().error, 'Need at least 2 connected players');

  const second = mockClient();
  room.addMember(second, 'P1');
  const res = room.startRound();
  assert.equal(res.ok, true);
  const all = received(clients[0]).concat(received(second));
  assert.ok(all.some((m) => m.t === 'state'));
  assert.ok(all.some((m) => m.t === 'arena' && m.n === 4));
});

test('room: disconnects keep the seat during grace, removal turns the side into a wall', () => {
  const { room, clients, members } = makeRoom(3);
  room.startRound();
  assert.equal(room.phase, 'playing');
  const [a, b, c] = members;

  // guest drops: marked disconnected, match continues
  room.handleDisconnect(clients[1]);
  assert.equal(room.game.byId.get(b.id).connected, false);
  assert.equal(room.phase, 'playing');

  // reclaim within grace: connected again
  const b2 = mockClient();
  const res = room.addMember(b2, 'P1', b.token);
  assert.equal(res.member.id, b.id, 'the same seat is reclaimed');
  assert.equal(room.game.byId.get(b.id).connected, true);
  assert.equal(b2.room, room);

  // host leaves permanently: migration + side becomes a wall
  room.handleDisconnect(clients[0]);
  assert.equal(room.hostId, b.id, 'host migrated to the next connected member');
  room._removeMember(a.id);
  room._removeMember(c.id);
  // only one player remains -> round over
  assert.equal(room.game.phase, 'over');
  assert.equal(room.phase, 'intermission');
});

test('room rebroadcasts the arena when it morphs', () => {
  const { room, clients, members } = makeRoom(3);
  room.startRound();
  assert.equal(room.game.n, 3);
  const bob = room.game.byId.get(members[1].id);
  bob.lives = 1;
  room.game._goal(bob, room.game.poly.sides[bob.side]);
  room.tick(1 / 60);
  const arenas = received(clients[0]).filter((m) => m.t === 'arena');
  assert.ok(arenas.some((m) => m.n === 4), 'head-to-head arena was broadcast after the morph');
  const last = arenas[arenas.length - 1];
  assert.deepEqual(
    last.players.filter((p) => p.side !== null).map((p) => p.side).sort(),
    [0, 2],
    'survivors own the bottom and top walls',
  );
});

test('room tracks a leaderboard and broadcasts it', () => {
  const { room, clients, members } = makeRoom(3);
  room.startRound();
  const [a, b, c] = members;
  const pa = room.game.byId.get(a.id);
  const pb = room.game.byId.get(b.id);

  pa.lives = 1;
  room.game._goal(pa, room.game.poly.sides[pa.side]);
  room.tick(1 / 60);
  assert.equal(room.stats.get(a.id).losses, 1, 'a conceded a life');
  assert.equal(room.stats.get(a.id).elims, 1, 'a was eliminated');

  room.handle(clients[0], { t: 'place', kind: 'vortex', x: 0, y: 0 });
  room.tick(1 / 60);
  assert.equal(room.stats.get(a.id).placed, 1, 'obstacle placement counted');

  pb.lives = 1;
  room.game._goal(pb, room.game.poly.sides[pb.side]);
  room.tick(1 / 60);
  assert.equal(room.stats.get(c.id).wins, 1, 'c won the round');

  const statsMsgs = received(clients[0]).filter((m) => m.t === 'stats');
  assert.ok(statsMsgs.length > 0, 'stats broadcast');
  const last = statsMsgs[statsMsgs.length - 1].list;
  assert.equal(last[0].id, c.id, 'the winner leads the leaderboard');
  assert.equal(last.find((s) => s.id === a.id).placed, 1);

  const welcome = room.welcomePayload(a.id);
  assert.equal(welcome.stats.length, 3, 'joiners receive the standings');
});

test('room: settings are clamped and half-time changes are locked', () => {
  const { room, clients } = makeRoom(2);
  room.handle(clients[0], {
    t: 'settings',
    settings: { lives: 99, speed: 'warp', ramp: 'nope', maxPlayers: 900, obstacles: false, autoRematch: 'x' },
  });
  assert.deepEqual(room.settings, {
    lives: 10, speed: 'normal', ramp: 'normal', maxPlayers: 20,
    obstacles: false, autoRematch: true,
  });

  room.startRound();
  room.handle(clients[0], { t: 'settings', settings: { lives: 1 } });
  assert.ok(clients[0].msgs.some((m) => m.msg === 'Settings are locked during a round'));
  assert.equal(room.settings.lives, 10);
});
