// Local PvE session: identical engine, bots instead of remote players.

import { Game } from '/shared/engine.js';
import { BotController, chooseBotPlacement, skillFor } from '/shared/ai.js';
import { BOT_NAMES, COLORS, WORLD } from '/shared/constants.js';

export class PveSession {
  constructor({ name, settings, bots, skill, hooks }) {
    this.name = name;
    this.settings = { ...settings };
    this.bots = Math.max(1, Math.min(9, Math.round(bots) || 3));
    this.skill = skill || 'normal';
    this.hooks = hooks || {};
    this.game = null;
    this.controllers = new Map();
    this.input = 0.5;
    this.interT = 0;
    this.roundNo = 0;
    this.pendingPlacements = [];
    this._newRound();
  }

  _newRound() {
    this.roundNo++;
    const pool = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    const participants = [{ id: 'you', name: this.name, color: COLORS[0] }];
    for (let i = 0; i < this.bots; i++) {
      participants.push({
        id: `bot${i + 1}`,
        name: pool[i % pool.length],
        color: COLORS[(i + 1) % COLORS.length],
        isBot: true,
        botSkill: this.skill,
        speedFactor: skillFor(this.skill).speedFactor,
      });
    }
    this.game = new Game({ participants, settings: this.settings, roundNo: this.roundNo });
    this.controllers.clear();
    for (const p of this.game.players) {
      if (p.isBot) {
        this.controllers.set(p.id, new BotController({
          player: p, game: this.game, skill: p.botSkill,
        }));
      }
    }
    this.pendingPlacements = [];
    this.interT = 0;
    this.input = 0.5;
    this.hooks.onArena?.({ n: this.game.n, r: WORLD.R, players: this.game.meta });
    this._emitState();
  }

  update(dt) {
    const g = this.game;
    if (!g || dt <= 0) return;

    if (this.interT > 0) {
      this.interT -= dt;
      const events = g.drainEvents();
      this._emitState();
      if (events.length) this.hooks.onEvents?.(events);
      if (this.interT <= 0) this._newRound();
      return;
    }
    if (g.phase === 'over') {
      this.interT = WORLD.INTERMISSION;
      this._emitState();
      return;
    }

    const inputs = new Map();
    inputs.set('you', this.input);
    for (const [id, ctrl] of this.controllers) inputs.set(id, ctrl.update(dt));
    g.tick(dt, inputs);
    this._handleBotPlacements();
    const events = g.drainEvents();
    this._emitState();
    if (events.length) {
      this.hooks.onEvents?.(events);
      if (events.some((e) => e.t === 'shrink')) {
        this.hooks.onArena?.({ n: this.game.n, r: WORLD.R, players: this.game.meta });
      }
    }
  }

  setInput(t) {
    this.input = t;
  }

  // NetSession-compatible API -------------------------------------------------

  sendInput(t) {
    this.setInput(t);
  }

  canPlace(kind, params) {
    if (!this.game) return { ok: false, reason: 'No game' };
    return this.game.canPlace('you', kind, params);
  }

  requestPlace(kind, params) {
    if (!this.game) return { ok: false, reason: 'No game' };
    return this.game.placeObstacle('you', kind, params);
  }

  updateSettings() { /* PvE settings are chosen in the setup screen */ }

  restart() {
    this._newRound();
  }

  leave() {
    this.game = null;
    this.controllers.clear();
  }

  // ------------------------------------------------------------------ internals

  _handleBotPlacements() {
    const g = this.game;
    if (!g || !this.settings.obstacles) return;

    for (const p of g.players) {
      if (!p.isBot || p.alive || p.removed || p.charges <= 0) continue;
      if (!this.pendingPlacements.some((q) => q.id === p.id)) {
        const s = skillFor(p.botSkill || this.skill);
        const delay = s.placeDelay[0] + Math.random() * (s.placeDelay[1] - s.placeDelay[0]);
        this.pendingPlacements.push({ id: p.id, at: g.time + delay, attempts: 0 });
      }
    }

    for (const q of [...this.pendingPlacements]) {
      if (g.time < q.at) continue;
      const p = g.byId.get(q.id);
      if (!p || p.alive || p.removed || p.charges <= 0) {
        this._dropPending(q);
        continue;
      }
      const choice = chooseBotPlacement(g, p.botSkill || this.skill);
      if (!choice) {
        q.attempts++;
        q.at = g.time + 1.2;
        if (q.attempts > 8) this._dropPending(q);
        continue;
      }
      const res = g.placeObstacle(p.id, choice.kind, choice.params);
      if (res.ok) this._dropPending(q);
      else {
        q.attempts++;
        q.at = g.time + 1;
        if (q.attempts > 8) this._dropPending(q);
      }
    }
  }

  _dropPending(q) {
    this.pendingPlacements = this.pendingPlacements.filter((x) => x !== q);
  }

  _emitState() {
    if (!this.game) return;
    const snap = this.game.snapshot();
    if (this.interT > 0) {
      snap.phase = 'intermission';
      snap.cd = Math.max(0, Math.round(this.interT * 10) / 10);
    }
    this.hooks.onState?.(snap);
  }
}
