#!/usr/bin/env node
'use strict';
/* Headless building / collision tests. Loads the real engine + world + game code
   into this process with a stubbed DOM (no WebGL, no fetch) and drives
   moveEntity / tryBuild directly. Run: node dev/test.js */
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

// a flat, empty world (no POIs, no props) so the tests are deterministic
function flatWorld() {
  World.reset();
  TERR.a = TERR.b = TERR.c = TERR.d = TERR.e = 0; TERR.amp = 0;   // terrainHeight() == 0 everywhere
  World.ents = G.ents; G.ents.length = 0;
  G.storm = { cx: 0, cz: 0, r: 1000, tcx: 0, tcz: 0, tr: 1000, phase: 0, timer: 999, shrinking: false, dps: 0, r0: 1000, tickT: 0 };
  G.state = 'play'; G.t = 0;
}
function spawn(x, z) {
  const e = makeEntity(false, 'T', [1, 1, 1], 'char_knight');
  e.pos[0] = x; e.pos[1] = terrainHeight(x, z); e.pos[2] = z; e.grounded = true;
  e.mats = [999, 999, 999];
  G.ents.push(e); G.player = e;
  return e;
}
// walk toward (dx, dz) for `secs` at the given frame time, like updatePlayer does
function walk(e, dx, dz, speed, secs, dt) {
  const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
  for (let t = 0; t < secs; t += dt) {
    e.vel[0] += (dx * speed - e.vel[0]) * Math.min(1, 60 * dt);
    e.vel[2] += (dz * speed - e.vel[2]) * Math.min(1, 60 * dt);
    e.vel[1] -= 30 * dt;
    moveEntity(e, dt);
  }
}
function settle(e, secs, dt) { for (let t = 0; t < secs; t += dt) { e.vel[0] = e.vel[2] = 0; e.vel[1] -= 30 * dt; moveEntity(e, dt); } }

console.log('1. walls block walking, at any frame rate, including lag spikes');
{
  flatWorld();
  const e = spawn(2, 2);
  for (let gx = 0; gx < 10; gx++) addPiece('wall', gx, 0, 1, 0, MAT_WOOD, null);   // a long wall on the z = 4 line
  for (const dt of [1 / 144, 1 / 60, 1 / 30, 0.05]) {
    e.pos[0] = 2; e.pos[2] = 2; e.pos[1] = 0; e.vel.fill(0);
    walk(e, 0, 1, WALK_SPEED * 2, 2, dt);              // sprint straight at the wall
    ok(e.pos[2] < 4 - 0.2 - ENT_R + 1e-3 && e.pos[2] > 3.0, `sprinting into a wall at dt=${dt.toFixed(4)} stops at z=${e.pos[2].toFixed(3)} (wall face 3.8)`);
  }
  // diagonal into the wall, sliding along it
  e.pos[0] = 2; e.pos[2] = 2; e.vel.fill(0);
  walk(e, 1, 1, WALK_SPEED * 2, 2, 0.05);
  ok(e.pos[2] < 3.8 + 1e-3, `diagonal run slides along the wall (z=${e.pos[2].toFixed(2)}, x=${e.pos[0].toFixed(2)})`);
}

console.log('2. a wall built through you pushes you out, and you cannot then walk through it');
{
  flatWorld();
  const e = spawn(2, 3.9);                               // standing right on the z=4 line
  addPiece('wall', 0, 0, 1, 0, MAT_WOOD, null);
  ok(e.pos[2] <= 4 - 0.2 - ENT_R + 1e-3 || e.pos[2] >= 4 + 0.2 + ENT_R - 1e-3, `pushed clear of the wall to z=${e.pos[2].toFixed(3)}`);
  const side = e.pos[2] < 4 ? -1 : 1;
  walk(e, 0, -side, WALK_SPEED * 2, 2, 0.05);            // now walk into it from that side
  ok(side < 0 ? e.pos[2] < 3.8 + 1e-3 : e.pos[2] > 4.2 - 1e-3, `walking back into it stays on the same side (z=${e.pos[2].toFixed(3)})`);
  // walking *away* from a wall you overlap must not teleport you through it
  e.pos[2] = 4 - 0.2 - ENT_R + 0.3;                     // 30 cm inside the wall
  e.vel.fill(0);
  walk(e, 0, -1, WALK_SPEED, 1, 1 / 60);
  ok(e.pos[2] < 3.8 + 1e-3, `overlapping a wall and walking away leaves you on the near side (z=${e.pos[2].toFixed(3)})`);
}

console.log('3. falling lands on floors and roofs, never through them');
{
  flatWorld();
  const e = spawn(2, 2);
  addPiece('floor', 0, 2, 0, 0, MAT_WOOD, null);         // floor slab at y = 8, tile x 0..4 z 0..4
  for (const dt of [1 / 60, 0.05]) {
    e.pos[1] = 40; e.vel.fill(0); e.grounded = false;
    settle(e, 4, dt);
    ok(Math.abs(e.pos[1] - 8) < 1e-3, `40 m drop at dt=${dt} lands on the floor at y=${e.pos[1].toFixed(3)}`);
  }
  // skydive landing on a roof uses surfaceUnder
  ok(Math.abs(surfaceUnder(2, 7.9, 2, 9.2) - 8) < 1e-6, 'surfaceUnder finds the roof under a skydiver');
}

console.log('4. ramps: walkable on top, solid from below, cones solid + walkable');
{
  flatWorld();
  const e = spawn(2, 6);
  addPiece('ramp', 0, 0, 0, 0, MAT_WOOD, null);          // rises toward -Z: low edge z=4, high edge z=0 at y=4
  walk(e, 0, -1, WALK_SPEED, 0.8, 1 / 60);
  ok(e.pos[1] > 3.5 && e.pos[2] < 1.2, `walked up the ramp to y=${e.pos[1].toFixed(2)} z=${e.pos[2].toFixed(2)}`);
  ok(e.onRamp, 'onRamp flag set at the top');
  // from underneath: jump up into the deck
  e.pos[0] = 2; e.pos[2] = 1; e.pos[1] = 0; e.vel.fill(0);
  let maxHead = 0;
  for (let i = 0; i < 90; i++) { if (i === 0) e.vel[1] = 9.4; e.vel[1] -= 30 / 60; moveEntity(e, 1 / 60); maxHead = Math.max(maxHead, e.pos[1] + ENT_H); }
  const deckUnder = rampHeightAt(World.pieces.get(pieceKey('ramp', 0, 0, 0)), 2, 1) - RAMP_DECK * LEV;
  ok(maxHead <= deckUnder + 0.02, `jumping under the ramp is stopped by the deck (head ${maxHead.toFixed(2)} <= ${deckUnder.toFixed(2)})`);
  ok(e.pos[1] < 0.01, 'and you fall back to the ground rather than popping on top');
  // cone
  addPiece('cone', 2, 0, 2, 0, MAT_BRICK, null);          // tile x 8..12, z 8..12
  e.pos[0] = 10; e.pos[2] = 14; e.pos[1] = 0; e.vel.fill(0);
  walk(e, 0, -1, WALK_SPEED, 0.7, 1 / 60);
  ok(e.pos[1] > 0.9, `walked up onto the cone (y=${e.pos[1].toFixed(2)})`);
}

console.log('5. placement: pieces land next to you on the grid, never inside you');
{
  flatWorld();
  const e = spawn(6.1, 6.1);                             // tile (1,1), near its -X/-Z corner
  e.yaw = 0;                                             // facing -Z
  e.buildType = 0;                                       // wall
  let plan = buildPlan(e);
  ok(plan.type === 'wall' && plan.rot === 0 && plan.gz === 1 && plan.gx === 1 && plan.gy === 0, `wall goes on the z=4 line of my tile: ${JSON.stringify(plan)}`);
  e.pos[2] = 4.3;                                        // straddling the line, as in Fortnite
  plan = buildPlan(e);
  ok(plan.gz === 1 && plan.rot === 0, `straddling the line, the wall still goes on it: ${JSON.stringify(plan)}`);
  ok(tryBuild(e), 'and it places');
  const w = World.pieces.get(pieceKey('wall', 1, 0, 1, 0));
  ok(!!w && e.pos[2] >= w.col.maxz + ENT_R - 1e-3, `it pushes the player back to the side they were on (z=${e.pos[2].toFixed(2)})`);
  e.pos[2] = 6.1;
  e.yaw = Math.PI / 2;                                   // facing -X
  e.buildType = 1; plan = buildPlan(e);
  ok(plan.type === 'floor' && plan.gx === 0 && plan.gz === 1 && plan.gy === 0, `floor goes in the tile in front: ${JSON.stringify(plan)}`);
  e.buildType = 2; plan = buildPlan(e);
  ok(plan.type === 'ramp' && plan.gx === 0 && plan.rot === 1, `ramp goes in front rising away (rot 1 = toward -X): ${JSON.stringify(plan)}`);
  ok(tryBuild(e), 'ramp places');
  // walk up it and place the next one — it must continue from the top
  walk(e, -1, 0, WALK_SPEED, 0.8, 1 / 60);
  ok(e.onRamp && e.pos[1] > 3.2, `walked up to y=${e.pos[1].toFixed(2)}`);
  plan = buildPlan(e);
  ok(plan.gy === 1 && plan.gx === -1 && plan.rot === 1, `next ramp continues one storey up in the next tile: ${JSON.stringify(plan)}`);
  ok(canPlace(plan.type, plan.gx, plan.gy, plan.gz, plan.rot), 'and it is supported by the ramp below it');
  ok(tryBuild(e), 'second ramp places');
  walk(e, -1, 0, WALK_SPEED, 0.55, 1 / 60);
  ok(e.pos[1] > 7.2, `climbed the staircase to y=${e.pos[1].toFixed(2)}`);
}

console.log('6. structural support: shooting out the base drops everything above it');
{
  flatWorld();
  spawn(50, 50);
  addPiece('ramp', 0, 0, 0, 0, MAT_WOOD, null);
  addPiece('ramp', 0, 1, -1, 0, MAT_WOOD, null);
  addPiece('ramp', 0, 2, -2, 0, MAT_WOOD, null);
  addPiece('floor', 0, 3, -3, 0, MAT_WOOD, null);
  addPiece('wall', 0, 3, -3, 0, MAT_WOOD, null);
  ok(World.pieces.size === 5, 'a 3-ramp staircase with a floor and wall on top stands');
  ok(!canPlace('floor', 5, 3, 5, 0), 'a floor in mid-air with nothing touching it is refused');
  ok(canPlace('wall', 0, 2, -3, 0), 'a wall hanging under the top floor is allowed');
  removePiece(World.pieces.get(pieceKey('ramp', 0, 0, 0)));
  updateSupport();
  ok(World.pieces.size === 0, `removing the bottom ramp collapses the rest (${World.pieces.size} left, ${World.collapsing.length} falling)`);
  // a house-like box: knocking out one wall leaves the roof on the others
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    addPiece('wall', ...normalizeWall(i, 0, j, 0), MAT_BRICK, null); addPiece('wall', ...normalizeWall(i, 0, j, 2), MAT_BRICK, null);
    addPiece('wall', ...normalizeWall(i, 0, j, 1), MAT_BRICK, null); addPiece('wall', ...normalizeWall(i, 0, j, 3), MAT_BRICK, null);
    addPiece('floor', i, 1, j, 0, MAT_BRICK, null);
  }
  const before = World.pieces.size;
  removePiece(World.pieces.get(pieceKey('wall', 0, 0, 0, 0)));
  updateSupport();
  ok(World.pieces.size === before - 1, `one wall out of a box: roof stays up (${World.pieces.size} of ${before})`);
}

console.log('7. hillside: ground pieces are allowed on slopes and line up with neighbours');
{
  flatWorld();
  TERR.amp = 1; TERR.a = 1; TERR.b = 2; TERR.c = 3; TERR.d = 4; TERR.e = 5;
  _tbase.clear(); _tground.clear();
  let placed = 0, tried = 0, aligned = 0;
  const rng = mulberry32(7);                              // fixed sample, so this never flakes
  for (let i = 0; i < 200; i++) {
    const x = -300 + rng() * 600, z = -300 + rng() * 600;
    const e = spawn(x, z); e.yaw = rng() * 6.28; e.buildType = 1;
    const plan = buildPlan(e); tried++;
    if (canPlace(plan.type, plan.gx, plan.gy, plan.gz, plan.rot)) {
      placed++;
      const y = plan.gy * LEV;
      if (Math.abs(y - e.pos[1]) <= LEV) aligned++;
    }
    World.pieces.clear(); World.keyMap.clear();
  }
  ok(placed / tried > 0.97, `${placed}/${tried} floors placeable on open hillside`);
  ok(aligned === placed, `${aligned}/${placed} within one storey of the player's feet`);
}

console.log('8. player push: build on yourself and get shoved clear, never buried, never through');
{
  // a wall on the line you are standing on, facing it: you end up behind it and cannot get through
  flatWorld();
  let e = spawn(2, 3.9); e.yaw = Math.PI; e.buildType = 0;   // facing +Z toward the z=4 line, mostly on its -Z side
  ok(tryBuild(e), 'wall placed on the line under my feet');
  ok(e.pos[2] <= 4 - 0.2 - ENT_R + 1e-3, `pushed to the side I was mostly on (z=${e.pos[2].toFixed(2)})`);
  walk(e, 0, 1, WALK_SPEED * 2, 1.5, 0.05);
  ok(e.pos[2] <= 4 - 0.2 - ENT_R + 1e-3, `and cannot sprint through it afterwards (z=${e.pos[2].toFixed(2)})`);
  // dead centre on the line: pushed behind, not through
  flatWorld();
  e = spawn(2, 4.0); e.yaw = 0; e.buildType = 0;          // facing -Z, exactly on z=4
  ok(tryBuild(e), 'wall placed exactly through me');
  ok(e.pos[2] >= 4 + 0.2 + ENT_R - 1e-3, `a dead tie pushes me back the way I came, not forward through it (z=${e.pos[2].toFixed(2)})`);
  walk(e, 0, -1, WALK_SPEED * 2, 1.5, 1 / 60);
  ok(e.pos[2] >= 4 + 0.2 + ENT_R - 1e-3, `still blocked walking into it (z=${e.pos[2].toFixed(2)})`);
  // a cone built on yourself lifts you onto it — never underground, never stuck inside
  flatWorld();
  e = spawn(2, 2); e.yaw = 0; e.pitch = -1.2; e.buildType = 3;
  ok(tryBuild(e), 'cone placed on my own tile');
  let minY = e.pos[1];
  for (let i = 0; i < 60; i++) { e.vel[0] = e.vel[2] = 0; e.vel[1] -= 0.5; moveEntity(e, 1 / 60); minY = Math.min(minY, e.pos[1]); }
  ok(minY >= -1e-3, `never pushed below the ground (lowest y=${minY.toFixed(2)})`);
  ok(Math.abs(e.pos[1] - CONE_H) < 0.05, `standing on top of the cone (y=${e.pos[1].toFixed(2)})`);
  // a ramp built on yourself puts you on its deck
  flatWorld();
  e = spawn(2, 2); e.yaw = 0; e.buildType = 2;
  addPiece('ramp', 0, 0, 0, 0, MAT_WOOD, null);           // through the player, rising toward -Z
  minY = e.pos[1];
  for (let i = 0; i < 60; i++) { e.vel[0] = e.vel[2] = 0; e.vel[1] -= 0.5; moveEntity(e, 1 / 60); minY = Math.min(minY, e.pos[1]); }
  const deck = rampHeightAt(World.pieces.get(pieceKey('ramp', 0, 0, 0)), e.pos[0], e.pos[2]);
  ok(minY >= -1e-3 && Math.abs(e.pos[1] - deck) < 0.05, `on the ramp deck, not under it (y=${e.pos[1].toFixed(2)}, deck ${deck.toFixed(2)})`);
  // walking under a ramp stops where the deck comes down to head height — no popping up through it
  flatWorld();
  e = spawn(2, 6);
  addPiece('ramp', 0, 0, 0, 2, MAT_WOOD, null);           // rises toward +Z: high edge at z=4 (y=4), low edge at z=0
  walk(e, 0, -1, WALK_SPEED * 2, 2, 1 / 60);
  const r = World.pieces.get(pieceKey('ramp', 0, 0, 0));
  const underHere = rampHeightAt(r, e.pos[0], e.pos[2]) - RAMP_DECK * LEV;
  ok(e.pos[1] < 0.01 && e.pos[2] > 0.5 && e.pos[2] < 4, `stopped under the deck at z=${e.pos[2].toFixed(2)}, still on the ground`);
  ok(e.pos[1] + ENT_H <= underHere + 0.05, `head clear of the deck (${(e.pos[1] + ENT_H).toFixed(2)} <= ${underHere.toFixed(2)})`);
  // ...and at any frame rate
  for (const dt of [1 / 144, 1 / 30, 0.05]) {
    e.pos[0] = 2; e.pos[2] = 6; e.pos[1] = 0; e.vel.fill(0);
    walk(e, 0, -1, WALK_SPEED * 2, 2, dt);
    ok(e.pos[1] < 0.01 && e.pos[2] > 0.5, `dt=${dt.toFixed(4)}: still stopped under the deck (z=${e.pos[2].toFixed(2)}, y=${e.pos[1].toFixed(2)})`);
  }
  // the ramp is still walkable from its low end
  e.pos[0] = 2; e.pos[2] = -2; e.pos[1] = 0; e.vel.fill(0);
  walk(e, 0, 1, WALK_SPEED, 0.75, 1 / 60);
  ok(e.onRamp && e.pos[1] > 3.0, `walked up it from the low end to y=${e.pos[1].toFixed(2)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
