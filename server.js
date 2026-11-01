#!/usr/bin/env node
'use strict';
// fortnite-lite server: static files + the multiplayer relay. Zero dependencies.
//
//   node server.js              → http://localhost:3500  (live reload on)
//   PORT=8080 node server.js    → any port; Railway / Render / Fly set PORT for you
//
// The relay is deliberately dumb. It hands out 4-letter lobby codes, keeps each
// lobby's player list, and forwards JSON messages between the people in a lobby
// ("to the host", "to everyone else", or to one player). The lobby host's browser
// runs the actual match — see net.js. WebSockets are implemented right here
// (RFC 6455: handshake, masking, fragmentation, ping/pong, close) so the whole
// game stays a plain `node server.js` with nothing to install.
//
// Live reload (dev only): index.html is rewritten on the way out so every
// <script> carries the newest source mtime as a cache-buster, and a small poller
// watches /__rev. It is off in production (RAILWAY_ENVIRONMENT / NODE_ENV).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3500;
const ROOT = __dirname;
const LIVE = !(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production' || process.env.LIVE_RELOAD === '0');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.md': 'text/plain',
};
const SOURCES = ['index.html', 'engine.js', 'models.js', 'anim.js', 'textures.js', 'world.js', 'game.js', 'net.js'];

/* ------------------------------- static ----------------------------------- */

// newest mtime across the sources — changes the moment any of them is saved
function rev() {
  let t = 0;
  for (const f of SOURCES) {
    try { t = Math.max(t, fs.statSync(path.join(ROOT, f)).mtimeMs); } catch (e) { /* gone is fine */ }
  }
  return String(Math.round(t));
}

// Reload as soon as the build changes — but never yank the page out from under
// someone mid-match: with the mouse captured we wait for them to press Esc.
const RELOAD = r => `
<script>
(() => {
  let rev = ${JSON.stringify(r)}, pending = false;
  const go = () => { if (document.pointerLockElement) { pending = true; return; } location.reload(); };
  document.addEventListener('pointerlockchange', () => { if (pending && !document.pointerLockElement) location.reload(); });
  setInterval(async () => {
    try {
      const r = await (await fetch('/__rev', { cache: 'no-store' })).text();
      if (r !== rev) { rev = r; go(); }
    } catch (e) { /* server restarting */ }
  }, 700);
})();
</script>
`;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const nocache = { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' };

  if (url === '/__rev') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain' }, nocache)).end(rev());
    return;
  }
  if (url === '/health') {
    let players = 0;
    for (const r of rooms.values()) players += r.clients.size;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, rooms: rooms.size, players }));
    return;
  }

  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type };
    if (type === 'text/html') {
      if (LIVE) {
        const r = rev();
        data = Buffer.from(String(data)
          .replace(/(<script\s+src=")([^"?]+)(")/g, `$1$2?v=${r}$3`)
          .replace('</body>', RELOAD(r) + '</body>'));
      }
      Object.assign(headers, nocache);
    } else if (LIVE) Object.assign(headers, nocache);
    else headers['Cache-Control'] = file.endsWith('.glb') ? 'public, max-age=86400' : 'public, max-age=300';
    res.writeHead(200, headers);
    res.end(data);
  });
});

/* ------------------------------ websocket --------------------------------- */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_MAX = 512 * 1024;      // one message; a host snapshot is a few KB

class Sock {
  constructor(socket) {
    this.s = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null; this.fragOp = 0;
    this.alive = true; this.closed = false;
    this.onmessage = null; this.onclose = null;
    socket.setNoDelay(true);
    socket.on('data', d => this.feed(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    socket.on('end', () => this.finish());
  }
  feed(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > WS_MAX * 2) { this.close(1009); return; }
    for (;;) {
      const f = this.parse();
      if (!f) break;
      this.handle(f);
      if (this.closed) break;
    }
  }
  // One frame off the front of the buffer, or null if it isn't all here yet.
  parse() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return null;
      if (b.readUInt32BE(2) !== 0) { this.close(1009); return null; }
      len = b.readUInt32BE(6); off = 10;
    }
    if (len > WS_MAX) { this.close(1009); return null; }
    if (masked) off += 4;
    if (b.length < off + len) return null;
    let payload = b.subarray(off, off + len);
    if (masked) {
      const m = b.subarray(off - 4, off), out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3];
      payload = out;
    } else payload = Buffer.from(payload);
    this.buf = b.subarray(off + len);
    return { fin, op, payload };
  }
  handle(f) {
    switch (f.op) {
      case 0:   // continuation
        if (!this.frag) { this.close(1002); return; }
        this.frag.push(f.payload);
        if (f.fin) { const p = Buffer.concat(this.frag), op = this.fragOp; this.frag = null; this.deliver(op, p); }
        break;
      case 1: case 2:
        if (f.fin) this.deliver(f.op, f.payload);
        else { this.frag = [f.payload]; this.fragOp = f.op; }
        break;
      case 8: this.close(1000); break;
      case 9: this.frame(10, f.payload); break;
      case 10: this.alive = true; break;
      default: this.close(1002);
    }
  }
  deliver(op, p) { this.alive = true; if (op === 1 && this.onmessage) this.onmessage(p.toString('utf8')); }
  frame(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    try { this.s.write(Buffer.concat([head, payload])); } catch (e) { this.finish(); }
  }
  send(str) { this.frame(1, Buffer.from(str, 'utf8')); }
  ping() { this.frame(9, Buffer.alloc(0)); }
  close(code) {
    if (this.closed) return;
    const b = Buffer.alloc(2); b.writeUInt16BE(code || 1000);
    this.frame(8, b);
    this.finish();
    this.s.end();
  }
  finish() {
    if (this.closed) return;
    this.closed = true;
    if (this.onclose) this.onclose();
    this.s.destroy();
  }
}

server.on('upgrade', (req, socket, head) => {
  const url = req.url.split('?')[0];
  const key = req.headers['sec-websocket-key'];
  if (url !== '/ws' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const ws = new Sock(socket);
  lobbyAttach(ws);
  if (head && head.length) ws.feed(head);
});

/* -------------------------------- lobbies --------------------------------- */

const rooms = new Map();          // code -> { code, hostId, next, clients, locked, mode }
const ROOM_MAX = 16;
const MODE_IDS = new Set(['solo', 'duos', 'zero', 'sniper', 'rumble']);
function cleanMode(mode) { return MODE_IDS.has(String(mode || '')) ? String(mode) : 'solo'; }
function roomLimit(mode) { return mode === 'rumble' ? 12 : ROOM_MAX; }
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I / O — they read as 1 / 0

function makeCode() {
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; }
  while (rooms.has(c));
  return c;
}
function cleanName(n) {
  n = String(n || '').replace(/[^\x20-\x7E -￿]/g, '').trim().slice(0, 14);
  return n || 'Player';
}
function cleanSkin(s) {
  return /^char_[a-z_]{1,24}$/.test(String(s)) ? String(s) : 'char_knight';
}
function playerList(room) {
  return Array.from(room.clients.values()).map(c => ({ id: c.id, name: c.name, skin: c.skin, ready: !!c.ready }));
}
function send(c, m) { c.ws.send(JSON.stringify(m)); }
function broadcast(room, m, except) {
  const s = JSON.stringify(m);
  for (const c of room.clients.values()) if (c !== except) c.ws.send(s);
}
function announce(room) {
  broadcast(room, { t: 'players', hostId: room.hostId, players: playerList(room), mode: room.mode, locked: room.locked });
}

const sockets = new Set();      // every live connection, for the heartbeat below

function lobbyAttach(ws) {
  const c = { ws, id: 0, name: '', skin: '', room: null };
  sockets.add(ws);
  ws.onmessage = str => {
    let m;
    try { m = JSON.parse(str); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    handle(c, m);
  };
  ws.onclose = () => { sockets.delete(ws); leave(c); };
}

function handle(c, m) {
  switch (m.t) {
    case 'create': {
      leave(c);
      const mode = cleanMode(m.mode);
      const room = { code: makeCode(), hostId: 1, next: 2, clients: new Map(), locked: false, mode };
      c.id = 1; c.name = cleanName(m.name); c.skin = cleanSkin(m.skin); c.room = room; c.ready = true;
      room.clients.set(c.id, c);
      rooms.set(room.code, room);
      send(c, { t: 'joined', id: c.id, code: room.code, hostId: room.hostId, players: playerList(room), mode });
      break;
    }
    case 'join': {
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) { send(c, { t: 'err', msg: 'No lobby with that code' }); return; }
      if (room.locked) { send(c, { t: 'err', msg: 'That lobby is mid-match — wait for it to finish' }); return; }
      if (room.clients.size >= Math.min(ROOM_MAX, roomLimit(room.mode))) { send(c, { t: 'err', msg: 'That lobby is full for this game mode' }); return; }
      leave(c);
      c.id = room.next++; c.name = cleanName(m.name); c.skin = cleanSkin(m.skin); c.room = room; c.ready = false;
      room.clients.set(c.id, c);
      send(c, { t: 'joined', id: c.id, code: room.code, hostId: room.hostId, players: playerList(room), mode: room.mode });
      announce(room);
      break;
    }
    case 'leave': leave(c); break;
    case 'mode': {
      const room = c.room;
      if (!room || room.locked || room.hostId !== c.id) return;
      const mode = cleanMode(m.mode);
      if (room.clients.size > roomLimit(mode)) { send(c, { t: 'err', msg: 'This mode allows up to ' + roomLimit(mode) + ' people in the lobby' }); return; }
      if (room.mode !== mode) {
        room.mode = mode;
        for (const player of room.clients.values()) player.ready = player.id === room.hostId;
        announce(room);
      }
      break;
    }
    case 'ready': {
      const room = c.room;
      if (!room || room.locked) return;
      c.ready = !!m.ready;
      announce(room);
      break;
    }
    case 'launch': {
      const room = c.room, game = m.game;
      if (!room || room.locked || room.hostId !== c.id) return;
      if (!game || !Array.isArray(game.humans)) { send(c, { t: 'err', msg: 'The match setup is incomplete' }); return; }
      if (room.clients.size > roomLimit(room.mode)) { send(c, { t: 'err', msg: 'Too many players for this mode' }); return; }
      if (Array.from(room.clients.values()).some(player => !player.ready)) { send(c, { t: 'err', msg: 'Wait until every player is ready' }); return; }
      room.locked = true;
      const start = Object.assign({}, game, { t: 'start', mode: room.mode });
      broadcast(room, start, c);
      break;
    }
    case 'lock': if (c.room && c.room.hostId === c.id) c.room.locked = !!m.on; break;
    case 'to': {
      const room = c.room;
      if (!room || m.d === undefined) return;
      const s = JSON.stringify({ t: 'from', id: c.id, d: m.d });
      if (m.to === 'host') { const h = room.clients.get(room.hostId); if (h && h !== c) h.ws.send(s); }
      else if (m.to === 'all') { for (const o of room.clients.values()) if (o !== c) o.ws.send(s); }
      else { const o = room.clients.get(m.to | 0); if (o && o !== c) o.ws.send(s); }
      break;
    }
  }
}

function leave(c) {
  const room = c.room;
  if (!room) return;
  room.clients.delete(c.id);
  const wasHost = room.hostId === c.id;
  c.room = null; c.id = 0;
  if (!room.clients.size) { rooms.delete(room.code); return; }
  if (wasHost) {
    room.hostId = Math.min(...room.clients.keys());
    room.locked = false;
    const nextHost = room.clients.get(room.hostId);
    if (nextHost) nextHost.ready = true;
    broadcast(room, { t: 'hostLeft', hostId: room.hostId });
  }
  announce(room);
}

// Drop connections that stopped answering (a closed laptop, a lost network).
setInterval(() => {
  for (const ws of sockets) {
    if (!ws.alive) { ws.close(1001); continue; }
    ws.alive = false; ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log('fortnite-lite → http://localhost:' + PORT + (LIVE ? '  (live reload on)' : '  (production)')));
