// DOM helpers, settings form builder, HUD/feed/toast rendering.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function toast(msg, bad = false) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3400);
  while (box.children.length > 4) box.firstChild.remove();
}

export function feed(msg, kind = '') {
  const box = $('#feed');
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3900);
  while (box.children.length > 5) box.firstChild.remove();
}

function clampInt(raw, min, max, dflt) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Build a settings form. Returns { get, set, setEnabled, values }. */
export function buildSettings(container, opts = {}) {
  const { showBots = false, showHost = false, onChange = () => {} } = opts;
  const speedOpts = { chill: 'Chill', normal: 'Normal', turbo: 'Turbo' };
  const rampOpts = { off: 'Off', slow: 'Slow', normal: 'Normal', fast: 'Fast' };
  container.innerHTML = `
    <label class="set"><span>Lives</span><input type="number" min="1" max="10" step="1" data-k="lives"></label>
    <label class="set"><span>Ball speed</span><select data-k="speed">${Object.entries(speedOpts).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
    <label class="set"><span>Speed ramp</span><select data-k="ramp">${Object.entries(rampOpts).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
    ${showBots ? `
      <label class="set"><span>Bots</span><div class="range-wrap"><input type="range" min="1" max="9" step="1" data-k="bots"><b data-out="bots">3</b></div></label>
      <div class="set"><span>Bot skill</span><div class="seg" data-k="skill">
        <button type="button" data-v="easy">Easy</button>
        <button type="button" data-v="normal" class="active">Normal</button>
        <button type="button" data-v="hard">Hard</button>
      </div></div>` : ''}
    ${showHost ? `<label class="set"><span>Max players</span><input type="number" min="2" max="20" step="1" data-k="maxPlayers"></label>` : ''}
    <label class="set check"><input type="checkbox" data-k="obstacles"><span>Obstacles for eliminated players</span></label>
    ${showHost ? `<label class="set check"><input type="checkbox" data-k="autoRematch"><span>Auto-start next round</span></label>` : ''}
  `;

  const get = (k) => container.querySelector(`[data-k="${k}"]`);
  const form = {
    values: {
      lives: 3, speed: 'normal', ramp: 'normal',
      maxPlayers: 20, obstacles: true, autoRematch: true,
      bots: 3, skill: 'normal',
    },
    get() {
      const v = { ...form.values };
      v.lives = clampInt(get('lives').value, 1, 10, 3);
      v.speed = get('speed').value;
      v.ramp = get('ramp').value;
      v.obstacles = get('obstacles').checked;
      if (showHost) {
        v.maxPlayers = clampInt(get('maxPlayers').value, 2, 20, 20);
        v.autoRematch = get('autoRematch').checked;
      }
      if (showBots) {
        v.bots = clampInt(get('bots').value, 1, 9, 3);
        v.skill = form.values.skill;
      }
      form.values = v;
      return v;
    },
    set(v) {
      Object.assign(form.values, v || {});
      get('lives').value = form.values.lives;
      get('speed').value = form.values.speed;
      get('ramp').value = form.values.ramp;
      get('obstacles').checked = !!form.values.obstacles;
      if (showHost) {
        get('maxPlayers').value = form.values.maxPlayers;
        get('autoRematch').checked = !!form.values.autoRematch;
      }
      if (showBots) {
        get('bots').value = form.values.bots;
        const out = container.querySelector('[data-out="bots"]');
        if (out) out.textContent = form.values.bots;
        get('skill').querySelectorAll('button').forEach((b) => {
          b.classList.toggle('active', b.dataset.v === form.values.skill);
        });
      }
    },
    setEnabled(on) {
      container.querySelectorAll('input, select, button').forEach((el) => { el.disabled = !on; });
    },
  };

  container.addEventListener('input', (e) => {
    if (e.target.dataset && e.target.dataset.k) onChange(form);
  });
  container.addEventListener('change', (e) => {
    if (e.target.dataset && e.target.dataset.k) onChange(form);
  });
  if (showBots) {
    get('bots').addEventListener('input', () => {
      const out = container.querySelector('[data-out="bots"]');
      if (out) out.textContent = get('bots').value;
    });
    get('skill').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn || btn.disabled) return;
      form.values.skill = btn.dataset.v;
      get('skill').querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      onChange(form);
    });
  }
  return form;
}

function pipsFor(lives) {
  const n = Math.max(0, Math.min(10, lives));
  let html = '<span class="pips">';
  for (let i = 0; i < n; i++) html += '<i class="pip on"></i>';
  return `${html}</span>`;
}

/** Update in-game player list, multiplier label and label chip. */
export function renderHud({ snap, arenaPlayers, you, label }) {
  $('#hud-label').textContent = label || '';
  $('#hud-mult').textContent = `×${(snap?.mult ?? 1).toFixed(2)} speed`;

  const list = $('#hud-players');
  const snapById = new Map((snap?.players ?? []).map((p) => [p.id, p]));
  const rows = [];
  for (const p of arenaPlayers || []) {
    const sp = snapById.get(p.id);
    const out = sp ? sp.al === 0 : false;
    const away = sp ? sp.cn === 0 : false;
    const tags = [];
    if (p.id === you) tags.push('<span class="tag you">you</span>');
    if (out) tags.push('<span class="tag out">out</span>');
    else if (away) tags.push('<span class="tag off">away</span>');
    rows.push(`
      <li class="${p.id === you ? 'me' : ''}">
        <span class="dot" style="background:${esc(p.color)}"></span>
        <span class="pname">${esc(p.name)}</span>
        ${tags.join('')}
        ${!out && !away && sp ? pipsFor(sp.lv) : ''}
      </li>`);
  }
  if (you && !snapById.has(you)) {
    rows.push('<li class="me spectate">You are spectating — your paddle joins next round.</li>');
  }
  list.innerHTML = rows.join('');
}

let overlaySig = '';

export function showOverlay(title, sub, actions = [], dim = true) {
  const sig = `${title}\u0000${sub || ''}\u0000${actions.map((a) => a.label).join('|')}\u0000${dim}`;
  const overlay = $('#overlay');
  // Rebuilding the DOM on every state tick would detach buttons mid-click.
  if (sig === overlaySig && !overlay.classList.contains('hidden')) return;
  overlaySig = sig;

  $('#ov-title').textContent = title;
  $('#ov-sub').textContent = sub || '';
  const box = $('#ov-actions');
  box.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.kind || ''}`;
    b.textContent = a.label;
    b.addEventListener('click', a.onClick);
    box.appendChild(b);
  }
  overlay.classList.toggle('dim', !!dim);
  overlay.classList.remove('hidden');
}

export function hideOverlay() {
  overlaySig = '';
  $('#overlay').classList.add('hidden');
}
