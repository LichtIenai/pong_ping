// Screen router + session wiring. PvE runs locally, PvP over the WebSocket.

import { DEFAULT_SETTINGS } from '/shared/constants.js';
import { Renderer } from './renderer.js';
import { InputController } from './input.js';
import { PveSession } from './pve.js';
import { NetSession } from './net.js';
import { PaddlePredictor } from './predict.js';
import { sfx } from './sfx.js';
import * as ui from './ui.js';

const state = {
  name: '',
  mode: null,        // 'pve' | 'net'
  session: null,
  you: null,
  roomCode: null,
  lobby: null,       // last lobby payload
  arena: null,       // { n, r, players }
  snap: null,        // last snapshot
  settings: { ...DEFAULT_SETTINGS },
  viewMode: 'own',
  predictedPc: null,
  paused: false,
  placing: null,
};

const nameInput = ui.$('#name-input');
const joinCodeInput = ui.$('#join-code');
const canvas = ui.$('#canvas');
const renderer = new Renderer(canvas);
const predictor = new PaddlePredictor();

// ------------------------------------------------------------------ identity

{
  let stored = localStorage.getItem('pp:name');
  if (!stored) {
    stored = `Player${1000 + Math.floor(Math.random() * 9000)}`;
    localStorage.setItem('pp:name', stored);
  }
  state.name = stored;
  nameInput.value = stored;
  nameInput.addEventListener('input', () => {
    const v = nameInput.value.trim().slice(0, 16);
    if (v) {
      state.name = v;
      localStorage.setItem('pp:name', v);
    }
  });
}

function currentName() {
  const n = nameInput.value.trim().slice(0, 16);
  if (n) {
    state.name = n;
    localStorage.setItem('pp:name', n);
    return n;
  }
  if (!state.name) state.name = `Player${1000 + Math.floor(Math.random() * 9000)}`;
  return state.name;
}

// --------------------------------------------------------------------- input

const input = new InputController({
  canvas,
  renderer,
  getContext: () => {
    if (!state.snap || !state.arena || !renderer.poly) return null;
    const me = state.snap.players.find((p) => p.id === state.you);
    if (!me) return null;
    const side = renderer.poly.sides[me.side];
    if (!side) return null;
    const active = state.snap.phase === 'play' || state.snap.phase === 'serve';
    return { side, paddleLen: renderer.paddleLen, canControl: me.al === 1 && active };
  },
  onInput: (t) => state.session?.sendInput(t),
});

input.setValidator((kind, params) => (
  state.session ? state.session.canPlace(kind, params) : { ok: false }
));

input.setConfirmer((kind, params) => {
  if (!state.session) return;
  const res = state.session.requestPlace(kind, params);
  if (res && res.ok === false) ui.toast(res.reason || 'Cannot place that here', true);
  else if (state.mode === 'pve') sfx.place();
  state.placing = null;
  input.cancelPlacement(true);
  updatePowerbar();
});

input.setPlacementListener((kind) => {
  state.placing = kind;
  updatePowerbar();
});

input.onEscape = () => {
  if (state.mode === 'pve' && state.session) togglePause();
};

// -------------------------------------------------------------------- screens

const pveForm = ui.buildSettings(ui.$('#pve-settings'), { showBots: true });
pveForm.set({ lives: 3, speed: 'normal', ramp: 'normal', obstacles: true, bots: 3, skill: 'normal' });

const lobbyForm = ui.buildSettings(ui.$('#lobby-settings'), {
  showHost: true,
  onChange: (form) => {
    if (state.mode !== 'net' || !state.lobby) return;
    if (state.lobby.hostId !== state.you || state.lobby.phase !== 'lobby') return;
    state.session?.updateSettings(form.get());
  },
});

ui.$('#btn-pve').addEventListener('click', () => ui.showScreen('screen-pve'));
ui.$$('[data-back]').forEach((b) => b.addEventListener('click', () => ui.showScreen('screen-menu')));

ui.$('#btn-pve-start').addEventListener('click', startPve);
ui.$('#btn-host').addEventListener('click', hostRoom);
ui.$('#btn-join').addEventListener('click', () => joinRoom(joinCodeInput.value));
joinCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom(joinCodeInput.value);
});

ui.$('#btn-room-leave').addEventListener('click', quitGame);
ui.$('#btn-exit').addEventListener('click', () => {
  if (state.mode === 'pve') togglePause();
  else quitGame();
});
ui.$('#btn-copy').addEventListener('click', async () => {
  const url = `${location.origin}/?room=${state.roomCode || ''}`;
  try {
    await navigator.clipboard.writeText(url);
    ui.toast('Invite link copied');
  } catch {
    ui.toast(url);
  }
});

const soundBtn = ui.$('#btn-sound');
function refreshSound() {
  soundBtn.textContent = `Sound: ${sfx.muted ? 'Off' : 'On'}`;
}
soundBtn.addEventListener('click', () => {
  sfx.toggle();
  refreshSound();
});
refreshSound();

// --------------------------------------------------------------------- camera

function setViewMode(mode) {
  state.viewMode = mode === 'shared' ? 'shared' : 'own';
  localStorage.setItem('pp:view', state.viewMode);
  renderer.setViewMode(state.viewMode);
  ui.$$('[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.viewMode);
  });
  ui.$('#btn-view').textContent = state.viewMode === 'own' ? 'View: Mine' : 'View: Shared';
  updateHint();
}

ui.$('#menu-view').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) setViewMode(b.dataset.view);
});
ui.$('#btn-view').addEventListener('click', () => {
  setViewMode(state.viewMode === 'own' ? 'shared' : 'own');
});
setViewMode(localStorage.getItem('pp:view') === 'shared' ? 'shared' : 'own');

ui.$('#powerbar').addEventListener('click', (e) => {
  const place = e.target.closest('[data-place]');
  const cancel = e.target.closest('[data-cancel]');
  if (place) {
    const kind = place.dataset.place;
    if (state.placing === kind) {
      state.placing = null;
      input.cancelPlacement();
    } else {
      state.placing = kind;
      input.enterPlacement(kind);
    }
    updatePowerbar();
  } else if (cancel) {
    state.placing = null;
    input.cancelPlacement();
    updatePowerbar();
  }
});

// ------------------------------------------------------------------- helpers

function setArena(arena) {
  state.arena = arena;
  predictor.ready = false;
  renderer.setArena(arena, arena ? arena.players : []);
  renderer.setYou(state.you);
}

function hudLabel() {
  if (state.mode === 'pve') return `PvE · Round ${state.session?.roundNo ?? 1}`;
  return state.roomCode ? `Room ${state.roomCode}` : 'Room';
}

function nameOf(id) {
  const a = state.arena?.players.find((p) => p.id === id);
  if (a) return a.name;
  const l = state.lobby?.players.find((p) => p.id === id);
  return l ? l.name : 'Someone';
}

function enterGame() {
  ui.hideOverlay();
  ui.showScreen('screen-game');
  renderer.delay = state.mode === 'pve' ? 0.016 : 0.07;
  requestAnimationFrame(() => renderer.resize());
  updateHud();
}

function quitGame() {
  try { state.session?.leave(); } catch { /* ignore */ }
  state.session = null;
  state.mode = null;
  state.you = null;
  state.roomCode = null;
  state.lobby = null;
  state.arena = null;
  state.snap = null;
  state.paused = false;
  state.placing = null;
  state.predictedPc = null;
  predictor.ready = false;
  renderer.selfPc = null;
  renderer.setArena(null, []);
  input.cancelPlacement(true);
  ui.hideOverlay();
  ui.showScreen('screen-menu');
}

function togglePause(force) {
  if (state.mode !== 'pve' || !state.session) return;
  state.paused = force === undefined ? !state.paused : !!force;
  updateOverlay();
}

// ------------------------------------------------------------------- PvE flow

function startPve() {
  const v = pveForm.get();
  state.mode = 'pve';
  state.you = 'you';
  state.roomCode = null;
  state.paused = false;
  state.placing = null;
  state.settings = {
    lives: v.lives, speed: v.speed, ramp: v.ramp,
    maxPlayers: 20, obstacles: v.obstacles, autoRematch: true,
  };
  state.session = new PveSession({
    name: currentName(),
    settings: state.settings,
    bots: v.bots,
    skill: v.skill,
    hooks: {
      onArena: (arena) => setArena(arena),
      onState: (snap) => onState(snap),
      onEvents: (list) => onEvents(list),
    },
  });
  enterGame();
}

// ------------------------------------------------------------------- PvP flow

function netHooks() {
  return {
    onStatus: (s) => {
      ui.$('#conn').classList.toggle('hidden', s === 'connected');
    },
    onJoined: (msg) => {
      state.you = msg.you;
      state.roomCode = msg.code;
      state.lobby = msg;
      state.settings = msg.settings;
      state.roundNo = msg.roundNo || 0;
      localStorage.setItem(`pp:token:${msg.code}`, msg.token);
      if (msg.arena) setArena(msg.arena);
      renderLobby();
      if (msg.phase === 'playing' || msg.phase === 'intermission') enterGame();
      else ui.showScreen('screen-room');
    },
    onLobby: (msg) => {
      state.lobby = msg;
      state.settings = msg.settings;
      state.roundNo = msg.roundNo || state.roundNo;
      renderLobby();
      const inGame = ui.$('#screen-game').classList.contains('active');
      if (msg.phase === 'playing' || msg.phase === 'intermission') {
        if (!inGame) enterGame();
      } else if (inGame) {
        ui.hideOverlay();
        ui.showScreen('screen-room');
      }
    },
    onArena: (msg) => setArena(msg),
    onState: (snap) => onState(snap),
    onEvents: (list) => onEvents(list),
    onError: (msg) => ui.toast(msg, true),
  };
}

function hostRoom() {
  state.mode = 'net';
  state.placing = null;
  state.session = new NetSession({
    mode: 'create',
    name: currentName(),
    settings: { ...DEFAULT_SETTINGS },
    hooks: netHooks(),
  });
  state.session.connect();
  ui.showScreen('screen-room');
}

function joinRoom(rawCode) {
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (code.length < 5) {
    ui.toast('Enter the 5-character room code', true);
    return;
  }
  state.mode = 'net';
  state.placing = null;
  state.session = new NetSession({
    mode: 'join',
    code,
    name: currentName(),
    token: localStorage.getItem(`pp:token:${code}`),
    hooks: netHooks(),
  });
  state.session.connect();
  ui.showScreen('screen-room');
}

function renderLobby() {
  const l = state.lobby;
  if (!l) return;
  ui.$('#room-code').textContent = state.roomCode || '';
  const isHost = l.hostId === state.you;
  const connected = l.players.filter((p) => p.connected).length;

  ui.$('#player-count').textContent = `(${connected}/${l.settings.maxPlayers})`;
  ui.$('#lobby-players').innerHTML = l.players.map((p) => {
    const tags = [];
    if (p.host) tags.push('<span class="tag host">host</span>');
    if (p.id === state.you) tags.push('<span class="tag you">you</span>');
    if (!p.connected) tags.push('<span class="tag off">offline</span>');
    if (p.spectator) tags.push('<span class="tag">next round</span>');
    const rename = p.id === state.you
      ? '<button class="rename" data-rename title="Rename">✎</button>'
      : '';
    return `<li><span class="dot" style="background:${ui.esc(p.color)}"></span>` +
      `<span class="pname">${ui.esc(p.name)}</span>${tags.join('')}${rename}</li>`;
  }).join('');
  ui.$('#lobby-players').querySelectorAll('[data-rename]').forEach((b) => {
    b.addEventListener('click', () => {
      const next = prompt('Your name', state.name);
      if (next && next.trim()) state.session?.rename(next.trim().slice(0, 16));
    });
  });

  const locked = l.phase !== 'lobby';
  lobbyForm.set(l.settings);
  lobbyForm.setEnabled(isHost && !locked);
  ui.$('#settings-lock').textContent = locked
    ? '(locked during match)'
    : (isHost ? '' : '(host controls)');

  const status = ui.$('#room-status');
  if (l.phase === 'lobby') {
    status.textContent = 'Waiting for players. Share the room code or link — the host starts the match.';
  } else if (l.phase === 'intermission') {
    status.textContent = l.settings.autoRematch
      ? 'Round over — the next one starts automatically.'
      : 'Round over — the host starts the next one.';
  } else {
    status.textContent = 'Match in progress — you join the next round.';
  }

  const startBtn = ui.$('#btn-start');
  startBtn.disabled = !isHost || l.phase === 'playing' || connected < 2;
  startBtn.textContent = l.phase === 'playing'
    ? 'Match in progress'
    : (isHost ? 'Start Match' : 'Waiting for host…');
  startBtn.onclick = () => state.session?.start();
  ui.$('#lobby-hint').textContent = isHost
    ? (connected < 2 ? 'At least 2 players are needed.' : 'You are the host.')
    : 'The host controls the settings.';
}

// ------------------------------------------------------------------ game HUD

function onState(snap) {
  state.snap = snap;
  renderer.pushSnapshot(snap);
  if (state.mode === 'net') {
    const me = snap.players.find((p) => p.id === state.you);
    if (me && me.al === 1) predictor.reconcile(me.pc);
  }
  updateHud();
}

/** Local prediction keeps your own paddle instant; snapshots correct the drift. */
function updatePrediction(dt) {
  if (state.mode !== 'net' || !state.snap || !renderer.poly || !state.arena) {
    renderer.selfPc = null;
    state.predictedPc = null;
    return;
  }
  const me = state.snap.players.find((p) => p.id === state.you);
  const side = me && me.al === 1 && me.side !== null && me.side !== undefined
    ? renderer.poly.sides[me.side]
    : null;
  if (!side || !predictor.ready) {
    renderer.selfPc = null;
    state.predictedPc = null;
    return;
  }
  predictor.configure(side.len, renderer.paddleLen);
  predictor.setTarget(input.target);
  predictor.step(dt);
  renderer.selfPc = predictor.pc;
  state.predictedPc = predictor.pc;
}

function updateHud() {
  ui.renderHud({
    snap: state.snap,
    arenaPlayers: state.arena ? state.arena.players : [],
    you: state.you,
    label: hudLabel(),
  });
  updatePowerbar();
  updateOverlay();
  updateHint();
}

function updateHint() {
  const el = ui.$('#hint');
  const me = state.snap && state.snap.players.find((p) => p.id === state.you);
  if (!me) {
    el.textContent = state.mode === 'net'
      ? 'You are spectating — your paddle joins next round.'
      : '';
    return;
  }
  if (me.al === 0) {
    el.textContent = 'Place your obstacles on the arena. Esc cancels placement.';
    return;
  }
  el.textContent = state.viewMode === 'own'
    ? 'Drag anywhere, or ←/→ to slide along your edge.'
    : 'Drag anywhere, or ←/→ to rotate (left = counter-clockwise).';
}

function updatePowerbar() {
  const bar = ui.$('#powerbar');
  const snap = state.snap;
  const me = snap && snap.players.find((p) => p.id === state.you);
  const canPlace = !!me && me.al === 0 && me.ch > 0
    && state.settings.obstacles
    && snap.phase !== 'intermission' && snap.phase !== 'over';
  if (!canPlace) {
    if (state.placing) {
      state.placing = null;
      input.cancelPlacement(true);
    }
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  ui.$('#powerbar-text').textContent =
    `You are out — ${me.ch} charge${me.ch > 1 ? 's' : ''} left:`;
  bar.querySelector('[data-place="vortex"]').textContent = `Vortex (${me.ch})`;
  bar.querySelector('[data-place="line"]').textContent = `Barrier (${me.ch})`;
  bar.querySelectorAll('[data-place]').forEach((b) => {
    b.classList.toggle('active', state.placing === b.dataset.place);
  });
}

function updateOverlay() {
  const snap = state.snap;
  if (!snap) return;

  if (state.paused) {
    ui.showOverlay('Paused', 'The bots are waiting.', [
      { label: 'Resume', kind: 'accent', onClick: () => togglePause(false) },
      {
        label: 'Restart',
        onClick: () => {
          state.paused = false;
          state.session?.restart();
          ui.hideOverlay();
        },
      },
      { label: 'Exit', kind: 'ghost', onClick: quitGame },
    ], true);
    return;
  }

  if (snap.phase === 'serve') {
    const n = Math.ceil((snap.cd || 0) - 0.35);
    ui.showOverlay(n > 0 ? String(n) : 'GO!', '', [], false);
    return;
  }

  if (snap.phase === 'over' || snap.phase === 'intermission') {
    const winner = snap.winner ? nameOf(snap.winner) : null;
    const auto = state.settings.autoRematch !== false;
    const cd = Math.ceil(snap.cd || 0);
    ui.showOverlay(
      winner ? `${winner} wins!` : 'Round over',
      auto ? `Next round in ${cd}s` : 'Waiting for the host…',
      [],
      true,
    );
    return;
  }

  ui.hideOverlay();
}

function onEvents(list) {
  for (const e of list) {
    switch (e.t) {
      case 'goal':
        ui.feed(`${nameOf(e.id)} lost a life — ${e.lives} left`, e.lives <= 1 ? 'warn' : '');
        sfx.goal();
        break;
      case 'elim':
        ui.feed(`${nameOf(e.id)} is out!`, 'warn');
        sfx.out();
        break;
      case 'over':
        ui.feed(e.id ? `${nameOf(e.id)} wins the round!` : 'Round over', 'win');
        sfx.win();
        break;
      case 'place':
        ui.feed(`${nameOf(e.id)} placed a ${e.kind === 'line' ? 'barrier' : 'vortex'}`, 'place');
        break;
      case 'shrink':
        ui.feed(
          e.alive === 2 ? 'Arena becomes a head-to-head duel!' : `Arena shrinks to ${e.n} sides!`,
          'win',
        );
        sfx.shrink();
        break;
      case 'wash':
        ui.feed(`${e.count} obstacle${e.count > 1 ? 's' : ''} washed away`, 'warn');
        break;
      case 'vortex':
        sfx.vortex();
        break;
      case 'hit':
        sfx.hit();
        break;
      case 'bounce':
        sfx.wall();
        break;
      default:
        break;
    }
  }
}

// ------------------------------------------------------------------ URL boot

{
  const params = new URLSearchParams(location.search);
  const urlName = params.get('name');
  if (urlName && urlName.trim()) {
    const n = urlName.trim().slice(0, 16);
    nameInput.value = n;
    state.name = n;
    localStorage.setItem('pp:name', n);
  }
  const room = params.get('room');
  if (room) joinCodeInput.value = room.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (joinCodeInput.value.length === 5) joinRoom(joinCodeInput.value);
}

// ------------------------------------------------------------------- game loop

// Debug hook: handy in the console, used by the automated browser tests.
window.__pp = { state, input, renderer, getSession: () => state.session };

let lastT = performance.now() / 1000;
function loop(t) {
  const now = t / 1000;
  const dt = Math.min(0.05, Math.max(0, now - lastT));
  lastT = now;
  if (state.session && state.mode === 'pve' && !state.paused) {
    state.session.update(dt);
  } else {
    state.session?.update(0);
  }
  if (state.mode === 'net') {
    const rtt = state.session?.rtt ?? 0;
    renderer.delay = Math.min(0.12, Math.max(0.06, 0.05 + rtt / 1000));
  }
  input.update(dt);
  updatePrediction(dt);
  renderer.render(now);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
