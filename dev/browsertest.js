#!/usr/bin/env node
'use strict';
/* Two real headless Chrome pages play a lobby match through the live server:
   create a lobby with the real buttons, join by code, start, fall, trade poses
   and snapshots, quit back to the lobby. Driven over the DevTools protocol with
   Node's built-in WebSocket client. Needs `node server.js` running and Chrome.
   Run: node dev/browsertest.js   (CHROME=path and URL=http://host:port/ to override) */
const { spawn } = require('child_process');
const http = require('http');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL_ = (process.env.URL || 'http://localhost:3500/') + '?browsertest=1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

async function launch(port, tag) {
  const p = spawn(CHROME, ['--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1000,700',
    '--remote-debugging-port=' + port, '--user-data-dir=' + process.env.TEMP + '\\fl-bt-' + tag, '--no-first-run', '--autoplay-policy=no-user-gesture-required', URL_], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60 && !targets; i++) { await sleep(500); try { targets = (await getJson('http://localhost:' + port + '/json')).filter(t => t.type === 'page'); if (!targets.length) targets = null; } catch (e) { /* not up */ } }
  if (!targets) throw new Error('chrome ' + tag + ' did not come up');
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(tag + ': ' + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text));
    return r.result.result.value;
  };
  return { p, ev, ws, tag };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

(async () => {
  const A = await launch(9301, 'a'), B = await launch(9302, 'b');
  try {
    for (const X of [A, B]) {
      for (let i = 0; i < 40; i++) { if (await X.ev('typeof Net !== "undefined" && !!Net.ui && G.state === "menu"')) break; await sleep(250); }
      ok(await X.ev('!!document.getElementById("createBtn") && !!Net.ui'), X.tag + ': page and lobby UI are up');
    }
    // A creates through the real button
    await A.ev('document.getElementById("nameIn").value = "Ava"; document.getElementById("createBtn").click(); true');
    let code = '';
    for (let i = 0; i < 20 && !code; i++) { await sleep(250); code = await A.ev('Net.code'); }
    ok(/^[A-Z]{4}$/.test(code), 'a: created lobby ' + code + ' over a real WebSocket');
    ok(await A.ev('document.getElementById("lobbyRoom").style.display !== "none" && document.getElementById("roomCode").textContent === Net.code'), 'a: room panel shows the code');
    // B joins through the real button
    await B.ev(`document.getElementById("nameIn").value = "Ben"; document.getElementById("skinSel").value = "char_mage"; document.getElementById("codeIn").value = "${code.toLowerCase()}"; document.getElementById("joinBtn").click(); true`);
    for (let i = 0; i < 20; i++) { await sleep(250); if (await B.ev('Net.active')) break; }
    ok(await B.ev('Net.active && Net.id === 2 && Net.players.length === 2'), 'b: joined as player 2');
    await sleep(300);
    ok(await A.ev('Net.players.length === 2 && document.getElementById("playerList").children.length === 2 && document.getElementById("playerList").textContent.includes("Ben")'), 'a: player list shows Ben');
    ok(await B.ev('document.getElementById("startBtn").style.display === "none" && document.getElementById("waitMsg").style.display !== "none"'), 'b: only the host sees START');

    // start
    await A.ev('window.__NOLOCK = true; document.getElementById("startBtn").click(); true');
    await B.ev('window.__NOLOCK = true; true');
    for (let i = 0; i < 20; i++) { await sleep(250); if (await B.ev('Net.inMatch && G.state !== "menu"')) break; }
    ok(await A.ev('Net.hosting && G.state === "drop"') && await B.ev('Net.client && G.state === "drop"'), 'start: both dropping, roles right');
    const wa = await A.ev('JSON.stringify([World.pieces.size, World.props.length, World.loot.length, G.ents.map(e => e.name).join()])');
    const wb = await B.ev('JSON.stringify([World.pieces.size, World.props.length, World.loot.length, G.ents.map(e => e.name).join()])');
    ok(wa === wb, 'start: identical worlds in two real browsers ' + wa.slice(0, 40));
    ok(await A.ev('document.getElementById("menu").style.display === "none"'), 'start: menu hidden on the host');
    ok(await B.ev('document.getElementById("menu").style.display === "none"'), 'start: menu hidden on the client (no click needed)');

    // let them fall for a while (real rAF loop is running in both pages)
    await A.ev('Input.keys.KeyW = true; true'); await B.ev('Input.keys.KeyW = true; true');
    await sleep(6000);
    const hostSeesB = await A.ev('JSON.stringify({ y: entById(2).pos[1], nb: (entById(2).nb || []).length, alive: entById(2).alive })');
    const bTruth = await B.ev('G.player.pos[1]');
    const hb = JSON.parse(hostSeesB);
    ok(hb.nb > 0 && Math.abs(hb.y - bTruth) < 40, 'poses: host receives the client falling (' + hb.y.toFixed(0) + ' vs ' + bTruth.toFixed(0) + ')');
    const bSeesBots = await B.ev('G.ents.filter(e => e.isBot && e.nb && e.nb.length).length');
    ok(bSeesBots > 20, 'snapshots: client gets bot poses from the host (' + bSeesBots + ' bots)');
    const storm = await B.ev('JSON.stringify([G.storm.timer < 4, G.alive])');
    ok(JSON.parse(storm)[1] === 24, 'snapshots: alive count arrives (' + storm + ')');
    // client back to lobby → host sees them eliminated
    await B.ev('Net.backToLobby(); true');
    await sleep(600);
    ok(await B.ev('G.state === "menu" && Net.active && !Net.inMatch && document.getElementById("lobbyRoom").style.display !== "none"'), 'b: back in the lobby panel, still connected');
    ok(await A.ev('!entById(2).alive && G.alive === 23'), 'a: host eliminated the player who quit');
    await A.ev('Net.backToLobby(); true');
    await sleep(400);
    ok(await A.ev('G.state === "menu" && Net.active && Net.players.length === 2'), 'a: host back in the lobby with both players');
  } catch (e) { fail++; console.log('  FAIL ' + e.message); }
  finally { A.p.kill(); B.p.kill(); }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
