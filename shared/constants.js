// Shared gameplay tuning. Imported by the Node server and the browser client.

export const WORLD = {
  R: 480,                 // arena circumradius in world units
  BALL_R: 8,
  PADDLE_THICK: 14,
  PADDLE_OFFSET: 26,      // distance from the wall to the paddle's face (classic Pong)
  PADDLE_LEN_FRAC: 0.34,  // paddle length as a fraction of the side length
  PADDLE_MIN: 80,
  PADDLE_MAX: 190,
  PADDLE_TRAVERSE: 0.3,   // seconds to slide edge-to-edge (speed scales with side length)
  PADDLE_SPEED_MIN: 950,  // units/s floor for small sides
  PADDLE_SPEED_MAX: 2000, // units/s ceiling for big sides
  PADDLE_SPIN: 0.55,      // radians of english added from contact offset
  PADDLE_MAX_ANGLE: 1.05, // max bounce deviation from a straight return (rad)
  BASE_SPEED: 430,
  MAX_SPEED: 1500,
  MAX_MULT: 3,
  SERVE_DELAY: 1.6,       // seconds the ball rests between points
  RAMP_DELAY: 2.0,        // seconds without a goal before the ramp resumes
  INTERMISSION: 8,        // seconds between rounds
};

export const OBSTACLE = {
  LINE_LEN: 130,
  LINE_THICK: 7,
  LINE_LIFE: 18,          // seconds before a placed barrier expires
  LINE_HITS: 3,           // bounces before a barrier shatters
  VORTEX_OUTER: 72,
  VORTEX_CORE: 22,
  VORTEX_LIFE: 15,
  VORTEX_FORCE: 1150,
  MARGIN: 60,             // min distance from the arena wall for placements
  MIN_GAP: 50,            // min distance between obstacles
  MAX_TOTAL: 40,
};

export const SPEED_PRESETS = { chill: 330, normal: 430, turbo: 560 };
export const RAMP_PRESETS = { off: 0, slow: 0.025, normal: 0.06, fast: 0.12 };

export const DEFAULT_SETTINGS = {
  lives: 3,
  speed: 'normal',
  ramp: 'normal',
  maxPlayers: 20,
  obstacles: true,
  autoRematch: true,
};

export const MAX_PLAYERS = 20;
export const MIN_PLAYERS = 2;

export const COLORS = [
  '#ff5d5d', '#ffa14a', '#ffd93d', '#8bd45a', '#3ddc97',
  '#38d6d6', '#4aa8ff', '#6b7dff', '#a06bff', '#d95dff',
  '#ff5db1', '#ff8f7a', '#c0ca33', '#26c6da', '#42a5f5',
  '#7e57c2', '#ec407a', '#ffb300', '#66bb6a', '#9ccc65',
];

export const BOT_NAMES = [
  'HAL-A', 'Bloop', 'Vortexa', 'Bumper', 'Pongbot', 'Zeta',
  'Quark', 'Nibbles', 'Circuit', 'Rally', 'Glitch', 'Orbit',
  'Pixel', 'Echo', 'Turbo', 'Wobble', 'Servo', 'Kernel', 'Nova',
];

export const BOT_SKILLS = {
  easy:   { reaction: 0.38, error: 100, predict: 0.0,  speedFactor: 0.60, placeDelay: [2.5, 5.0] },
  normal: { reaction: 0.22, error: 48,  predict: 0.55, speedFactor: 0.80, placeDelay: [1.5, 3.5] },
  hard:   { reaction: 0.11, error: 15,  predict: 0.92, speedFactor: 1.00, placeDelay: [0.8, 2.0] },
};
