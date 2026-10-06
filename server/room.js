// One PvP room: membership, lobby settings, round lifecycle and broadcasts.

import crypto from 'node:crypto';
import { Game } from '../shared/engine.js';
import { cleanName, cleanSettings, clampTarget } from '../shared/protocol.js';
import { COLORS, WORLD } from '../shared/constants.js';

const GRACE_MS = 45000;

export class Room {
  constructor(code, manager) {
    this.code = code;
    this.manager = manager;
    this.members = new Map();   // id -> member
    this.hostId = null;
    this.settings = cleanSettings({});
    this.phase = 'lobby';       // 'lobby' | 'playing' | 'intermission'
    this.game = null;
    this.inputs = new Map();    // playerId -> target [0,1]
    this.roundNo = 0;
    this.interT = 0;
    this.stateAcc = 0;
    this.orderSeq = 0;
    this.colorSeq = 0;
    this.stats = new Map();     // playerId -> { wins, losses, elims, placed }
    this.emptySince = 0;
    this.createdAt = Date.now();
  }

  // ------------------------------------------------------------- membership

  addMember(client, name, token) {
    if (token) {
      for (const m of this.members.values()) {
        // only a disconnected seat can be reclaimed; a live one keeps its owner
        if (m.token === token && !m.connected) return { member: this._reconnect(m, client) };
      }
    }
    if (this.members.size >= this.settings.maxPlayers) return { error: 'Room is full' };
    const id = crypto.randomUUID();
    const member = {
      id,
      name: cleanName(name),
      color: COLORS[this.colorSeq++ % COLORS.length],
      token: crypto.randomUUID(),
      client,
      connected: true,
      order: this.orderSeq++,
      graceTimer: null,
    };
    this.members.set(id, member);
    client.room = this;
    client.playerId = id;
    if (!this.hostId) this.hostId = id;
    this.emptySince = 0;
    return { member };
  }

  _reconnect(member, client) {
    if (member.graceTimer) {
      clearTimeout(member.graceTimer);
      member.graceTimer = null;
    }
    if (member.client && member.client !== client) {
      try {
        member.client.send({ t: 'err', msg: 'Session was claimed by a new connection' });
        member.client.ws?.close();
      } catch { /* ignore */ }
    }
    member.client = client;
    member.connected = true;
    client.room = this;
    client.playerId = member.id;
    this.emptySince = 0;
    if (this.game) this.game.setConnected(member.id, true);
    return member;
  }

  handleDisconnect(client) {
    const m = client.playerId ? this.members.get(client.playerId) : null;
    if (!m || m.client !== client) return;
    m.connected = false;
    m.client = null;
    if (this.game) this.game.setConnected(m.id, false);
    if (this.hostId === m.id) this._migrateHost();
    this.broadcastLobby();
    m.graceTimer = setTimeout(() => this._removeMember(m.id), GRACE_MS);
    m.graceTimer.unref?.();
  }

  leave(client) {
    const id = client.playerId;
    if (!id) return;
    client.room = null;
    client.playerId = null;
    this._removeMember(id);
  }

  _removeMember(id) {
    const m = this.members.get(id);
    if (!m) return;
    if (m.graceTimer) clearTimeout(m.graceTimer);
    this.members.delete(id);
    this.inputs.delete(id);
    this.stats.delete(id);
    if (this.game) this.game.removePlayer(id);
    if (this.hostId === id) this._migrateHost();
    this._checkRoundOver();
    this.broadcastLobby();
    this.broadcastStats();
    if (this.members.size === 0) this.emptySince = Date.now();
  }

  _migrateHost() {
    const next = [...this.members.values()]
      .filter((m) => m.connected)
      .sort((a, b) => a.order - b.order)[0];
    this.hostId = next ? next.id : null;
  }

  // ---------------------------------------------------------------- payloads

  publicPlayers() {
    return [...this.members.values()]
      .sort((a, b) => a.order - b.order)
      .map((m) => ({
        id: m.id,
        name: m.name,
        color: m.color,
        connected: m.connected,
        host: m.id === this.hostId,
        spectator: !!this.game && !this.game.byId.has(m.id),
      }));
  }

  arenaPayload() {
    return this.game ? { n: this.game.n, r: WORLD.R, players: this.game.meta } : null;
  }

  welcomePayload(memberId) {
    const m = this.members.get(memberId);
    return {
      you: memberId,
      token: m.token,
      code: this.code,
      hostId: this.hostId,
      settings: this.settings,
      phase: this.phase,
      roundNo: this.roundNo,
      players: this.publicPlayers(),
      arena: this.arenaPayload(),
      stats: this.statsPayload(),
    };
  }

  _stat(id) {
    let s = this.stats.get(id);
    if (!s) {
      s = { wins: 0, losses: 0, elims: 0, placed: 0 };
      this.stats.set(id, s);
    }
    return s;
  }

  statsPayload() {
    const list = [...this.members.values()]
      .sort((a, b) => a.order - b.order)
      .map((m) => ({
        id: m.id,
        name: m.name,
        color: m.color,
        ...(this.stats.get(m.id) || { wins: 0, losses: 0, elims: 0, placed: 0 }),
      }));
    list.sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.name.localeCompare(b.name));
    return list;
  }

  broadcastStats() {
    this.broadcast({ t: 'stats', list: this.statsPayload() });
  }

  _snapshot() {
    if (!this.game) return null;
    const snap = this.game.snapshot();
    if (this.phase === 'intermission') {
      snap.phase = 'intermission';
      snap.cd = Math.max(0, Math.round(this.interT * 10) / 10);
    }
    return snap;
  }

  sendRawTo(client, raw) {
    if (client) client.sendRaw(raw);
  }

  broadcast(msg, exceptId = null) {
    const raw = JSON.stringify(msg);
    for (const m of this.members.values()) {
      if (!m.connected || !m.client) continue;
      if (exceptId && m.id === exceptId) continue;
      m.client.sendRaw(raw);
    }
  }

  broadcastLobby() {
    this.broadcast({
      t: 'lobby',
      code: this.code,
      hostId: this.hostId,
      settings: this.settings,
      phase: this.phase,
      roundNo: this.roundNo,
      players: this.publicPlayers(),
    });
  }

  broadcastState() {
    const snap = this._snapshot();
    if (snap) this.broadcast({ t: 'state', ...snap });
  }

  sendStateTo(client) {
    const snap = this._snapshot();
    if (snap) this.sendRawTo(client, JSON.stringify({ t: 'state', ...snap }));
  }

  // ------------------------------------------------------------ round admin

  startRound() {
    const connected = [...this.members.values()]
      .filter((m) => m.connected)
      .sort((a, b) => a.order - b.order)
      .slice(0, this.settings.maxPlayers);
    if (connected.length < 2) return { error: 'Need at least 2 connected players' };
    this.roundNo++;
    this.game = new Game({
      participants: connected.map((m) => ({ id: m.id, name: m.name, color: m.color })),
      settings: this.settings,
      roundNo: this.roundNo,
    });
    this.inputs.clear();
    this.phase = 'playing';
    this.stateAcc = 1;
    this.broadcastLobby();
    this.broadcast({ t: 'arena', ...this.arenaPayload() });
    this.broadcastState();
    return { ok: true };
  }

  _checkRoundOver() {
    if (this.phase !== 'playing' || !this.game || this.game.phase !== 'over') return;
    this.phase = 'intermission';
    this.interT = WORLD.INTERMISSION;
    this.broadcastLobby();
  }

  // -------------------------------------------------------------- messages

  handle(client, msg) {
    const id = client.playerId;
    const member = id ? this.members.get(id) : null;
    if (!member) return;

    switch (msg.t) {
      case 'input': {
        if (this.phase !== 'playing' || !this.game) return;
        const p = this.game.byId.get(id);
        if (!p || !p.alive || p.removed) return;
        const t = clampTarget(msg.target);
        if (t !== null) this.inputs.set(id, t);
        return;
      }
      case 'place': {
        if (this.phase !== 'playing' || !this.game) {
          return client.send({ t: 'err', msg: 'No match running' });
        }
        const res = this.game.placeObstacle(id, msg.kind, msg);
        if (!res.ok) client.send({ t: 'err', msg: res.reason || 'Cannot place that here' });
        return;
      }
      case 'start': {
        if (id !== this.hostId) return client.send({ t: 'err', msg: 'Only the host can start' });
        if (this.phase === 'playing') return;
        const res = this.startRound();
        if (res.error) client.send({ t: 'err', msg: res.error });
        return;
      }
      case 'settings': {
        if (id !== this.hostId) return client.send({ t: 'err', msg: 'Only the host can change settings' });
        if (this.phase === 'playing') return client.send({ t: 'err', msg: 'Settings are locked during a round' });
        if (msg.settings?.maxPlayers < this.members.size) {
          return client.send({ t: 'err', msg: `There are already ${this.members.size} players` });
        }
        this.settings = cleanSettings(msg.settings);
        this.broadcastLobby();
        return;
      }
      case 'rename': {
        const p = this.game ? this.game.byId.get(id) : null;
        if (this.phase === 'playing' && p && p.alive && !p.removed) {
          return client.send({ t: 'err', msg: 'You cannot rename during a round' });
        }
        member.name = cleanName(msg.name, member.name);
        if (p) p.name = member.name;
        this.broadcastLobby();
        this.broadcastStats();
        if (this.game) this.broadcast({ t: 'arena', ...this.arenaPayload() });
        return;
      }
      case 'ping':
        client.send({ t: 'pong', ts: msg.ts });
        return;
      case 'leave':
        this.leave(client);
        return;
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ loop

  tick(dt) {
    if (this.phase === 'playing' && this.game) {
      this.game.tick(dt, this.inputs);
      const ev = this.game.drainEvents();
      if (ev.length) {
        this.broadcast({ t: 'events', list: ev });
        let statsChanged = false;
        for (const e of ev) {
          if (e.t === 'goal') {
            this._stat(e.id).losses++;
            statsChanged = true;
          } else if (e.t === 'elim') {
            this._stat(e.id).elims++;
            statsChanged = true;
          } else if (e.t === 'over' && e.id) {
            this._stat(e.id).wins++;
            statsChanged = true;
          } else if (e.t === 'place') {
            this._stat(e.id).placed++;
            statsChanged = true;
          }
        }
        if (statsChanged) this.broadcastStats();
        if (ev.some((e) => e.t === 'shrink') && this.arenaPayload()) {
          this.broadcast({ t: 'arena', ...this.arenaPayload() });
        }
      }
      this.stateAcc += dt;
      if (this.stateAcc >= 1 / 30) {
        this.stateAcc = 0;
        this.broadcastState();
      }
      this._checkRoundOver();
    } else if (this.phase === 'intermission' && this.game) {
      this.interT -= dt;
      this.stateAcc += dt;
      if (this.stateAcc >= 0.2) {
        this.stateAcc = 0;
        this.broadcastState();
      }
      if (this.interT <= 0) {
        if (this.settings.autoRematch) {
          const res = this.startRound();
          if (res.error) {
            this.phase = 'lobby';
            this.broadcastLobby();
          }
        } else {
          this.phase = 'lobby';
          this.broadcastLobby();
        }
      }
    }
  }
}
