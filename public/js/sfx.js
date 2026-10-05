// Tiny WebAudio blips. The AudioContext unlocks on the first user gesture.

let ctx = null;
let muted = localStorage.getItem('pp:muted') === '1';
let lastTap = 0;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(freq, dur, { type = 'sine', gain = 0.05, slide = 0, delay = 0 } = {}) {
  if (muted) return;
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

function throttledTap() {
  const now = performance.now();
  if (now - lastTap < 55) return false;
  lastTap = now;
  return true;
}

export const sfx = {
  hit() {
    if (throttledTap()) tone(440, 0.05, { type: 'square', gain: 0.022 });
  },
  wall() {
    if (throttledTap()) tone(230, 0.05, { gain: 0.018, slide: -40 });
  },
  goal() {
    tone(210, 0.3, { type: 'sawtooth', gain: 0.045, slide: -110 });
  },
  out() {
    tone(140, 0.5, { type: 'sawtooth', gain: 0.05, slide: -80 });
  },
  place() {
    tone(520, 0.12, { type: 'triangle', gain: 0.04, slide: 380 });
  },
  vortex() {
    tone(160, 0.45, { type: 'sine', gain: 0.05, slide: 700 });
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.18, { type: 'triangle', gain: 0.05, delay: i * 0.12 }));
  },
  toggle() {
    muted = !muted;
    localStorage.setItem('pp:muted', muted ? '1' : '0');
    if (!muted) tone(700, 0.1, { gain: 0.04 });
    return muted;
  },
  get muted() {
    return muted;
  },
};
