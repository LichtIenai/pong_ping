// HTTP static server (public/ + shared/) plus the /ws WebSocket endpoint.
// Deploy-friendly: binds 0.0.0.0 and honours process.env.PORT (Render, Railway, Fly, Docker).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './server/rooms.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const SHARED_DIR = join(ROOT, 'shared');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

/** Parse a boolean CLI flag: `--run`, `--run=1`, `--run=off`, etc. */
function cliFlag(name) {
  const arg = process.argv.slice(2).find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`),
  );
  if (!arg) return false;
  const value = arg.includes('=') ? arg.split('=').slice(1).join('=') : 'true';
  return !/^(0|false|off|no)$/i.test(value);
}

// `--run` / `RUN=1` reveals the client-side Auto Play toggle; `?run=1` also works.
const RUN_ENABLED = cliFlag('run') || /^(1|true|yes|on)$/i.test(process.env.RUN || '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function resolveStatic(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (p === '/' || p === '') p = '/index.html';
  let base;
  if (p.startsWith('/shared/')) {
    base = SHARED_DIR;
    p = p.slice('/shared'.length);
  } else {
    base = PUBLIC_DIR;
  }
  const full = normalize(join(base, p));
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.url?.split('?')[0] === '/config.json') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ run: RUN_ENABLED }));
      return;
    }
    const file = resolveStatic(req.url || '/');
    if (!file) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad request');
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    console.error('static error:', err);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Server error');
  }
});

function rawSend(ws, raw) {
  if (ws.readyState === 1) {
    try { ws.send(raw); } catch { /* socket died mid-send */ }
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
const manager = new RoomManager();

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  if (!url.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws._ppAlive = true;
  ws.on('pong', () => { ws._ppAlive = true; });

  const client = {
    ws,
    room: null,
    playerId: null,
    send(obj) { rawSend(ws, JSON.stringify(obj)); },
    sendRaw(raw) { rawSend(ws, raw); },
  };

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      manager.handle(client, msg);
    } catch (err) {
      console.error('ws message error:', err);
    }
  });

  ws.on('close', () => manager.disconnect(client));
  ws.on('error', () => {
    try { ws.close(); } catch { /* ignore */ }
  });
});

// Reap dead sockets (proxies/hosts can silently drop connections).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    if (ws._ppAlive === false) {
      ws.terminate();
      continue;
    }
    ws._ppAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref?.();

server.listen(PORT, HOST, () => {
  console.log(`Polygon Pong listening on http://${HOST}:${PORT}`);
});
