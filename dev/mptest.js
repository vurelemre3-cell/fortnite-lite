#!/usr/bin/env node
'use strict';
/* Headless multiplayer test. Loads the whole game twice — a HOST and a CLIENT,
   each in its own VM context with a stubbed DOM — and wires their Net layers
   together through an in-memory copy of the relay. Then it plays a little match:
   start (identical worlds?), poses crossing both ways, a client hit landing on
   the host's health, a client build appearing on the host, a pickup, a chest,
   a drop, an elimination and the end screen. Run: node dev/mptest.js */
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
const SCRIPTS = ['engine.js', 'models.js', 'anim.js', 'textures.js', 'world.js', 'game.js', 'net.js'];

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok   ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };

// ---- an in-memory relay with the server's routing rules ----
const relay = { clients: new Map(), hostId: 1 };
function deliver(id, m) { const c = relay.clients.get(id); if (c) c.Net.onMessage(m); }
const sent = {};                                   // "fromId:type" -> count, for the checks below
function route(fromId, m) {
  if (m.t !== 'to') return;
  const k = fromId + ':' + (m.d && m.d.t);
  sent[k] = (sent[k] || 0) + 1;
  const env = { t: 'from', id: fromId, d: JSON.parse(JSON.stringify(m.d)) };   // over the wire = JSON
  if (m.to === 'host') { if (relay.hostId !== fromId) deliver(relay.hostId, env); }
  else if (m.to === 'all') { for (const id of relay.clients.keys()) if (id !== fromId) deliver(id, env); }
  else deliver(m.to, env);
}

// One simulated clock for both sides: the sim runs far faster than real time, so
// interpolation (which is timestamped) must see time advance with the frames.
let clock = 0;

function makeInstance(label) {
  const sandbox = {
    console, performance: { now: () => clock }, Math, JSON, Date, Map, Set, Float32Array, Uint8Array, Uint16Array,
    Float64Array, Int32Array, Uint32Array, ArrayBuffer, DataView, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 0, addEventListener() {}, fetch: () => Promise.reject(new Error('no fetch')),
    location: { search: '', href: 'http://localhost/', host: 'localhost', protocol: 'http:', origin: 'http://localhost', pathname: '/' },
    navigator: { getGamepads: () => [] },
    document: { addEventListener() {}, getElementById() { return null; }, createElement() { return { getContext() { return null; }, width: 0, height: 0, style: {} }; }, pointerLockElement: null, exitPointerLock() {}, hidden: false },
    localStorage: { getItem: () => null, setItem() {} },
    URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: label + ':' + f });
  // top-level const/function bindings are not properties of the sandbox — pull out the ones the test drives
  const api = vm.runInContext('({ Net, G, World, Input, makeEntity, entById, update, terrainHeight, surfaceUnder, dealDamage, buildPlan, pieceKey, tryBuild, damagePiece, updateSupport, spawnLoot, tossLoot, lootById, requestTake, dropHeld, applyDamage, nextSpectate, canRunNow })', ctx);
  api.document = sandbox.document; api.window = sandbox;
  return api;
}

const H = makeInstance('host'), C = makeInstance('client');
for (const [ctx, id, name] of [[H, 1, 'Host'], [C, 2, 'Friend']]) {
  ctx.Net.init();
  ctx.Net.raw = m => route(id, m);         // straight into the relay
  ctx.Net.active = true; ctx.Net.id = id; ctx.Net.hostId = 1; ctx.Net.code = 'TEST';
  ctx.Net.players = [{ id: 1, name: 'Host', skin: 'char_knight' }, { id: 2, name: 'Friend', skin: 'char_mage' }];
  ctx.window.__NOLOCK = true;
  ctx.G.player = ctx.makeEntity(false, name, [1, 1, 1], 'char_knight');   // startGame calls Sfx.init etc.
  relay.clients.set(id, ctx);
}
// startGame touches the menu DOM; give both a stub element
for (const ctx of [H, C]) ctx.document.getElementById = () => ({ style: {}, addEventListener() {}, textContent: '', innerHTML: '' });

// ---- 1. start ----
H.Net.startMatch();
ok(H.Net.hosting && C.Net.client, 'start: host hosts, friend is a client');
ok(H.G.state === 'drop' && C.G.state === 'drop', 'start: both are dropping');
ok(H.World.pieces.size > 0 && H.World.pieces.size === C.World.pieces.size, 'start: identical piece count (' + H.World.pieces.size + ')');
const hKeys = Array.from(H.World.pieces.keys()).sort().join(), cKeys = Array.from(C.World.pieces.keys()).sort().join();
ok(hKeys === cKeys, 'start: identical piece keys');
ok(H.World.props.length === C.World.props.length && H.World.props.every((p, i) => p.id === C.World.props[i].id && p.kind === C.World.props[i].kind && Math.abs(p.x - C.World.props[i].x) < 1e-9), 'start: identical props and ids (' + H.World.props.length + ')');
ok(H.World.loot.length === C.World.loot.length && H.World.loot.every((l, i) => l.id === C.World.loot[i].id && l.kind === C.World.loot[i].kind), 'start: identical loot and ids (' + H.World.loot.length + ')');
ok(H.World.chests.length === C.World.chests.length && H.World.chests.every((c, i) => Math.abs(c.x - C.World.chests[i].x) < 1e-9), 'start: identical chests');
ok(H.G.ents.length === C.G.ents.length && H.G.ents.every((e, i) => e.id === C.G.ents[i].id && e.name === C.G.ents[i].name && e.skin === C.G.ents[i].skin), 'start: identical roster (' + H.G.ents.length + ')');
ok(H.G.player.id === 1 && C.G.player.id === 2 && H.G.player.name === 'Host' && C.G.player.name === 'Friend', 'start: each controls their own entity');
ok(!H.G.player.remote && H.entById(2).remote && C.entById(1).remote && !C.G.player.remote, 'start: the other human is remote on each side');
ok(H.G.ents.filter(e => e.isBot).every(e => !e.remote) && C.G.ents.filter(e => e.isBot).every(e => e.remote), 'start: bots are simulated on the host only');
ok(H.World.authority && !C.World.authority, 'start: world authority sits with the host');

// ---- 2. land everyone and run ----
function land(ctx) {
  for (const e of ctx.G.ents) { e.pos[1] = ctx.terrainHeight(e.pos[0], e.pos[2]); e.landed = true; e.grounded = true; e.vel[0] = e.vel[1] = e.vel[2] = 0; }
  ctx.G.state = 'play';
}
land(H); land(C);
// put the two humans next to each other on flat ground, away from the bots
const poi = H.World.pois[0];
for (const ctx of [H, C]) {
  const me = ctx.G.player, other = ctx.entById(me.id === 1 ? 2 : 1);
  me.pos[0] = poi.x + (me.id === 1 ? -3 : 3); me.pos[2] = poi.z; me.pos[1] = ctx.surfaceUnder(me.pos[0], 200, me.pos[2], 200) + 0.01;
  other.pos[0] = poi.x + (other.id === 1 ? -3 : 3); other.pos[2] = poi.z; other.pos[1] = me.pos[1];
  for (const b of ctx.G.ents) if (b.isBot) { b.pos[0] = -300; b.pos[2] = -300; b.pos[1] = ctx.terrainHeight(-300, -300); b.wander[0] = -300; b.wander[1] = -300; b.think = 999; }
}
function step(frames, dt) {
  for (let i = 0; i < frames; i++) { clock += dt * 1000; H.update(dt); C.update(dt); H.Input.endFrame(); C.Input.endFrame(); }
}
step(20, 1 / 20);
// the client walks forward for a bit; the host should see it move
const before = H.entById(2).pos[0];
C.Input.keys.KeyD = true;
step(30, 1 / 20);
C.Input.keys.KeyD = false;
step(10, 1 / 20);
const seen = H.entById(2).pos[0], truth = C.G.player.pos[0];
ok(Math.abs(seen - before) > 1, 'poses: the host sees the client walk (' + before.toFixed(1) + ' -> ' + seen.toFixed(1) + ')');
ok(Math.abs(seen - truth) < 0.8, 'poses: within interpolation lag of the truth (' + truth.toFixed(2) + ' vs ' + seen.toFixed(2) + ')');
ok(Math.abs(C.entById(1).pos[0] - H.G.player.pos[0]) < 0.5, 'poses: the client sees the host where the host is');

// ---- 3. a client hit lands on the host's health ----
const hostHp = H.G.player.hp + H.G.player.shield;
C.dealDamage(C.entById(1), 20, C.G.player, false);
step(4, 1 / 20);
ok(H.G.player.hp + H.G.player.shield === hostHp - 20, 'hit: client damage reaches the host (' + hostHp + ' -> ' + (H.G.player.hp + H.G.player.shield) + ')');
ok(C.entById(1).hp + C.entById(1).shield === hostHp - 20, 'hit: and the snapshot brings the new health back');
ok(C.G.dmgNums.length > 0, 'hit: the client saw a damage number at once');

// ---- 4. a client build appears on the host ----
const cp = C.G.player;
cp.mats = [500, 500, 500]; cp.buildMode = true; cp.buildType = 0; cp.yaw = 0; cp.pitch = 0;
const plan = C.buildPlan(cp);
const key = C.pieceKey(plan.type, plan.gx, plan.gy, plan.gz, plan.rot);
ok(C.tryBuild(cp), 'build: client places a wall locally');
ok(C.World.pieces.has(key), 'build: it is in the client world at once');
step(3, 1 / 20);
ok(H.World.pieces.has(key) && H.World.pieces.get(key).owner === H.entById(2), "build: the host has it, owned by the client's entity");
cp.buildMode = false;
// the host shoots the wall out
const hw = H.World.pieces.get(key);
H.damagePiece(hw, 10000, false);
H.updateSupport();
step(3, 1 / 20);
ok(!H.World.pieces.has(key) && !C.World.pieces.has(key), 'build: destroying it on the host removes it on the client');

// ---- 5. pickup goes through the host ----
const hp = H.G.player;
const lootH = H.spawnLoot('weapon', cp.pos[0] + 1, cp.pos[1], cp.pos[2], { item: { id: 'ar', rar: 3, mag: 30 } });
H.tossLoot(lootH, 0, 0, 0, 0);       // host-spawned → broadcast
step(2, 1 / 20);
const lootC = C.lootById(lootH.id);
ok(!!lootC && lootC.kind === 'weapon', 'loot: a host-spawned item shows up on the client with the same id');
lootC.cool = 0; lootH.cool = 0; lootC.rest = true; lootH.rest = true;
ok(C.requestTake(cp, lootC, false), 'loot: client asks for it');
step(3, 1 / 20);
ok(!H.lootById(lootH.id) && !C.lootById(lootH.id), 'loot: gone from both worlds');
ok(cp.inv.some(it => it && it.id === 'ar'), 'loot: the client pocketed the rifle');
step(2, 1 / 20);
ok(H.entById(2).inv.some(it => it && it.id === 'ar'), "loot: the host knows what the client carries (pose packet)");

// ---- 6. a chest and a drop ----
const chIdx = 0, chH = H.World.chests[chIdx], chC = C.World.chests[chIdx];
const lootBefore = C.World.loot.length;
C.Net.chest(chIdx);
step(3, 1 / 20);
ok(chH.opened && chC.opened, 'chest: opened on both sides');
ok(C.World.loot.length >= lootBefore + 3, 'chest: its contents arrived on the client (' + (C.World.loot.length - lootBefore) + ' items)');
const slot = cp.inv.findIndex(it => it && it.id === 'ar');
cp.slot = slot;
const nH = H.World.loot.length;
ok(C.dropHeld(cp), 'drop: client drops the rifle');
step(3, 1 / 20);
ok(H.World.loot.length === nH + 1 && C.World.loot.length >= 1 && C.World.loot.some(l => l.kind === 'weapon' && l.data.item && l.data.item.id === 'ar' && l.id === H.World.loot[nH].id), 'drop: it lands in both worlds with one id');

// ---- 7. elimination and the end ----
H.applyDamage(H.entById(2), 10000, hp, false, false);
step(3, 1 / 20);
ok(!H.entById(2).alive && !C.G.player.alive, 'elim: the client is out on both sides');
ok(C.G.state === 'dead' && C.G.placement === H.G.ents.length, 'elim: client sees the death screen with a placement (#' + C.G.placement + ')');
ok(C.G.feed.length && C.G.feed[0].a === 'Host' && C.G.feed[0].b === 'Friend', 'elim: kill feed names the host');
ok(H.G.player.kills === 1 && C.entById(1).kills === 1, 'elim: the kill is credited on both sides');
C.G.spec = C.nextSpectate(null);
ok(C.G.spec && C.G.spec.id === 1, 'spectate: the client watches the host first');
// host wipes the bots; the host wins and the client hears it
for (const b of H.G.ents) if (b.isBot && b.alive) H.applyDamage(b, 10000, null, false, true);
step(3, 1 / 20);
ok(H.G.state === 'win' && H.G.placement === 1, 'end: host wins');
ok(C.G.state === 'dead' && C.Net.endTitle === 'HOST WINS' && !C.G.spec, 'end: the client is told who won');

// ---- 8. a second match from the same lobby, then the host walks out of it ----
H.Net.startMatch();
ok(H.G.state === 'drop' && C.G.state === 'drop' && C.Net.client && !C.Net.endTitle, 'rematch: both drop again from the same lobby');
ok(H.G.ents.filter(e => e.isBot).every(e => e.id >= 1000) && C.G.ents.filter(e => e.isBot).every(e => e.id >= 1000), 'rematch: bot ids live far above any lobby id');
land(H); land(C);
step(5, 1 / 20);
// the host losing pointer lock must not freeze the match for everyone
C.window.__NOLOCK = false; C.Input.locked = false; C.Input.padActive = false;
ok(C.canRunNow(), 'a lobby match keeps simulating while the pointer is not locked');
C.window.__NOLOCK = true;
// the server says the host is gone and Friend is host now
C.Net.onMessage({ t: 'hostLeft', hostId: 2 });
C.Net.onMessage({ t: 'players', hostId: 2, players: [{ id: 2, name: 'Friend', skin: 'char_mage' }] });
ok(C.G.state === 'dead' && C.Net.endTitle === 'HOST LEFT', 'host left: the client sees the match end');
ok(!C.Net.inMatch && !C.Net.hosting && !C.World.authority, 'host left: the client is out of the match, not promoted into running a stale one');
const snapsBefore = sent['2:snap'] || 0, stBefore = sent['2:st'] || 0;
step(20, 1 / 20);
ok((sent['2:snap'] || 0) === snapsBefore && (sent['2:st'] || 0) === stBefore, 'host left: the promoted client sends no snapshots or poses for the dead match');
ok(C.Net.active && C.Net.hostId === 2, 'host left: still in the lobby, as its host');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
