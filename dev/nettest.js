#!/usr/bin/env node
'use strict';
/* Relay server test. Starts server.js on a spare port, connects a few clients
   with Node's built-in WebSocket, and checks lobby codes, joining, message
   routing, the mid-match lock, host migration and a fragmented frame.
   Run: node dev/nettest.js */
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

if (typeof WebSocket === 'undefined') { console.log('  skip  Node ' + process.version + ' has no WebSocket client'); process.exit(0); }

const PORT = 3600 + Math.floor(Math.random() * 300);
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok   ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client() {
  const ws = new WebSocket('ws://localhost:' + PORT + '/ws');
  const inbox = [];
  const waiters = [];
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (waiters.length) waiters.shift()(m); else inbox.push(m); };
  const next = (timeout = 2000) => new Promise((res, rej) => {
    if (inbox.length) return res(inbox.shift());
    const t = setTimeout(() => rej(new Error('timeout waiting for a message')), timeout);
    waiters.push(m => { clearTimeout(t); res(m); });
  });
  const send = o => ws.send(JSON.stringify(o));
  const open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('connect failed')); });
  return { ws, next, send, open, inbox };
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), LIVE_RELOAD: '0' }), stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(res => srv.stdout.on('data', d => { if (String(d).includes('fortnite-lite')) res(); }));
  try {
    const a = client(), b = client(), c = client();
    await Promise.all([a.open, b.open, c.open]);

    a.send({ t: 'create', name: 'Alice', skin: 'char_mage' });
    const ja = await a.next();
    ok(ja.t === 'joined' && ja.id === 1 && ja.hostId === 1 && /^[A-Z]{4}$/.test(ja.code), 'create: joined as host with a 4-letter code (' + ja.code + ')');

    b.send({ t: 'join', code: 'ZZZZ', name: 'Bob' });
    const bad = await b.next();
    ok(bad.t === 'err', 'join: unknown code is refused');

    b.send({ t: 'join', code: ja.code.toLowerCase(), name: '  Bob  ', skin: 'not-a-skin' });
    const jb = await b.next();
    ok(jb.t === 'joined' && jb.id === 2 && jb.players.length === 2 && jb.players[1].name === 'Bob' && jb.players[1].skin === 'char_knight', 'join: code is case-insensitive, name trimmed, bad skin defaulted');
    const pa = await a.next();
    ok(pa.t === 'players' && pa.players.length === 2, 'join: host is told about the new player');
    const pb = await b.next();
    ok(pb.t === 'players' && pb.players.length === 2, 'join: the joiner gets the player list too');

    b.send({ t: 'to', to: 'host', d: { t: 'hit', e: 5, d: 12 } });
    const m1 = await a.next();
    ok(m1.t === 'from' && m1.id === 2 && m1.d.t === 'hit' && m1.d.d === 12, "relay: 'host' goes to the host with the sender's id");

    c.send({ t: 'join', code: ja.code, name: 'Cara' });
    await c.next(); await c.next(); await a.next(); await b.next();   // joined, then everyone's players update

    a.send({ t: 'mode', mode: 'duos' });
    const [ma, mbMode, mcMode] = await Promise.all([a.next(), b.next(), c.next()]);
    ok(ma.mode === 'duos' && mbMode.mode === 'duos' && mcMode.mode === 'duos', 'mode: host selection is shared with the whole party');
    ok(ma.players[0].ready && !ma.players[1].ready && !ma.players[2].ready, 'mode: changing mode readies the host and resets the party');
    a.send({ t: 'launch', game: { seed: 42, humans: [{ id: 1 }, { id: 2 }, { id: 3 }] } });
    const refused = await a.next();
    ok(refused.t === 'err' && /ready/.test(refused.msg), 'launch: the server refuses to start while players are not ready');

    b.send({ t: 'ready', ready: true });
    c.send({ t: 'ready', ready: true });
    const partyUpdates = await Promise.all([a.next(), a.next(), b.next(), b.next(), c.next(), c.next()]);
    const finalRoster = partyUpdates.filter(m => m.t === 'players').slice(-1)[0];
    ok(partyUpdates.length === 6 && finalRoster.players.every(p => p.ready), 'ready: the server broadcasts the updated ready state to everyone');
    a.send({ t: 'launch', game: { seed: 42, humans: [{ id: 1 }, { id: 2 }, { id: 3 }], bots: true } });
    const [startA, startB, startC] = await Promise.all([a.next(), b.next(), c.next()]);
    ok(startA.t === 'start' && startB.t === 'start' && startC.t === 'start' && startA.mode === 'duos', 'launch: the server confirms the selected game mode to the whole party');
    a.send({ t: 'to', to: 'all', d: { t: 'start', seed: 7 } });
    const [mb, mc] = await Promise.all([b.next(), c.next()]);
    ok(mb.d.seed === 7 && mc.d.seed === 7 && a.inbox.length === 0, "relay: 'all' reaches everyone except the sender");

    c.send({ t: 'to', to: 2, d: { t: 'pm' } });
    const pm = await b.next();
    ok(pm.id === 3 && pm.d.t === 'pm', 'relay: a numeric target reaches that player only');

    // a big message crosses intact (the client may fragment it)
    const big = { t: 'snap', pad: 'x'.repeat(200000) };
    a.send({ t: 'to', to: 2, d: big });
    const got = await b.next(4000);
    ok(got.d.pad.length === 200000, 'frames: a 200 KB message arrives intact');

    a.send({ t: 'lock', on: true });
    await sleep(50);
    const d = client(); await d.open;
    d.send({ t: 'join', code: ja.code, name: 'Dan' });
    const locked = await d.next();
    ok(locked.t === 'err' && /mid-match/.test(locked.msg), 'lock: nobody joins a match in progress');

    a.ws.close();
    const hl = await b.next();
    const hl2 = await c.next();
    ok(hl.t === 'hostLeft' && hl.hostId === 2 && hl2.hostId === 2, 'host migration: the earliest remaining player becomes host');
    const pl = await b.next();
    ok(pl.t === 'players' && pl.players.length === 2 && pl.hostId === 2, 'host migration: player list updated');
    await c.next();
    d.send({ t: 'join', code: ja.code, name: 'Dan' });
    const jd = await d.next();
    ok(jd.t === 'joined' && jd.hostId === 2, 'host migration: the lock is lifted and the new host is reported');

    for (const x of [b, c, d]) x.ws.close();
  } catch (err) {
    fail++; console.log('  FAIL ' + err.message);
  } finally {
    await new Promise(res => { srv.on('exit', res); srv.kill(); });
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
