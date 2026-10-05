// Wire-protocol helpers shared by server and client.

import {
  DEFAULT_SETTINGS, MAX_PLAYERS, MIN_PLAYERS, SPEED_PRESETS, RAMP_PRESETS,
} from './constants.js';

export function cleanName(raw, fallback = null) {
  let s = typeof raw === 'string' ? raw : '';
  // strip control characters and angle brackets, trim, cap length
  s = s.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
  return s || fallback || `Player${1000 + Math.floor(Math.random() * 9000)}`;
}

export function cleanSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    const lives = Number(raw.lives);
    if (Number.isFinite(lives)) s.lives = Math.max(1, Math.min(10, Math.round(lives)));
    if (raw.speed in SPEED_PRESETS) s.speed = raw.speed;
    if (raw.ramp in RAMP_PRESETS) s.ramp = raw.ramp;
    const mp = Number(raw.maxPlayers);
    if (Number.isFinite(mp)) s.maxPlayers = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Math.round(mp)));
    s.obstacles = raw.obstacles === undefined ? DEFAULT_SETTINGS.obstacles : !!raw.obstacles;
    s.autoRematch = raw.autoRematch === undefined ? DEFAULT_SETTINGS.autoRematch : !!raw.autoRematch;
  }
  return s;
}

export function clampTarget(raw) {
  const t = Number(raw);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.min(1, t));
}

export function cleanCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}
