#!/usr/bin/env node
'use strict';
/* Headless recoil suite. Loads the real engine + world + game code with the same
   stubbed DOM as test.js and drives updatePlayer() — the real look / fire / recoil
   path — with the trigger held on every gun at 30, 60 and 144 fps. Checks: the peak
   climb stays under each weapon's target, the peak is the same at every frame rate,
   the view comes back to the original aim within the target time, a player pulling
   down during the burst is respected (never undone or overshot by the recovery),
   the mouse aim assist neither fights nor amplifies the kick, spread / bloom do
   what the crosshair says, and bots never kick. Run: node dev/recoiltest.js */
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');

// ---- DOM stubs: enough for the scripts to load, nothing renders ----
global.window = global;
global.document = { addEventListener() {}, getElementById() { return null; }, createElement() { return { getContext() { return null; }, width: 0, height: 0 }; }, pointerLockElement: null, exitPointerLock() {} };
Object.defineProperty(global, 'navigator', { value: { getGamepads: () => [] }, configurable: true });
global.addEventListener = () => {};
global.requestAnimationFrame = () => 0;
global.performance = global.performance || { now: () => Date.now() };
global.location = { search: '', href: 'http://localhost/' };
global.fetch = () => Promise.reject(new Error('no fetch'));
for (const f of ['engine.js', 'models.js', 'anim.js', 'textures.js', 'world.js', 'game.js', 'net.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok   ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };
const RAD = 180 / Math.PI;                       // radians -> degrees for the printouts
const deg = v => (v * RAD).toFixed(2) + '°';

// a flat, empty world so nothing but the gun moves the view
function flatWorld() {
  World.reset();
  TERR.a = TERR.b = TERR.c = TERR.d = TERR.e = 0; TERR.amp = 0;
  World.ents = G.ents; G.ents.length = 0; G.parts.length = 0; G.tracers.length = 0;
  G.storm = { cx: 0, cz: 0, r: 1000, tcx: 0, tcz: 0, tr: 1000, phase: 0, timer: 999, shrinking: false, dps: 0, r0: 1000, tickT: 0 };
  G.state = 'play'; G.t = 0; G.aimAssist = false; G.recoilScale = 1;
  Input.mouse = [false, false, false]; Input.padActive = false; Input.endFrame();
}
function spawn(gun, x, z) {
  const e = makeEntity(false, 'T', [1, 1, 1], 'char_knight');
  e.pos[0] = x || 0; e.pos[1] = 0; e.pos[2] = z || 0; e.grounded = true;
  e.ammo = { light: 999, medium: 999, shells: 999 };
  e.inv[1] = { id: gun, rar: 0, mag: WEAPONS[gun].mag }; e.slot = 1;
  e.pitch = -0.05;                                // the slight downward look of a real fight
  G.ents.push(e);
  return e;
}
// One frame the way frame() -> update() runs the player: look input, then the held
// trigger (auto guns read mouse[0], semi-auto ones clicked[0] — both set), then the
// timers update() keeps.
function step(e, dt, fire, dy) {
  Input.mouse[0] = fire; Input.clicked[0] = fire;
  Input.dy = dy || 0;
  updatePlayer(e, dt);
  if (e.fireT > 0) e.fireT -= dt;
  if (e.reloadT > 0) { e.reloadT -= dt; if (e.reloadT <= 0) finishReload(e); }
  Input.endFrame();
}

// Hold the trigger for `hold` seconds (or until the magazine runs dry), let go and
// keep stepping for 1.5 s. opts.pull(e, t, p0) supplies the player's per-frame look
// input (positive = pulling down) while the trigger is held; opts.ads aims in.
// Returns the pitch / yaw deviation from the original aim over time and the stats.
function burst(gun, fps, hold, opts) {
  opts = opts || {};
  const dt = 1 / fps;
  flatWorld();
  const e = spawn(gun);
  G.player = e;
  if (opts.setup) opts.setup(e);
  Input.mouse[2] = !!opts.ads;
  const p0 = e.pitch, y0 = e.yaw;
  const trace = [];
  let t = 0, shots = 0, lastShot = 0, peak = -1, peakYaw = 0, minDev = 1;
  return withSeed(opts.seed || 7, () => {
    while (t < hold + 1.5) {
      const firing = t < hold && e.inv[1].mag > 0;
      const before = e.inv[1].mag;
      step(e, dt, firing, firing && opts.pull ? opts.pull(e, t, p0) : 0);
      t += dt;
      if (e.inv[1].mag < before) { shots++; lastShot = t; }
      const dev = e.pitch - p0, dyaw = angleDelta(y0, e.yaw);
      trace.push({ t, dev, dyaw });
      if (dev > peak) peak = dev;
      if (dev < minDev) minDev = dev;
      if (Math.abs(dyaw) > peakYaw) peakYaw = Math.abs(dyaw);
    }
    // what stays for good (the profile's non-recovering part), and how long after
    // the last shot the view was back within 0.1° of it
    const rest = trace[trace.length - 1].dev;
    let i = trace.length - 1;
    while (i > 0 && Math.abs(trace[i].dev - rest) < 0.1 / RAD) i--;
    const recovery = Math.max(0, trace[Math.min(i + 1, trace.length - 1)].t - lastShot);
    return { e, p0, trace, shots, lastShot, peak, peakYaw, minDev, rest, recovery, final: e.pitch };
  });
}

// ---- 1. every gun, every frame rate: peak climb, recovery, frame-rate independence ----
// Targets (degrees / seconds): the AR is the tuning anchor — a full magazine at 20 m
// without compensation stays inside a torso, so its climb is well under 2° and it is
// back within ~0.3 s of the last shot; SMG lighter and faster; pistol light and
// snappy; shotgun a single punchy kick gone before the pump; sniper a real 2–3° kick
// back in ~0.5 s.
const TARGET = {
  pistol:      { peak: 1.0, rec: 0.30 },
  smg:         { peak: 1.3, rec: 0.30 },
  tacsmg:      { peak: 1.35, rec: 0.38 },
  ar:          { peak: 1.6, rec: 0.35 },
  heavyAR:     { peak: 1.8, rec: 0.48, fpsTol: 0.25 },
  shotgun:     { peak: 2.2, rec: 0.60, min: 1.0 },
  autoShotgun: { peak: 2.35, rec: 0.75, min: 0.65 },
  sniper:      { peak: 3.4, rec: 0.65, min: 2.0 },
  dmr:         { peak: 2.0, rec: 0.72, min: 0.65 },
  revolver:    { peak: 1.9, rec: 0.62, min: 0.65, fpsTol: 0.25 },
};
const FPS = [30, 60, 144];
console.log('1. trigger held 2 s (or a magazine) at 30 / 60 / 144 fps, no compensation');
const measured = {};
for (const gun of GUN_IDS) {
  const tg = TARGET[gun];
  const runs = {};
  for (const fps of FPS) {
    const r = burst(gun, fps, 2);
    runs[fps] = r;
    console.log(`     ${gun.padEnd(8)} ${String(fps).padStart(3)} fps: ${String(r.shots).padStart(2)} shots, peak ${deg(r.peak)}, sideways ${deg(r.peakYaw)}, rests at ${deg(r.rest)}, recovered ${r.recovery.toFixed(3)} s after the last shot`);
  }
  measured[gun] = runs;
  for (const fps of FPS) {
    const r = runs[fps];
    ok(r.shots > 0 && r.peak * RAD < tg.peak && (!tg.min || r.peak * RAD > tg.min), `${gun} @${fps}: peak climb ${deg(r.peak)} ${tg.min ? 'between ' + tg.min + '° and ' : 'under '}${tg.peak}°`);
    ok(r.recovery < tg.rec, `${gun} @${fps}: back on the original aim ${r.recovery.toFixed(3)} s after the last shot (< ${tg.rec} s)`);
    ok(Math.abs(r.rest) * RAD < 0.45, `${gun} @${fps}: what never recovers is only ${deg(r.rest)}`);
    ok(r.minDev * RAD > -0.05, `${gun} @${fps}: the recovery never dips below the original aim (lowest ${deg(r.minDev)})`);
  }
  const p30 = runs[30].peak * RAD, p60 = runs[60].peak * RAD, p144 = runs[144].peak * RAD;
  const fpsTol = tg.fpsTol || 0.1;  // slower semi-auto cadence can differ by one shot at 30 fps
  ok(Math.abs(p30 - p144) < fpsTol && Math.abs(p60 - p144) < fpsTol, `${gun}: peak is frame-rate independent within ${fpsTol.toFixed(2)}° (${p30.toFixed(2)}° / ${p60.toFixed(2)}° / ${p144.toFixed(2)}°)`);
  ok(Math.abs(runs[30].recovery - runs[144].recovery) < 0.06, `${gun}: recovery time is frame-rate independent (${runs[30].recovery.toFixed(3)} s vs ${runs[144].recovery.toFixed(3)} s)`);
}

console.log('2. a full assault-rifle magazine settles instead of climbing without bound');
{
  const r = burst('ar', 60, 6);
  const at20 = Math.tan(r.peak) * 20;
  console.log(`     ${r.shots} shots, peak ${deg(r.peak)} = ${at20.toFixed(2)} m up at 20 m, sideways ${deg(r.peakYaw)} = ${(Math.tan(r.peakYaw) * 20).toFixed(2)} m`);
  ok(r.shots === WEAPONS.ar.mag, `fired the whole magazine (${r.shots})`);
  ok(r.peak * RAD < 1.6 && at20 < 0.5, `peak climb over the magazine ${deg(r.peak)} — ${at20.toFixed(2)} m at 20 m, inside a torso`);
  ok(Math.tan(r.peakYaw) * 20 < 0.25, `sideways drift ${(Math.tan(r.peakYaw) * 20).toFixed(2)} m at 20 m stays inside half a torso`);
  // ADS reduces the kick as well as the spread
  const a = burst('ar', 60, 2, { ads: true });
  const h = burst('ar', 60, 2);
  console.log(`     ADS peak ${deg(a.peak)} vs hip ${deg(h.peak)}`);
  ok(a.peak < h.peak * 0.85 && a.peak > h.peak * 0.5, `aiming down sights softens the climb (${deg(a.peak)} vs ${deg(h.peak)})`);
}

console.log('3. compensation: pulling down during the burst is respected by the recovery');
{
  const cap = RECOIL.ar.max;
  // (a) tracking the kick perfectly — the view is put back on the aim every frame
  const r = burst('ar', 60, 2, { pull: (e, t, p0) => e.pitch - p0 });
  console.log(`     perfect tracking: peak ${deg(r.peak)}, lowest ${deg(r.minDev)}, ends ${deg(r.final - r.p0)} from the aim`);
  ok(r.peak * RAD < 0.3, `while tracking, the view never got more than ${deg(r.peak)} off the aim`);
  ok(r.minDev * RAD > -0.05 && (r.final - r.p0) * RAD < 0.15, `after the burst the view stays on the aim (${deg(r.final - r.p0)}) — nothing to recover, no overshoot below it`);
  // (b) pulling further than the gun climbed — the extra is a deliberate re-aim and stays
  const pullTotal = 3 / RAD;
  const frames = Math.round(2 * 60);
  const o = burst('ar', 60, 2, { pull: () => pullTotal / frames });
  const expect = -pullTotal + cap;                // the whole pattern landed, the whole pull kept
  console.log(`     3° over-pull: ends ${deg(o.final - o.p0)} from the aim (expected ${deg(expect)})`);
  ok(Math.abs(o.final - o.p0 - expect) * RAD < 0.15, `a 3° pull against a ${deg(cap)} climb leaves the view ${deg(o.final - o.p0)} below the aim — the recovery does not undo it`);
  // (c) pulling less than the climb — the pull is absorbed into the kick and the view
  //     still comes back to the aim, not below it
  const pTotal = 0.5 / RAD;
  const u = burst('ar', 60, 2, { pull: () => pTotal / frames });
  console.log(`     0.5° under-pull: ends ${deg(u.final - u.p0)} from the aim, lowest ${deg(u.minDev)}`);
  ok(Math.abs(u.final - u.p0) * RAD < 0.2 && u.minDev * RAD > -0.55, `a 0.5° pull is absorbed: the view returns to ${deg(u.final - u.p0)} of the aim and never below the pull`);
  // the same at 30 and 144 fps
  for (const fps of [30, 144]) {
    const n = Math.round(2 * fps);
    const q = burst('ar', fps, 2, { pull: () => pullTotal / n });
    ok(Math.abs(q.final - q.p0 - expect) * RAD < 0.15, `over-pull @${fps} fps ends ${deg(q.final - q.p0)} (expected ${deg(expect)})`);
  }
}

console.log('4. the mouse aim assist neither fights the recovery nor amplifies the kick');
{
  // The view starts dead on a still enemy 20 m ahead at eye level (pitch 0), ADS
  // held so the assist's magnetism is on. The kick pushes the view up, the assist
  // pulls it back toward the enemy; the recovery must then only return what the
  // assist did not already pull back, or the view would dip under the target.
  const level = e => { e.pitch = 0; };
  const withEnemy = e => {
    level(e);
    const o = spawn('pistol', 0, -20); o.isBot = true; o.human = false; o.think = 999;
    o.hp = 1e9; o.shield = 1e9;                    // the burst lands on it; it must not die mid-test
    G.aimAssist = true;
  };
  const off = burst('ar', 60, 2, { ads: true, setup: level });
  const on = burst('ar', 60, 2, { ads: true, setup: withEnemy });
  let lowest = 1;
  for (const s of on.trace) if (s.t > on.lastShot) lowest = Math.min(lowest, s.dev);
  console.log(`     assist off: peak ${deg(off.peak)}; assist on: peak ${deg(on.peak)}, lowest under the target after the burst ${deg(lowest)}, ends ${deg(on.final)} from the target`);
  ok(on.peak <= off.peak + 0.05 / RAD, `the assist does not add to the climb (${deg(on.peak)} vs ${deg(off.peak)} without it)`);
  ok(lowest * RAD > -0.15, `during the recovery the view never dips below the target it was pulled onto (lowest ${deg(lowest)})`);
  ok(Math.abs(on.final) * RAD < 0.3, `and it ends on the target (${deg(on.final)})`);
}

console.log('5. spread: the cone the shots use is what the crosshair draws');
{
  flatWorld();
  const e = spawn('ar'); G.player = e;
  const w = WEAPONS.ar;
  const base = shotSpread(e, w);
  ok(Math.abs(base - w.spread) < 1e-9, `standing still, hip fire: base spread ${base.toFixed(4)}`);
  e.ads = true;
  ok(Math.abs(shotSpread(e, w) - w.spread * 0.35) < 1e-9, 'aiming down sights: 0.35x');
  e.ads = false; e.vel[0] = WALK_SPEED;
  ok(Math.abs(shotSpread(e, w) - w.spread * 1.7) < 1e-9, 'walking: 1.7x');
  e.vel[0] = WALK_SPEED * 2;
  ok(Math.abs(shotSpread(e, w) - w.spread * 1.7) < 1e-9, 'sprinting: still 1.7x, not more');
  e.vel[0] = WALK_SPEED * 0.25;
  ok(Math.abs(shotSpread(e, w) - w.spread * 1.175) < 1e-9, 'creeping: a quarter of the penalty');
  e.vel[0] = 0;
  const r = burst('ar', 60, 1.2);
  let widest = 0;
  // bloom while firing, gone once the recoil has settled
  withSeed(3, () => {
    flatWorld(); const f = spawn('ar'); G.player = f;
    for (let t = 0; t < 1.2; t += 1 / 60) { step(f, 1 / 60, true, 0); widest = Math.max(widest, shotSpread(f, w)); }
    ok(widest > w.spread * 1.3 && widest <= w.spread * (1 + RECOIL.ar.bloomMax) + 1e-9, `sustained fire blooms the cone to ${(widest / w.spread).toFixed(2)}x (cap ${1 + RECOIL.ar.bloomMax}x)`);
    for (let t = 0; t < 1.0; t += 1 / 60) step(f, 1 / 60, false, 0);
    ok(shotSpread(f, w) < w.spread * 1.01, `and it is back to base a second after letting go (${(shotSpread(f, w) / w.spread).toFixed(3)}x)`);
  });
  void r;
}

console.log('6. bots never kick, and FN.recoil(0) turns the kick off');
{
  flatWorld();
  const p = spawn('ar'); G.player = p;
  const b = spawn('ar', 0, -10); b.isBot = true; b.human = false; b.skill = 0.5;
  const pitchB = b.pitch;
  withSeed(5, () => { for (let i = 0; i < 5; i++) { b.fireT = 0; tryFire(b, 0, 0, -1); } });
  ok(b.rpT === 0 && b.rAcc === 0 && b.pitch === pitchB, 'five bot shots leave the bot\'s aim and recoil state untouched');
  ok(b.gunKick > 0, 'but the bot\'s gun still shows the visual jolt');
  G.recoilScale = 0;
  const r = burst('ar', 60, 1, { setup: () => { G.recoilScale = 0; } });
  ok(r.shots > 0 && r.peak === 0 && r.peakYaw === 0, `with the kick scaled to 0 the view does not move over ${r.shots} shots`);
  G.recoilScale = 1;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
