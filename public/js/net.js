// WebSocket session for PvP: reconnect with token, input throttling, placement preview.

import { normalizeObstacle, canPlaceInSnapshot } from '/shared/engine.js';

export class NetSession {
  constructor(opts) {
    this.mode = opts.mode;            // 'create' | 'join'
    this.name = opts.name;
    this.code = opts.code || null;
    this.settings = opts.settings || null;
    this.token = opts.token || null;
    this.hooks = opts.hooks || {};

    this.ws = null;
    this.closed = false;
    this.retry = 500;
    this.you = null;
    this.arena = null;
    this.lastSnap = null;
    this.lastSent = -1;
    this.lastSentAt = 0;
    this.rtt = 0;
    this._pingTimer = null;
  }

  connect() {
    this._open();
  }

  _open() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      this._scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 500;
      this.hooks.onStatus?.('connected');
      this._startPing();
      if (this.mode === 'create') {
        this._send({ t: 'create', name: this.name, settings: this.settings });
      } else {
        this._send({ t: 'join', code: this.code, name: this.name, token: this.token });
      }
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this._onMsg(msg);
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.hooks.onStatus?.('reconnecting');
      this._scheduleRetry();
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* ignore */ }
    };
  }

  _scheduleRetry() {
    if (this.closed) return;
    const delay = this.retry;
    this.retry = Math.min(this.retry * 1.7, 6000);
    setTimeout(() => this._open(), delay);
  }

  _startPing() {
    clearInterval(this._pingTimer);
    const ping = () => this._send({ t: 'ping', ts: performance.now() });
    ping();
    this._pingTimer = setInterval(ping, 3000);
  }

  _onMsg(msg) {
    switch (msg.t) {
      case 'joined':
        this.you = msg.you;
        this.token = msg.token;
        this.code = msg.code;
        this.settings = msg.settings;
        if (msg.arena) this.arena = msg.arena;
        this.mode = 'join'; // reconnects rejoin the same room
        this.hooks.onJoined?.(msg);
        break;
      case 'lobby':
        this.settings = msg.settings;
        this.hooks.onLobby?.(msg);
        break;
      case 'arena':
        this.arena = msg;
        this.hooks.onArena?.(msg);
        break;
      case 'state':
        this.lastSnap = msg;
        this.hooks.onState?.(msg);
        break;
      case 'events':
        this.hooks.onEvents?.(msg.list || []);
        break;
      case 'stats':
        this.hooks.onStats?.(msg.list || []);
        break;
      case 'err':
        this.hooks.onError?.(msg.msg || 'Server error');
        break;
      case 'pong':
        this.rtt = Math.max(0, performance.now() - Number(msg.ts || 0));
        this.hooks.onPong?.(this.rtt);
        break;
      default:
        break;
    }
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  }

  sendInput(target) {
    const now = performance.now();
    if (Math.abs(target - this.lastSent) < 0.002 && now - this.lastSentAt < 120) return;
    this.lastSent = target;
    this.lastSentAt = now;
    this._send({ t: 'input', target });
  }

  canPlace(kind, params) {
    if (!this.settings || !this.settings.obstacles) return { ok: false, reason: 'Obstacles are disabled' };
    if (!this.arena) return { ok: false, reason: 'No arena yet' };
    const obstacles = (this.lastSnap?.obstacles || []).map(normalizeObstacle);
    return canPlaceInSnapshot(this.arena, obstacles, this.settings, kind, params);
  }

  requestPlace(kind, params) {
    this._send({ t: 'place', kind, ...params });
    return { ok: true };
  }

  updateSettings(settings) {
    this._send({ t: 'settings', settings });
  }

  start() {
    this._send({ t: 'start' });
  }

  rename(name) {
    this._send({ t: 'rename', name });
  }

  update() { /* state arrives via messages */ }

  leave() {
    this.closed = true;
    clearInterval(this._pingTimer);
    this._send({ t: 'leave' });
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  destroy() {
    this.leave();
  }
}
