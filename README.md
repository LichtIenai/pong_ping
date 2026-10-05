# Polygon Pong

Neon arena Pong for 1–20 players. Every player defends one side of a regular
polygon with a paddle that slides along the wall. Lose the ball past your
paddle and you lose a life; lose all lives and you become a spectator with
**obstacle powers** to disrupt the survivors.

Two ways to play:

- **PvE — Arena vs Bots**: fully in-browser, same engine and rules, bot paddles
  with selectable skill.
- **PvP — Rooms**: the host creates a room, shares a 5-character code (or link),
  and up to 20 players join. Host configures lives, ball speed, difficulty ramp,
  max players and whether eliminated players get obstacle charges.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # auto-restarts on file changes
npm test           # node:test units for geometry, engine, rooms
```

No build step: plain ES modules shared between the Node server and the browser
(`shared/` is served at `/shared/`).

## How to play

- The arena is a flat-bottomed polygon. By default **your own wall is shown at
  the bottom of your screen**; you can switch to a shared view in the menu or
  with the `View` button in the HUD.
- The ball bounces inside the arena. Your paddle slides along your side.
- **Ball past your paddle** → you lose a life and the ball re-serves toward you.
- **Eliminated** → the arena **shrinks** to the remaining players (square →
  triangle → two parallel walls for a head-to-head duel). You keep watching and
  receive **2 obstacle charges**:
  - **Vortex** — pulls the ball in and spits it out in a random direction at a
    randomized speed.
  - **Barrier** — a solid segment that rebounds the ball; it shatters after
    3 bounces or expires after ~18 s.
  Obstacles that no longer fit the smaller arena are washed away.
- The host can turn obstacles off, or raise/lower the number of lives (1–10).
- **Speed ramp**: while nobody is losing a life, the ball speeds up over time
  (Off / Slow / Normal / Fast, up to 3×). Every goal resets the ramp.
- Last player with lives remaining wins the round; rounds restart automatically
  with everyone who is connected (the arena grows/shrinks to the player count).

Controls:

- **Mouse / touch**: drag anywhere — the paddle follows the projection of your
  pointer onto your side.
- **Keyboard**: `←` / `A` and `→` / `D`. In the default own-side view they move
  your paddle left/right on screen; in shared view they rotate
  counter-clockwise/clockwise around the arena.
- **Esc**: in PvE, pauses; while placing an obstacle, cancels placement.

## Hosting on Render

### Blueprint (one click)

1. Push this repository to GitHub/GitLab.
2. In Render: **New → Blueprint**, pick the repo. Render reads `render.yaml`
   and creates the web service (`npm install`, `npm start`, health check
   `/health`).
3. Open the service URL. WebSockets terminate automatically on `wss://`.

### Manual web service

- **Environment**: Node
- **Build command**: `npm install`
- **Start command**: `npm start`
- **Health check path**: `/health`

Notes:

- The server binds `0.0.0.0` and uses `process.env.PORT`, so it works on
  Render, Railway, Fly, Heroku and plain VMs behind a reverse proxy.
- Rooms are in-memory. A free Render instance sleeps after ~15 minutes of
  inactivity; waking takes a moment and active rooms are lost. PvE keeps
  working once the page is loaded.
- A single instance is enough. If you scale horizontally, rooms would live on
  one process only — use sticky sessions or a shared room store.

### Docker

```bash
docker build -t polygon-pong .
docker run -p 3000:3000 polygon-pong
```

## Architecture

```
server.js              static file server + /ws WebSocket endpoint + heartbeat
server/rooms.js        room registry, room-code generation, 60 Hz loop driver
server/room.js         members, reconnects, host migration, round lifecycle
shared/constants.js    physics tuning, presets, bot skills, palette
shared/geometry.js     regular-polygon sides, normals, segment distances
shared/engine.js       the authoritative simulation (ball, paddles, lives, ramp,
                       obstacles, placements, snapshots, events)
shared/ai.js           bot paddles (reaction, error, prediction) + bot placement
shared/protocol.js     name/settings sanitising
public/                Canvas 2D client: renderer, input, net, prediction, PvE, HUD, sfx
tests/                 node:test suites (geometry, engine, room behaviour)
```

Netcode: the server simulates at 60 Hz and broadcasts compact snapshots at
30 Hz; clients interpolate with an RTT-adaptive delay (60–120 ms) and predict
their own paddle locally for instant response. Inputs are clamped targets
(0–1 along the side), placements are validated server-side against the arena
margins and other obstacles. Reconnecting with the stored room token inside
the 45 s grace window reclaims your seat; the host automatically migrates if
the host leaves.

## Tuning

Most gameplay knobs live in `shared/constants.js`:

- `WORLD` — arena radius, paddle size and slide speed (`PADDLE_TRAVERSE` sets
  the seconds to cross an edge, clamped by `PADDLE_SPEED_MIN/MAX`), spin, ball
  speed presets, ramp delay, intermission length.
- `OBSTACLE` — barrier/vortex size, lifetime, force, placement margins.
- `BOT_SKILLS` — reaction time, aim error, prediction chance, placement delay.

Settings presets (`SPEED_PRESETS`, `RAMP_PRESETS`) and the 20-player color
palette are in the same file.
