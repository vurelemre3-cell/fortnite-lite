'use strict';
/* =============================================================================
   fortnite-lite / game.js
   Match flow (drop -> loot -> build -> storm -> last one standing), player,
   bots, combat, building, characters + animation, HUD.
   ============================================================================= */

const PLAYER_COUNT = 24;
const BOT_NAMES = ['Vex', 'Nomad', 'Ghostly', 'Raven', 'Tilted', 'Zen', 'Kayo', 'Bolt', 'Mako', 'Juno',
  'Ash', 'Riptide', 'Quill', 'Drift', 'Sable', 'Onyx', 'Kite', 'Volt', 'Nyx', 'Cinder',
  'Pike', 'Wren', 'Slate', 'Fen', 'Bramble', 'Halo', 'Torque', 'Lynx'];

const STORM_PHASES = [
  { wait: 35, shrink: 50, r: 0.62, dps: 1 },
  { wait: 30, shrink: 45, r: 0.40, dps: 2 },
  { wait: 25, shrink: 42, r: 0.25, dps: 5 },
  { wait: 20, shrink: 36, r: 0.14, dps: 8 },
  { wait: 16, shrink: 30, r: 0.06, dps: 10 },
  { wait: 12, shrink: 60, r: 0.00, dps: 12 },
];

const BUILD_TYPES = ['wall', 'floor', 'ramp', 'cone'];
// One colour per human in a lobby, by join order (the fallback figure and the minimap use it)
const HUMAN_COLORS = [[0.30, 0.62, 0.95], [0.95, 0.45, 0.30], [0.40, 0.85, 0.45], [0.95, 0.80, 0.30],
  [0.80, 0.40, 0.90], [0.35, 0.85, 0.85], [0.95, 0.55, 0.75], [0.90, 0.90, 0.90]];
const CHAR_SKINS = ['char_knight', 'char_barbarian', 'char_mage', 'char_rogue', 'char_rogue_hooded'];

// Time-to-kill. The point of a Fortnite fight is that it lasts: you trade shots,
// you build, you heal, you re-peek. Everything here scales damage down so a single
// burst can't end an engagement — see also BOT_SHIELD and the bot burst pauses.
const TTK = 0.68;          // global damage scale, both directions
const BOT_DMG = 0.46;      // extra reduction on top of TTK for incoming bot fire
const HEAD_MUL = 1.6;      // headshot multiplier
const BOT_SHIELD = 60;     // bots spawn with up to this much shield, so they take work to drop

const WALK_SPEED = 7.2;    // sprint (L3 / Shift) is exactly double this
const GAME_MODES = {
  solo:   { name: 'Solo Battle Royale', teams: false, building: true, storm: true },
  duos:   { name: 'Duos Battle Royale', teams: true, building: true, storm: true },
  zero:   { name: 'Zero Build', teams: false, building: false, storm: true },
  sniper: { name: 'Sniper Showdown', teams: false, building: true, storm: true },
  rumble: { name: 'Team Rumble', teams: true, building: true, storm: false, respawn: true, scoreLimit: 20 },
};
function sameTeam(a, b) { return !!(a && b && a !== b && GAME_MODES[G.mode]?.teams && a.team && a.team === b.team); }
function teamColor(team) {
  if (G.mode === 'rumble') return team === 1 ? [0.22, 0.52, 0.98] : [0.94, 0.27, 0.22];
  return HUMAN_COLORS[(Math.max(1, team) - 1) % HUMAN_COLORS.length];
}
function livingTeams() { return Array.from(new Set(G.ents.filter(e => e.alive).map(e => e.team))); }

const G = {
  state: 'menu',            // menu | drop | play | dead | win
  t: 0, dt: 0,
  ents: [], player: null,
  storm: null,
  tracers: [], dmgNums: [], feed: [], parts: [],
  hitMark: 0, critMark: 0, elimFlash: 0, elimName: '', hurtFlash: 0,
  hurtDirs: [],             // where recent hits came from, for the damage direction arcs
  alive: 0, placement: 0, mode: 'solo', teamScores: [0, 0], matchEnded: false,
  msg: '', msgT: 0,
  firstPerson: false,
  paused: false,
  aimAssist: true,          // see padLook() and mouseAssist()
  recoilScale: 1,           // FN.recoil(scale): multiplier on every kick (0 = none)
  bus: null, mini: null, menuT: 0,
  spec: null,               // entity the camera follows after dying in a lobby match
};

let R = null, hudCv = null, hud = null;
let TEX = null;               // procedural textures (textures.js)
let PIECE_MESH = null;        // [mat] -> { cube, ramp, cone } textured mesh ids
let ITEM_MESH = null;         // { ammo, medkit, bus }
const _v = [0, 0, 0], _scr = [0, 0];
// separate scratch vectors — buildPlan, the camera and the aim assist all want a
// direction at the same time and must not scribble on each other's
const _av = [0, 0, 0], _bv = [0, 0, 0], _cv = [0, 0, 0], _camv = [0, 0, 0];

/* ------------------------------- entities ---------------------------------- */

function makeEntity(isBot, name, color, skin) {
  return {
    isBot, name, color, skin,
    id: 0, human: !isBot, remote: false, team: 0, respawnT: 0,   // remote = driven by the network, not simulated here
    pos: [0, 0, 0], vel: [0, 0, 0],
    yaw: 0, pitch: 0,
    hp: 100, shield: 0, alive: true, deadT: 0,
    grounded: false, sprint: false, onRamp: false,
    mats: [0, 0, 0], ammo: { light: 0, medium: 0, shells: 0 },
    inv: [{ id: 'pickaxe', rar: 0, mag: 0 }, null, null, null, null],
    slot: 0, kills: 0,
    fireT: 0, reloadT: 0, swingT: 0, useT: 0, useKind: null, useSlot: 0,
    buildMode: false, buildType: 0, buildRot: 0, buildMat: MAT_WOOD, buildT: 0, buildArm: -1, buildKey: null,
    // recoil (see updateRecoil): applied view offset, its target, the permanent part
    // still to land, the burst's climb so far, seconds since the last shot, bloom,
    // and the visual gun / body jolt
    rp: 0, ry: 0, rpT: 0, ryT: 0, rpPend: 0, rAcc: 0, rT: 9, bloom: 0, gunKick: 0,
    hurtT: 0, muzzleT: 0,
    // animation
    anim: null, upper: null, xf: new Float32Array(16), animPhase: Math.random() * 3,
    // bot brain
    think: 0, target: null, wander: [0, 0], strafe: 1, strafeT: 0, stuckT: 0, wallT: 0, burst: 0, aimT: 0,
    targetMemory: 0, lastSeenX: null, lastSeenZ: null, lastSeenY: null,
    dodgeT: 0, role: 'tactical',
    skill: 0.5, landing: null, glide: false,
  };
}

function entEye(e) { return e.pos[1] + EYE_H; }
function curItem(e) { return e.inv[e.slot]; }
function curWeapon(e) { const it = curItem(e); return it ? WEAPONS[it.id] : null; }

/* -------------------------------- match ------------------------------------ */

// A match is described by a `setup`: the world seed, the humans in it and
// whether bots fill the rest. Solo play is a setup with one human. Everything
// random about the world and the roster runs under the seed, so every client in
// a lobby builds the identical map, bot list and drop line from the same setup.
function soloSetup() {
  return { seed: (Math.random() * 4294967296) >>> 0, mode: 'solo', humans: [{ id: 1, name: 'You', skin: 'char_knight' }], bots: true, myId: 1, authority: true };
}

function newMatch(setup) {
  if (!setup) setup = soloSetup();
  World.authority = setup.authority !== false;
  G.mode = GAME_MODES[setup.mode] ? setup.mode : 'solo';
  G.teamScores = [0, 0]; G.matchEnded = false;
  World.ents = G.ents;
  G.ents.length = 0; G.tracers.length = 0; G.dmgNums.length = 0; G.feed.length = 0; G.parts.length = 0;
  G.hurtDirs.length = 0; G.elimFlash = 0; G.hurtFlash = 0;
  G.spec = null;
  const pois = withSeed(setup.seed, generateWorld);
  if (R) {   // R is null in headless harnesses
    R.setTerrain(buildTerrainMesh());
    const sp = buildSplat();
    R.setSplat(sp.data, sp.size);
    R._half = HALF;
    R.setHeightRange(TERRAIN_MIN, TERRAIN_MAX);
    G.mini = buildMinimap();
  }
  G.t = 0; G.placement = 0; G.msg = ''; G.msgT = 0;

  withSeed((setup.seed ^ 0x9E3779B9) >>> 0, () => {
    const humans = setup.humans.slice().sort((a, b) => a.id - b.id);
    humans.forEach((h, i) => {
      const e = makeEntity(false, h.name, HUMAN_COLORS[i % HUMAN_COLORS.length], h.skin || 'char_knight');
      e.id = h.id;
      e.remote = h.id !== setup.myId;
      e.team = G.mode === 'rumble' ? 1 : G.mode === 'duos' ? Math.floor(i / 2) + 1 : i + 1;
      if (GAME_MODES[G.mode].teams) e.color = teamColor(e.team);
      e.mats = [50, 0, 0];
      e.ammo = { light: 60, medium: 40, shells: 12 };
      G.ents.push(e);
    });
    G.player = G.ents.find(e => e.id === setup.myId) || G.ents[0];

    const names = BOT_NAMES.slice();
    if (setup.bots) for (let i = humans.length; i < PLAYER_COUNT; i++) {
      const n = names.length ? names.splice((Math.random() * names.length) | 0, 1)[0] : 'Bot' + i;
      const b = makeEntity(true, n, [rnd(0.35, 0.95), rnd(0.3, 0.9), rnd(0.35, 0.95)], pick(CHAR_SKINS));
      b.id = 1000 + i;          // far above any lobby id the relay could ever hand out
      b.team = G.mode === 'rumble' ? (i < 12 ? 1 : 2) : G.mode === 'duos' ? Math.floor(i / 2) + 1 : b.id;
      if (GAME_MODES[G.mode].teams) b.color = teamColor(b.team);
      b.remote = !World.authority;
      b.skill = rnd(0.34, 0.92);
      b.role = pick(['aggressive', 'tactical', 'marksman', 'survivor']);
      b.think = rnd(0.02, 0.25);
      b.shield = Math.round(rnd(0, BOT_SHIELD));
      b.mats = [rnd(60, 180) | 0, rnd(0, 80) | 0, 0];
      // spread landings out — a whole lobby landing on one roof is a bloodbath
      b.landing = Math.random() < 0.75 ? pick(pois) : { x: rnd(-HALF + 20, HALF - 20), z: rnd(-HALF + 20, HALF - 20) };
      b.landing = { x: b.landing.x + rnd(-55, 55), z: b.landing.z + rnd(-55, 55) };
      G.ents.push(b);
    }

    if (G.mode === 'rumble') {
      // Team Rumble starts on opposite sides, with a full fighting loadout.
      for (const e of G.ents) {
        const blue = e.team === 1;
        e.pos[0] = (blue ? -105 : 105) + rnd(-12, 12);
        e.pos[2] = rnd(-34, 34);
        e.pos[1] = terrainHeight(e.pos[0], e.pos[2]) + 0.05;
        e.vel.fill(0); e.yaw = blue ? -Math.PI / 2 : Math.PI / 2;
        e.grounded = true; e.landed = true; e.glide = false;
        e.hp = 100; e.shield = 50; e.mats = [500, 500, 500];
        e.ammo = { light: 120, medium: 180, shells: 48 };
        e.inv[1] = { id: 'ar', rar: 1, mag: WEAPONS.ar.mag };
        e.inv[2] = { id: 'shotgun', rar: 1, mag: WEAPONS.shotgun.mag };
        e.slot = 1;
      }
      G.bus = null;
    } else {
      // Battle-bus line across the map: everyone has just jumped.
      const busA = rnd(0, Math.PI * 2);
      const bx = Math.cos(busA), bz = Math.sin(busA);
      const sx = -bx * HALF * 0.85, sz = -bz * HALF * 0.85;
      let hi = 0;
      for (let i = 0; i < G.ents.length; i++) {
        const e = G.ents[i];
        const distance = e.human ? HALF * 0.9 - (hi++) * 4 : rnd(HALF * 0.2, HALF * 1.5);
        e.pos[0] = clamp(sx + bx * distance + rnd(-6, 6), -HALF + 20, HALF - 20);
        e.pos[2] = clamp(sz + bz * distance + rnd(-6, 6), -HALF + 20, HALF - 20);
        e.pos[1] = rnd(150, 172);
        e.vel[0] = bx * 22; e.vel[2] = bz * 22; e.vel[1] = -2;
        e.yaw = Math.atan2(-bx, -bz);
        e.glide = false;
        if (G.mode === 'sniper') {
          e.inv[1] = { id: 'dmr', rar: 2, mag: WEAPONS.dmr.mag };
          e.inv[2] = { id: 'sniper', rar: 1, mag: WEAPONS.sniper.mag };
          e.slot = 1; e.ammo.medium = 72;
        }
        if (G.mode === 'zero') { e.shield = 50; e.mats = [0, 0, 0]; }
      }
      G.bus = { x: sx + bx * HALF * 1.6, z: sz + bz * HALF * 1.6, y: 178, dx: bx, dz: bz, t: 0 };
    }
    newStorm();
  });
  // remote entities are placed by the network, so the drop never waits on them
  for (const e of G.ents) if (e.remote) e.landed = true;
  G.alive = G.ents.length;
  G.state = G.mode === 'rumble' ? 'play' : 'drop';
  say(G.mode === 'rumble' ? 'TEAM RUMBLE — FIRST TO 20 ELIMINATIONS' : (Input.padActive ? 'DROP IN — hold the left stick forward to dive' : 'DROP IN — hold W to dive'));
}

function entById(id) { for (const e of G.ents) if (e.id === id) return e; return null; }

function respawnEntity(e, data) {
  if (!e || G.mode !== 'rumble') return;
  e.alive = true; e.hp = 100; e.shield = 50; e.deadT = 0; e.respawnT = 0;
  e.pos[0] = data.x; e.pos[1] = data.y === undefined ? terrainHeight(data.x, data.z) + 0.05 : data.y; e.pos[2] = data.z;
  e.vel.fill(0); e.yaw = data.yaw || 0; e.pitch = 0;
  e.grounded = true; e.landed = true; e.glide = false; e.sprint = false;
  e.useT = 0; e.useKind = null; e.fireT = 0; e.reloadT = 0; e.hurtT = 0;
  e.buildMode = false; e.mats = [500, 500, 500];
  e.ammo = { light: 120, medium: 180, shells: 48 };
  if (!e.inv[1] || !WEAPONS[e.inv[1].id]) e.inv[1] = { id: 'ar', rar: 1, mag: WEAPONS.ar.mag };
  if (!e.inv[2] || !WEAPONS[e.inv[2].id]) e.inv[2] = { id: 'shotgun', rar: 1, mag: WEAPONS.shotgun.mag };
  e.slot = 1; e.upper = null;
  if (e.anim && e.anim.play) e.anim.play('Idle_A', 0.12, true);
  G.alive++;
}
function tickRespawns(dt) {
  if (!World.authority || G.mode !== 'rumble' || G.matchEnded) return;
  for (const e of G.ents) {
    if (e.alive || !(e.respawnT > 0)) continue;
    e.respawnT = Math.max(0, e.respawnT - dt);
    if (e.respawnT > 0) continue;
    const blue = e.team === 1;
    const x = (blue ? -105 : 105) + rnd(-12, 12);
    const z = rnd(-34, 34);
    const data = { x, z, y: terrainHeight(x, z) + 0.05, yaw: blue ? -Math.PI / 2 : Math.PI / 2 };
    respawnEntity(e, data);
    if (Net.hosting) Net.respawn(e, data);
  }
}

function newStorm() {
  if (G.mode === 'rumble') {
    G.storm = { cx: 0, cz: 0, r: HALF * 2, tcx: 0, tcz: 0, tr: HALF * 2, phase: STORM_PHASES.length, timer: STORM_DONE_T, shrinking: false, dps: 0, r0: HALF * 2, tickT: 0 };
    return;
  }
  G.storm = {
    cx: rnd(-40, 40), cz: rnd(-40, 40), r: HALF * 1.45,
    tcx: 0, tcz: 0, tr: HALF * 1.45,
    phase: -1, timer: 4, shrinking: false, dps: 0, r0: HALF * 1.45, tickT: 0,
  };
  nextStormPhase();
}

// Past the last circle the storm is closed for good: nothing left to count down
// to (the HUD says so — see stormLabel), only the damage tick keeps running.
const STORM_DONE_T = 1e9;

function nextStormPhase() {
  const s = G.storm;
  s.phase++;
  if (s.phase >= STORM_PHASES.length) { s.shrinking = false; s.timer = STORM_DONE_T; return; }
  const ph = STORM_PHASES[s.phase];
  s.dps = ph.dps;
  s.tr = s.r0 * ph.r;
  const move = Math.max(0, s.r - s.tr) * 0.75;
  const a = rnd(0, Math.PI * 2), d = rnd(0, move);
  s.tcx = clamp(s.cx + Math.cos(a) * d, -HALF + s.tr, HALF - s.tr);
  s.tcz = clamp(s.cz + Math.sin(a) * d, -HALF + s.tr, HALF - s.tr);
  s.timer = ph.wait; s.shrinking = false; s.shrinkDur = ph.shrink;
  s.fromR = s.r; s.fromX = s.cx; s.fromZ = s.cz;
}

function updateStorm(dt) {
  const s = G.storm;
  if (s.phase < STORM_PHASES.length) s.timer -= dt;
  if (!World.authority) {   // phase changes and damage come from the host
    if (s.shrinking) {
      const k = 1 - clamp(s.timer / s.shrinkDur, 0, 1);
      s.r = lerp(s.fromR, s.tr, k); s.cx = lerp(s.fromX, s.tcx, k); s.cz = lerp(s.fromZ, s.tcz, k);
    }
    return;
  }
  if (s.timer <= 0 && s.phase < STORM_PHASES.length) {
    if (!s.shrinking) {
      s.shrinking = true; s.timer = s.shrinkDur;
      s.fromR = s.r; s.fromX = s.cx; s.fromZ = s.cz;
      say('THE STORM IS CLOSING'); Sfx.warn();
    } else { s.r = s.tr; s.cx = s.tcx; s.cz = s.tcz; nextStormPhase(); }
  }
  if (s.shrinking) {
    const k = 1 - clamp(s.timer / s.shrinkDur, 0, 1);
    s.r = lerp(s.fromR, s.tr, k);
    s.cx = lerp(s.fromX, s.tcx, k);
    s.cz = lerp(s.fromZ, s.tcz, k);
  }
  s.tickT -= dt;
  if (s.tickT <= 0) {
    s.tickT = 1;
    for (const e of G.ents) {
      if (!e.alive) continue;
      if (dist2(e.pos[0], e.pos[2], s.cx, s.cz) > s.r * s.r) applyDamage(e, s.dps, null, false, true);
    }
  }
}

function inStorm(x, z) { const s = G.storm; return dist2(x, z, s.cx, s.cz) > s.r * s.r; }

// The HUD's storm line. After the final circle there is nothing to count down.
function stormLabel(s) {
  if (s.phase >= STORM_PHASES.length) return 'STORM CLOSED';
  const t = Math.max(0, s.timer);
  const mm = Math.floor(t / 60), ss = Math.floor(t % 60);
  return (s.shrinking ? 'STORM MOVING  ' : 'STORM IN  ') + mm + ':' + String(ss).padStart(2, '0');
}

/* -------------------------------- combat ----------------------------------- */

function entBoxes(e) {
  const [x, y, z] = e.pos;
  return [
    { minx: x - 0.40, maxx: x + 0.40, miny: y, maxy: y + 1.48, minz: z - 0.40, maxz: z + 0.40, head: false },
    { minx: x - 0.28, maxx: x + 0.28, miny: y + 1.48, maxy: y + 1.95, minz: z - 0.28, maxz: z + 0.28, head: true },
  ];
}

function rayEntities(ox, oy, oz, dx, dy, dz, maxT, ignore) {
  let best = null, bestT = maxT;
  for (const e of G.ents) {
    if (!e.alive || e === ignore) continue;
    if (Math.abs(e.pos[0] - ox) > maxT + 2 || Math.abs(e.pos[2] - oz) > maxT + 2) continue;
    for (const b of entBoxes(e)) {
      const t = rayAABB(ox, oy, oz, dx, dy, dz, b, bestT);
      if (t >= 0 && t < bestT) { bestT = t; best = { t, ent: e, head: b.head }; }
    }
  }
  return best;
}

// Where a hit goes. Solo and the lobby host apply it; a client shows the hit
// (marker, number, flinch) and reports it to the host, who owns everyone's health.
function dealDamage(target, dmg, attacker, head) {
  if (sameTeam(target, attacker)) return;
  if (World.authority) { applyDamage(target, dmg, attacker, head, false); return; }
  if (!target.alive) return;
  target.hurtT = 0.25;
  playUpper(target, 'Hit_A', 0.45);
  if (attacker === G.player) {
    G.hitMark = 0.14; if (head) G.critMark = 0.2;
    Sfx.hit(head, false);
    pushDamage(target.pos[0], target.pos[1] + 1.8, target.pos[2], Math.round(dmg), head, target.shield > 0);
    Net.hit(target, dmg, head);
  }
}
function dealPieceDamage(p, dmg, harvest) {
  if (World.authority) return damagePiece(p, dmg, harvest);
  p.hp -= dmg;                                   // predicted — the host says when it actually goes
  if (!(p.hitT > 0)) World.flashing.push(p);
  p.hitT = 0.18;
  Net.dmgPiece(p.key, dmg, harvest);
  return harvest ? (p.hp <= 0 ? 30 : 12) : 0;
}
function dealPropDamage(p, dmg) {
  if (World.authority) return damageProp(p, dmg);
  p.hp -= dmg;
  if (!(p.hitT > 0)) World.flashing.push(p);
  p.hitT = 0.15;
  Net.dmgProp(p.id, dmg);
  return p.hp <= 0 ? 34 : 15;
}

function applyDamage(target, dmg, attacker, head, byStorm) {
  if (!target.alive || sameTeam(target, attacker)) return;
  let d = dmg;
  const hadShield = target.shield > 0;
  if (target.shield > 0) { const s = Math.min(target.shield, d); target.shield -= s; d -= s; }
  target.hp -= d;
  target.hurtT = 0.25;
  if (!byStorm) playUpper(target, 'Hit_A', 0.45);
  if (attacker && attacker !== target && !byStorm) target.lastHitBy = attacker.id;   // the snapshot carries it to a client
  if (target === G.player) {
    G.hurtFlash = 0.35; Sfx.hurt();
    if (attacker && attacker !== target && !byStorm) hurtFrom(attacker.pos[0], attacker.pos[2]);
  }
  if (attacker === G.player) {
    G.hitMark = 0.14; if (head) G.critMark = 0.2;
    Sfx.hit(head, hadShield && target.shield <= 0);
    pushDamage(target.pos[0], target.pos[1] + 1.8, target.pos[2], Math.round(dmg), head, hadShield);
  }
  if (target.hp <= 0) eliminate(target, attacker, byStorm);
}

// A hit on the player from somewhere: remembered for a second so the HUD can
// draw an arc toward the shooter.
function hurtFrom(x, z) {
  G.hurtDirs.push({ x, z, t: 1.1 });
  if (G.hurtDirs.length > 6) G.hurtDirs.shift();
}

function eliminate(e, attacker, byStorm, placement) {
  if (!e.alive) return;
  const rumble = G.mode === 'rumble';
  e.alive = false; e.hp = 0; e.deadT = 0;
  e.respawnT = rumble ? 4.0 : 0;
  e.glide = false;
  if (e.anim) e.anim.play('Death_A', 0.08, false, true);
  e.upper = null;
  G.alive = Math.max(0, G.alive - 1);
  if (attacker && attacker !== e) attacker.kills++;

  // Team Rumble keeps the loadout and sends eliminated players back to their base.
  if (World.authority && !rumble) {
    const spill = [];
    for (let i = 1; i < 5; i++) if (e.inv[i]) spill.push(e.inv[i]);
    for (const it of spill) {
      const kind = (it.id === 'shield' || it.id === 'medkit') ? it.id : 'weapon';
      tossLoot(spawnLoot(kind, e.pos[0], e.pos[1] + 1.1, e.pos[2], { item: it }),
        rnd(-3, 3), rnd(4.5, 7), rnd(-3, 3), 0.4);
    }
    tossLoot(spawnAmmoLoot(e.pos[0], e.pos[1] + 1.1, e.pos[2], pick(AMMO_TYPES), 45),
      rnd(-3, 3), rnd(4.5, 7), rnd(-3, 3), 0.4);
    for (let m = 0; m < 3; m++) {
      if (e.mats[m] < 30) continue;
      tossLoot(spawnLoot('mats', e.pos[0], e.pos[1] + 1.1, e.pos[2], { mat: m, n: Math.min(e.mats[m], 90) | 0 }),
        rnd(-3, 3), rnd(4.5, 7), rnd(-3, 3), 0.4);
    }
  }

  if (rumble && attacker && attacker.team && attacker.team !== e.team && World.authority) {
    G.teamScores[attacker.team - 1] = (G.teamScores[attacker.team - 1] || 0) + 1;
  }
  spawnParticles(e.pos[0], e.pos[1] + 1.0, e.pos[2], 18, [0.95, 0.35, 0.35], 5, 0.16, 0.7, 14);
  addFeed(byStorm ? 'Storm' : (attacker ? attacker.name : '???'), e.name);
  if (Net.hosting) Net.elim(e, attacker, byStorm, G.alive + 1);

  if (e === G.player) {
    if (rumble) {
      say('ELIMINATED — RESPAWNING IN 4 SECONDS');
    } else {
      G.placement = placement || G.alive + 1;
      G.state = 'dead';
      if (document.pointerLockElement) document.exitPointerLock();
    }
    Sfx.elim();
  } else if (attacker === G.player) {
    G.elimFlash = 1.7; G.elimName = e.name; Sfx.kill();
  }
  if (!World.authority) return;

  if (rumble) {
    if (G.teamScores[0] >= GAME_MODES.rumble.scoreLimit || G.teamScores[1] >= GAME_MODES.rumble.scoreLimit) {
      G.matchEnded = true;
      const winningTeam = G.teamScores[0] >= GAME_MODES.rumble.scoreLimit ? 1 : 2;
      const winner = G.ents.find(x => x.team === winningTeam) || null;
      if (Net.hosting) Net.end(winner);
      else if (G.player.team === winningTeam) { G.state = 'win'; G.placement = 1; Sfx.win(); }
    }
    return;
  }

  const teams = G.mode === 'duos' ? livingTeams() : [];
  const finished = G.mode === 'duos' ? teams.length <= 1 : G.alive <= 1;
  if (finished) {
    const winningTeam = G.mode === 'duos' ? teams[0] : null;
    const winner = G.ents.find(x => x.alive && (winningTeam === undefined || x.team === winningTeam)) || G.ents.find(x => x.alive) || null;
    if (G.player.alive && (!winningTeam || G.player.team === winningTeam)) {
      G.state = 'win'; G.placement = 1; Sfx.win();
      if (G.player.anim) G.player.anim.play('Cheer', 0.2, true);
      if (document.pointerLockElement) document.exitPointerLock();
    }
    if (Net.hosting) Net.end(winner);
  }
}

function pushDamage(x, y, z, val, crit, shield) {
  G.dmgNums.push({ x, y, z, val, crit, shield: !!shield, t: 0, life: 0.9, ox: rnd(-0.4, 0.4) });
  if (G.dmgNums.length > 40) G.dmgNums.shift();
}
function addFeed(a, b) {
  G.feed.unshift({ a, b, t: 5.5 });
  if (G.feed.length > 5) G.feed.pop();
}
function say(text) { G.msg = text; G.msgT = 2.6; }

/* ------------------------------- particles --------------------------------- */
// Little cubes with gravity — impact sparks, wood chips, brick dust, build puffs.

function spawnParticles(x, y, z, n, col, speed, size, life, grav) {
  if (G.parts.length > 900) return;
  for (let i = 0; i < n; i++) {
    const a = rnd(0, Math.PI * 2), u = rnd(-1, 1), s = speed * rnd(0.3, 1);
    const r = Math.sqrt(1 - u * u);
    G.parts.push({
      x, y, z, vx: r * Math.cos(a) * s, vy: (u * 0.5 + 0.6) * s, vz: r * Math.sin(a) * s,
      col, size: size * rnd(0.6, 1.3), t: 0, life: life * rnd(0.6, 1.2), grav: grav === undefined ? 18 : grav,
      spin: rnd(0, 6), yaw: rnd(0, 6),
    });
  }
}
function updateParticles(dt) {
  const P = G.parts;
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    p.t += dt;
    if (p.t >= p.life) { P[i] = P[P.length - 1]; P.pop(); continue; }
    p.vy -= p.grav * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    p.yaw += p.spin * dt;
    const g = terrainHeight(p.x, p.z);
    if (p.y < g) { p.y = g; p.vy *= -0.3; p.vx *= 0.6; p.vz *= 0.6; }
  }
}
function materialChips(col, x, y, z, n) {
  spawnParticles(x, y, z, n, col, 4.5, 0.14, 0.6, 20);
}

// One shot (or one pellet volley). dirX/Y/Z must be normalised.
function fireShot(e, ox, oy, oz, dx, dy, dz, dmg, range, tracerCol) {
  const hitStatic = rayWorld(ox, oy, oz, dx, dy, dz, range);
  const hitEnt = rayEntities(ox, oy, oz, dx, dy, dz, hitStatic ? hitStatic.t : range, e);
  let end = hitStatic ? hitStatic.t : range;
  if (hitEnt) {
    end = hitEnt.t;
    dealDamage(hitEnt.ent, dmg * (hitEnt.head ? HEAD_MUL : 1), e, hitEnt.head);
    spawnParticles(ox + dx * end, oy + dy * end, oz + dz * end, 4, [0.9, 0.25, 0.25], 2.5, 0.09, 0.4, 12);
  } else if (hitStatic) {
    const c = hitStatic.col;
    const hx = ox + dx * end, hy = oy + dy * end, hz = oz + dz * end;
    if (c.kind === 'piece') { dealPieceDamage(c.ref, dmg * 0.85, false); materialChips(MAT_COLOR[c.ref.mat], hx, hy, hz, 4); }
    else if (c.kind === 'prop') { dealPropDamage(c.ref, dmg * 0.8); materialChips(MAT_COLOR[c.ref.mat], hx, hy, hz, 4); }
    else spawnParticles(hx, hy, hz, 3, [0.55, 0.45, 0.32], 2, 0.1, 0.4, 14);
  }
  pushTracer(ox, oy, oz, ox + dx * end, oy + dy * end, oz + dz * end, tracerCol);
  if (Net.inMatch) Net.tracer(e, ox, oy, oz, ox + dx * end, oy + dy * end, oz + dz * end);
}
function pushTracer(ax, ay, az, bx, by, bz, col) {
  G.tracers.push({ ax, ay, az, bx, by, bz, t: 0.055, col });
  if (G.tracers.length > 120) G.tracers.shift();
}

function tryFire(e, aimX, aimY, aimZ) {
  const it = curItem(e);
  if (!it || e.fireT > 0 || e.reloadT > 0 || e.useT > 0) return false;
  const w = WEAPONS[it.id];
  if (w.melee) { swingPickaxe(e); return true; }
  if (it.mag <= 0) { startReload(e); return false; }
  it.mag--;
  e.fireT = w.rate;
  e.muzzleT = 0.05;
  playUpper(e, it.id === 'pistol' ? '1H_Ranged_Shoot' : '2H_Ranged_Shoot', it.id === 'sniper' ? 0.6 : 0.3);
  // shots leave the gun's muzzle, not the eye — the muzzle sits a little right and below
  const gp = gunPoint(e);
  const ox = gp[0], oy = gp[1], oz = gp[2];
  const dmg = weaponDamage(it) * TTK * (e.isBot ? BOT_DMG : 1);
  const spread = shotSpread(e, w);
  e.gunKick = 1;   // visual only: the gun and the body jolt, springing back over ~0.15 s
  const pellets = w.pellets || 1;
  const col = e === G.player ? [1.0, 0.95, 0.6] : [1.0, 0.55, 0.25];
  for (let p = 0; p < pellets; p++) {
    const sx = rnd(-spread, spread), sy = rnd(-spread, spread), sz = rnd(-spread, spread);
    let dx = aimX + sx, dy = aimY + sy, dz = aimZ + sz;
    const l = len3(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    fireShot(e, ox, oy, oz, dx, dy, dz, dmg, w.range, col);
  }
  if (e === G.player) {
    addRecoil(e, w);   // bots never kick — their inaccuracy is all spread
    Sfx.shoot(it.id);
  } else {
    const d2 = dist2(e.pos[0], e.pos[2], G.player.pos[0], G.player.pos[2]);
    if (d2 < 95 * 95) Sfx.shoot(it.id, clamp(1.1 - Math.sqrt(d2) / 95, 0.12, 1));   // quieter with distance
  }
  if (it.mag <= 0) startReload(e);
  return true;
}

/* --------------------------------- recoil ---------------------------------- */

// The cone the next shot leaves through, radians per axis: the weapon's base
// spread, a third of it when aiming, up to 1.7x on the move (ramping with speed,
// full at walking pace) and, for the player, blooming with sustained fire. Bots are
// deliberately sloppy by skill instead — full accuracy at 8 shots/sec is
// unsurvivable. The crosshair draws exactly this.
function shotSpread(e, w) {
  const speed = len2(e.vel[0], e.vel[2]);
  if (e.isBot) return w.spread * (7 - e.skill * 4) * (speed > 3 ? 1.7 : 1);
  let s = w.spread * (e.ads ? 0.35 : 1) * (1 + 0.7 * clamp(speed / WALK_SPEED, 0, 1));
  const r = w.recoil;
  if (r && r.bloomMax) s *= 1 + r.bloomMax * e.bloom;
  return s;
}

// No profile (pickaxe, a heal in hand): nothing kicks; anything left over settles fast.
const REC_NONE = { kickT: 0.03, delay: 0, rec: 20 };

// One shot's kick, local player only (profiles: RECOIL in world.js). Nothing moves
// the view here: the kick goes into a *target* offset (rpT / ryT) that updateRecoil
// lands over the profile's kickT, so a shot reads as a fast rise rather than a jump.
// A burst's climb is a pattern that flattens at `max` — rAcc counts it whether or
// not the player has been pulling down — so held fire settles at a bounded offset
// instead of walking off the target; the sideways jitter is a capped random walk.
// `frac` of each kick is recoverable, the rest stays until the player re-aims.
function addRecoil(e, w) {
  const r = w.recoil;
  if (!r) return;
  const m = (e.ads ? r.ads : 1) * G.recoilScale;
  const kick = Math.min(Math.max(0, r.max * m - e.rAcc), r.kick * m * (0.9 + 0.2 * Math.random()));
  e.rAcc += kick;
  e.rpT += kick * r.frac;
  e.rpPend += kick * (1 - r.frac);
  const lim = r.jitMax * m;
  e.ryT = clamp(e.ryT + rnd(-r.jit, r.jit) * m, -lim, lim);
  e.bloom = Math.min(1, e.bloom + r.bloom);
  e.rT = 0;
}

// Advance the recoil model by dt — time-based, so 30 and 144 fps see the same
// climb and the same recovery. pitch0 / yaw0 are the view before this frame's look
// input and aim assist ran:
//  1. compensation — whatever that input moved the view *against* the offset comes
//     out of the offset (target and applied alike), not out of the aim. Recovery
//     then only returns the part the player did not pull down themselves, so it
//     can never overshoot below where they aimed; the aim assist's pull is treated
//     the same way instead of stacking with the recovery;
//  2. after `delay` without a shot the targets shrink toward zero (the burst
//     pattern and the bloom reset with them);
//  3. the applied offset (rp / ry — the part of the view that is recoil) chases the
//     target and the view moves by exactly that much; the permanent part of each
//     kick drains in through the same filter.
function updateRecoil(e, dt, pitch0, yaw0) {
  const w = curWeapon(e);
  const r = (w && w.recoil) || REC_NONE;
  let c = opposing(e.pitch - pitch0, e.rpT); e.rpT -= c; e.rp -= c;
  c = opposing(angleDelta(yaw0, e.yaw), e.ryT); e.ryT -= c; e.ry -= c;
  e.rT += dt;
  if (e.rT > r.delay) {
    const f = Math.exp(-r.rec * dt);
    e.rpT = settle(e.rpT * f); e.ryT = settle(e.ryT * f); e.rAcc = settle(e.rAcc * f);
    e.bloom = settle(e.bloom * Math.exp(-6 * dt));
  }
  const k = 1 - Math.exp(-dt / r.kickT);
  const dp = (e.rpT - e.rp) * k, dy = (e.ryT - e.ry) * k, dperm = e.rpPend * k;
  e.rp += dp; e.ry += dy; e.rpPend -= dperm;
  e.pitch = clamp(e.pitch + dp + dperm, -1.5, 1.5);
  e.yaw = wrapAngle(e.yaw + dy);
  decayKick(e, dt);
}
// The part of a look input that pushes against a recoil offset (0 when it agrees
// with it), signed like the offset so `off -= opposing(...)` moves it toward zero.
function opposing(input, off) {
  if (input * off >= 0) return 0;
  const a = Math.min(input < 0 ? -input : input, off < 0 ? -off : off);
  return off < 0 ? -a : a;
}
function settle(v) { return v > -2e-4 && v < 2e-4 ? 0 : v; }
// the visual gun / body jolt springs back over ~0.15 s (every entity that fires)
function decayKick(e, dt) { if (e.gunKick > 0) e.gunKick = e.gunKick < 0.01 ? 0 : e.gunKick * Math.exp(-14 * dt); }
function gunPunch(it) { const w = it && WEAPONS[it.id]; return w && w.recoil ? w.recoil.punch : 0; }

// Where an entity's held gun sits in the world (muzzle flashes, tracer origin).
// Tracers from the eye look like they come out of the forehead in third person.
function gunPoint(e) {
  const rx = Math.cos(e.yaw), rz = -Math.sin(e.yaw), fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
  _v[0] = e.pos[0] + rx * 0.28 + fx * 0.55; _v[1] = entEye(e) - 0.32 + Math.sin(e.pitch) * 0.5; _v[2] = e.pos[2] + rz * 0.28 + fz * 0.55;
  return _v;
}

function startReload(e) {
  const it = curItem(e);
  if (!it || it.mag === undefined) return;
  const w = WEAPONS[it.id];
  if (!w || !w.ammo || it.mag >= w.mag) return;   // potions and medkits have no magazine
  if (!e.isBot && e.ammo[w.ammo] <= 0) { if (e === G.player) say('OUT OF ' + w.ammo.toUpperCase() + ' AMMO'); return; }
  e.reloadT = w.reload;
  e.reloadItem = it;          // the reload belongs to this gun; a slot switch cancels it
  playUpper(e, it.id === 'pistol' ? '1H_Ranged_Reload' : '2H_Ranged_Reload', w.reload);
  sfxNear(e, () => Sfx.reload(w.reload));
}
function finishReload(e) {
  const it = curItem(e), w = it ? WEAPONS[it.id] : null;
  const mine = it && it === e.reloadItem;
  e.reloadItem = null;
  // The timer ran out on something else (wheeled to a potion, swapped the gun
  // for one on the ground): that item gets nothing — it never started a reload.
  if (!mine || !w || !w.ammo) return;
  if (e.isBot) { it.mag = w.mag; return; }
  const need = w.mag - it.mag;
  const have = Math.min(need, e.ammo[w.ammo]);
  it.mag += have; e.ammo[w.ammo] -= have;
}

// Whatever was in progress on the held slot stops when the slot changes: a reload
// must not finish on the next gun, a heal must not eat whatever is held by then.
function cancelActions(e) {
  e.reloadT = 0; e.reloadItem = null;
  if (e.useT > 0) { e.useT = 0; e.useKind = null; }
}

// Consumables. The slot is remembered so a finished heal consumes the potion it
// started on — never whatever happens to be held by then.
function startUse(e) {
  const it = curItem(e);
  if (!it || (it.id !== 'shield' && it.id !== 'medkit') || e.useT > 0) return false;
  e.useT = it.id === 'shield' ? 2.2 : 3.6; e.useKind = it.id; e.useSlot = e.slot;
  playUpper(e, 'Use_Item', e.useT);
  return true;
}
function finishUse(e) {
  const kind = e.useKind, slot = e.useSlot, it = e.inv[slot];
  e.useT = 0; e.useKind = null;
  if (!kind || !it || it.id !== kind) return;     // lost or switched away mid-use
  e.inv[slot] = null;
  if (!World.authority) Net.heal(kind);           // the host keeps the health
  else if (kind === 'shield') e.shield = Math.min(100, e.shield + 50);
  else e.hp = Math.min(100, e.hp + 100);
  if (e === G.player) Sfx.pickup();
}

function swingPickaxe(e) {
  e.fireT = WEAPONS.pickaxe.rate;
  e.swingT = 0.28;
  playUpper(e, '1H_Melee_Attack_Chop', 0.5);
  Sfx.swing();
  const dir = dirFrom(e.yaw, e.pitch, _v);
  const ox = e.pos[0], oy = entEye(e), oz = e.pos[2];
  const range = WEAPONS.pickaxe.range;
  const hitEnt = rayEntities(ox, oy, oz, dir[0], dir[1], dir[2], range, e);
  const hitStatic = rayWorld(ox, oy, oz, dir[0], dir[1], dir[2], range);
  if (hitEnt && (!hitStatic || hitEnt.t < hitStatic.t)) {
    dealDamage(hitEnt.ent, WEAPONS.pickaxe.dmg, e, hitEnt.head);
    return;
  }
  if (!hitStatic) return;
  const c = hitStatic.col;
  let mats = 0, matType = MAT_WOOD;
  if (c.kind === 'prop') { mats = dealPropDamage(c.ref, WEAPONS.pickaxe.harvest); matType = c.ref.mat; }
  else if (c.kind === 'piece') { mats = dealPieceDamage(c.ref, WEAPONS.pickaxe.harvest, true); matType = c.ref.mat; }
  else return;
  const t = hitStatic.t;
  materialChips(MAT_COLOR[matType], ox + dir[0] * t, oy + dir[1] * t, oz + dir[2] * t, 7);
  sfxNear(e, () => Sfx.harvest(matType));
  if (mats > 0) {
    e.mats[matType] = Math.min(999, e.mats[matType] + mats);
    if (e === G.player) pushDamage(ox + dir[0] * 2, oy + dir[1] * 2, oz + dir[2] * 2, mats, false);
  }
}

/* -------------------------------- building --------------------------------- */

// Fortnite's placement rule, for players and bots alike. A piece goes on the
// grid next to you in the direction you face — a wall on the first grid line in
// front, even one you are straddling (the wall then pushes you clear, see
// depenetrate), a floor / ramp / cone in the tile in front — at the storey your
// feet are on. Looking up builds a storey higher,
// looking well down a storey lower; the manual rotation (R / X) turns the facing
// a quarter at a time. If that storey has nothing to hold the piece, the storeys
// either side are tried before giving up — and the ghost always shows the result.
function buildPlan(e) {
  const type = BUILD_TYPES[e.buildType];
  const yaw = e.yaw - (e.buildRot & 3) * Math.PI / 2;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const alongX = Math.abs(fx) > Math.abs(fz);
  const sx = fx > 0 ? 1 : -1, sz = fz > 0 ? 1 : -1;
  const px = e.pos[0], pz = e.pos[2], feet = e.pos[1];
  const pgx = Math.floor(px / GRID), pgz = Math.floor(pz / GRID);
  const pitch = e === G.player ? e.pitch : 0;
  // On a ramp the next piece continues from the top of it; otherwise a piece
  // sits at the storey whose floor is at (or a step below) your feet.
  let gy = (type === 'ramp' && e.onRamp) ? Math.round(feet / LEV) : Math.floor((feet + STEP_UP) / LEV);
  if (pitch > 0.6) gy += 1; else if (pitch < -0.85) gy -= 1;
  let plan;
  if (type === 'wall') {
    if (alongX) {
      const line = sx > 0 ? Math.ceil(px / GRID) : Math.floor(px / GRID);
      plan = { type, gx: line, gy, gz: pgz, rot: 3 };
    } else {
      const line = sz > 0 ? Math.ceil(pz / GRID) : Math.floor(pz / GRID);
      plan = { type, gx: pgx, gy, gz: line, rot: 0 };
    }
  } else {
    let gx = pgx + (alongX ? sx : 0), gz = pgz + (alongX ? 0 : sz);
    if (type !== 'ramp' && pitch < -1.05) { gx = pgx; gz = pgz; }   // straight down: under yourself
    let rot = 0;
    if (type === 'ramp') rot = alongX ? (sx < 0 ? 1 : 3) : (sz < 0 ? 0 : 2);
    if (type === 'cone' && pitch > 0.35) gy += 1;
    plan = { type, gx, gy, gz, rot };
  }
  if (canPlace(plan.type, plan.gx, plan.gy, plan.gz, plan.rot)) return plan;
  // Already occupied is a real "no" — searching on from there would let a held
  // turbo-build button run a tower straight up into the sky.
  if (World.pieces.has(pieceKey(plan.type, plan.gx, plan.gy, plan.gz, plan.rot))) return plan;
  for (const dy of [1, -1, 2]) {
    const c = { type, gx: plan.gx, gy: plan.gy + dy, gz: plan.gz, rot: plan.rot };
    if (canPlace(c.type, c.gx, c.gy, c.gz, c.rot)) return c;
  }
  return plan;      // nothing sticks — show the red ghost where it would have gone
}

function tryBuild(e) {
  if (!GAME_MODES[G.mode].building) { if (e === G.player) say('BUILDING IS DISABLED IN ZERO BUILD'); return false; }
  const plan = buildPlan(e);
  if (e.mats[e.buildMat] < BUILD_COST) { if (e === G.player) say('NOT ENOUGH ' + MAT_NAME[e.buildMat].toUpperCase()); return false; }
  if (!canPlace(plan.type, plan.gx, plan.gy, plan.gz, plan.rot)) return false;
  const p = addPiece(plan.type, plan.gx, plan.gy, plan.gz, plan.rot, e.buildMat, e);
  if (!p) return false;
  p.born = G.t;
  if (Net.inMatch) Net.piecePlaced(p, e);
  e.mats[e.buildMat] -= BUILD_COST;
  e.buildT = 0.14;
  playUpper(e, 'Interact', 0.3);
  const [cx, cz] = tileCenter(plan.gx, plan.gz);
  materialChips(MAT_COLOR[e.buildMat], cx, plan.gy * LEV + 0.5, cz, 6);
  if (e === G.player || dist2(e.pos[0], e.pos[2], G.player.pos[0], G.player.pos[2]) < 60 * 60) Sfx.build();
  return true;
}

/* --------------------------------- player ---------------------------------- */

function updatePlayer(e, dt) {
  // look — yaw is folded back into (-PI, PI] every frame. Left-turning raises it,
  // so leaving it to accumulate meant it grew without bound over a match, and
  // anything downstream doing angle arithmetic on it drifted out of range.
  const pitch0 = e.pitch, yaw0 = e.yaw;   // updateRecoil tells the player's own look from the kick by these
  e.yaw = wrapAngle(e.yaw - Input.dx);
  e.pitch = clamp(e.pitch - Input.dy, -1.5, 1.5);
  if (Input.padActive) padLook(e, dt); else mouseAssist(e, dt);
  updateRecoil(e, dt, pitch0, yaw0);
  updateCamera(e, dt);

  const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
  const rx = Math.cos(e.yaw), rz = -Math.sin(e.yaw);
  let ix = Input.moveX, iz = Input.moveZ;
  if (Input.down('KeyW')) iz += 1;
  if (Input.down('KeyS')) iz -= 1;
  if (Input.down('KeyD')) ix += 1;
  if (Input.down('KeyA')) ix -= 1;
  const len = len2(ix, iz);
  if (len > 1) { ix /= len; iz /= len; }   // clamp, don't normalise — a half-tilted stick walks
  const wishX = fx * iz + rx * ix, wishZ = fz * iz + rz * ix;

  if (G.state === 'drop') { updateSkydive(e, dt, wishX, wishZ, true); return; }

  // Sprint is a toggle: tap Shift (or click L3) to start, tap again to stop.
  // Stopping still isn't automatic — standing still while toggled on just walks
  // off at double speed again the moment you push a direction.
  if (Input.hit('ShiftLeft') || Input.hit('ShiftRight')) e.sprint = !e.sprint;
  const speed = (e.sprint ? WALK_SPEED * 2 : WALK_SPEED) * (e.useT > 0 ? 0.4 : 1);
  const accel = e.grounded ? 60 : 14;
  e.vel[0] += (wishX * speed - e.vel[0]) * Math.min(1, accel * dt);
  e.vel[2] += (wishZ * speed - e.vel[2]) * Math.min(1, accel * dt);
  if (e.grounded && Input.down('Space')) { e.vel[1] = 9.4; e.grounded = false; }
  e.vel[1] -= 30 * dt;
  const wasAir = !e.grounded, fallV = e.vel[1];
  moveEntity(e, dt);
  if (wasAir && e.grounded && e.vel[1] <= 0) {
    spawnParticles(e.pos[0], e.pos[1] + 0.1, e.pos[2], 5, [0.6, 0.55, 0.45], 1.8, 0.1, 0.35, 8);
    e.landK = clamp(-fallV / 16, 0.25, 1);          // camera dip scaled by how hard you hit
    if (Sfx.land) Sfx.land(e.landK);
  }

  // ---- inventory / mode switching ----
  for (let i = 0; i < 5; i++) if (Input.hit('Digit' + (i + 1))) { if (i !== e.slot) cancelActions(e); e.slot = i; e.buildMode = false; }
  // in build mode the wheel picks the piece, otherwise the inventory slot
  if (Input.wheel) {
    if (e.buildMode) e.buildType = (e.buildType + (Input.wheel > 0 ? 1 : 3)) % 4;
    else cycleSlot(e, Input.wheel);
  }
  if (Input.hit('KeyQ')) {
    if (GAME_MODES[G.mode].building) e.buildMode = !e.buildMode;
    else say('BUILDING IS DISABLED IN ZERO BUILD');
  }
  // Keyboard Builder Pro: the piece key selects *and* places on the same press,
  // and holding it turbo-builds — same rule as the pad shoulders.
  const bindings = { KeyZ: 0, KeyX: 1, KeyC: 2, KeyV: 3 };
  for (const k in bindings) {
    if (Input.hit(k)) {
      if (GAME_MODES[G.mode].building) { e.buildMode = true; e.buildType = bindings[k]; e.buildKey = k; }
      else say('BUILDING IS DISABLED IN ZERO BUILD');
    }
    if (e.buildKey === k && Input.down(k) && e.buildMode && e.buildT <= 0) tryBuild(e);
  }
  if (e.buildKey && !Input.down(e.buildKey)) e.buildKey = null;
  if (Input.hit('KeyT')) {
    for (let i = 1; i <= 3; i++) { const m = (e.buildMat + i) % 3; if (e.mats[m] > 0 || i === 3) { e.buildMat = m; break; } }
  }
  if (Input.hit('KeyP')) G.firstPerson = !G.firstPerson;
  if (Input.hit('KeyE')) interact(e);
  if (Input.hit('KeyG')) { if (Input.down('ShiftLeft') || Input.down('ShiftRight')) dropAmmo(e); else dropHeld(e); }
  if (Input.padActive) builderPro(e);

  // ---- action ----
  const padFireHeld = Input.padDown(PAD.RT) && !e.buildMode;
  const padFireHit = Input.padHit(PAD.RT) && !e.buildMode;
  e.ads = (Input.mouse[2] || Input.padDown(PAD.LT)) && !e.buildMode;
  if (e.buildMode) {
    if (Input.mouse[0] && e.buildT <= 0) tryBuild(e);
    if (Input.hit('KeyR')) e.buildRot = (e.buildRot + 1) % 4;
  } else {
    const it = curItem(e);
    if (it && (it.id === 'shield' || it.id === 'medkit')) {
      if (Input.clicked[0] || padFireHit) startUse(e);
    } else if (it) {
      const w = WEAPONS[it.id];
      const auto = it.id === 'ar' || it.id === 'smg';
      if (auto ? (Input.mouse[0] || padFireHeld) : (Input.clicked[0] || padFireHit)) {
        const aim = playerAimDir(e);
        tryFire(e, aim[0], aim[1], aim[2]);
      }
      if (Input.hit('KeyR')) startReload(e);
    }
  }
  if (e.useT > 0) { e.useT -= dt; if (e.useT <= 0) finishUse(e); }
  autoPickup(e);
}

// Third-person shots must converge on the crosshair, so aim at whatever the
// camera is looking at and fire from the body toward that point.
function playerAimDir(e) {
  const cam = cameraState(e);
  const d = dirFrom(e.yaw, e.pitch, _aimv);
  const hitS = rayWorld(cam.x, cam.y, cam.z, d[0], d[1], d[2], 300);
  const hitE = rayEntities(cam.x, cam.y, cam.z, d[0], d[1], d[2], hitS ? hitS.t : 300, e);
  const t = hitE ? hitE.t : (hitS ? hitS.t : 300);
  const tx = cam.x + d[0] * t, ty = cam.y + d[1] * t, tz = cam.z + d[2] * t;
  const gp = gunPoint(e);
  let ax = tx - gp[0], ay = ty - gp[1], az = tz - gp[2];
  const l = len3(ax, ay, az) || 1;
  return [ax / l, ay / l, az / l];
}

function cycleSlot(e, dir) {
  let s = e.slot;
  for (let i = 0; i < 5; i++) { s = (s + (dir > 0 ? 1 : 4)) % 5; if (e.inv[s]) break; }
  if (s !== e.slot) cancelActions(e);
  e.slot = s; e.buildMode = false;
}

/* ------------------------------- gamepad ----------------------------------- */

// Fortnite's Builder Pro preset. B is the one door in and out of build mode; once
// you are building, each of the four pieces owns a shoulder button — LT stairs,
// RT wall, LB roof, RB floor — where the first press selects it, every press after
// that places it, and holding it keeps placing (turbo build). No cycling, no
// separate "place" button. In combat those same shoulders are Fire, Aim and weapon
// cycling instead.
const PAD_PIECES = [[PAD.RT, 0], [PAD.RB, 1], [PAD.LT, 2], [PAD.LB, 3]];   // wall floor stairs roof

function builderPro(e) {
  // A button only builds once it has been pressed *inside* build mode, so a press
  // carried over from combat can't immediately slap down a piece as well.
  if (e.buildArm >= 0 && !Input.padDown(e.buildArm)) e.buildArm = -1;

  if (Input.padHit(PAD.B)) {
    e.buildMode = !e.buildMode; e.buildArm = -1;
    if (e.buildMode) cancelActions(e);
  }

  if (!e.buildMode) {
    if (Input.padHit(PAD.LB)) cycleSlot(e, -1);
    if (Input.padHit(PAD.RB)) cycleSlot(e, 1);
  } else {
    for (const [btn, type] of PAD_PIECES) {
      // One press selects the piece *and* places it — waiting for a second tap is
      // exactly the lag that loses a build fight. Holding still turbo-builds, and
      // buildArm still means a trigger carried over from combat can't place: it
      // takes a fresh press inside build mode to arm.
      if (Input.padHit(btn)) { e.buildType = type; e.buildArm = btn; }
      if (e.buildArm === btn && Input.padDown(btn) && e.buildT <= 0) tryBuild(e);
    }
    if (Input.padHit(PAD.X)) e.buildRot = (e.buildRot + 1) % 4;
  }
  if (Input.padHit(PAD.Y)) { if (e.slot !== 0) cancelActions(e); e.slot = 0; e.buildMode = false; }   // pickaxe
  if (Input.padHit(PAD.UP)) cycleSlot(e, 1);
  if (Input.padHit(PAD.DOWN)) cycleSlot(e, -1);
  if (!e.buildMode && Input.padHit(PAD.X)) {        // one contextual button, as on console
    if (nearChest(e) || lookedAtLoot(e, PICKUP_RANGE)) interact(e);
    else startReload(e);
  }
}

// Right-stick look. A stick cannot match a mouse in a hitscan game, so a visible
// enemy inside a narrow cone of the crosshair slows the stick down and pulls the
// aim gently toward them — the same assist every console shooter ships.
function padLook(e, dt) {
  const tgt = (G.aimAssist && G.state === 'play' && !e.buildMode) ? assistTarget(e) : null;
  // Slowdown only bites in proportion to how centred the target actually is, so a
  // body at the edge of the cone never feels like the stick has gone heavy.
  const near = tgt ? tgt.aim : 0;                       // 0 = edge of cone, 1 = dead centre
  const slow = 1 - (1 - (e.ads ? 0.45 : 0.65)) * near;
  e.yaw -= Input.lookX * slow * dt;
  e.pitch = clamp(e.pitch - Input.lookY * slow * dt, -1.5, 1.5);
  if (!tgt) return;

  // Magnetism is measured from the player's *eye*, not the camera. The camera
  // orbits with yaw, so a want-yaw derived from it moves as soon as the assist
  // starts turning — a feedback loop that settles off-centre and then shoves back
  // when you turn against it. That was the "I can't look left at people, it keeps
  // kicking my view right" bug.
  const ex = e.pos[0], ey = entEye(e), ez = e.pos[2];
  const o = tgt.ent;
  const flat = Math.sqrt(dist2(ex, ez, o.pos[0], o.pos[2]));
  const wantYaw = Math.atan2(-(o.pos[0] - ex), -(o.pos[2] - ez));
  const wantPitch = Math.atan2(entEye(o) - ey, flat);
  const dyaw = angleDelta(e.yaw, wantYaw);

  // Hands off the moment the stick is pushing away from them. e.yaw -= lookX, so
  // agreeing with the pull means lookX and dyaw have opposite signs; the same sign
  // is a deliberate turn away and the assist must not answer it.
  if (Input.lookX * dyaw > 0 && Math.abs(Input.lookX) > Input.padLook * 0.1) return;
  const flick = Math.min(1, Math.hypot(Input.lookX, Input.lookY) / Input.padLook);
  const k = Math.min(1, (e.ads ? 1.7 : 0.9) * near * (1 - flick) * dt);
  e.yaw += dyaw * k;
  e.pitch = clamp(e.pitch + (wantPitch - e.pitch) * k, -1.5, 1.5);
}

// Mouse aim assist. A mouse needs no slowdown, but aiming in nudges the
// crosshair the rest of the way onto whoever is already near it: a small snap on
// the frame ADS starts, then a light magnetism while it is held. It's deliberately
// weaker than the pad version and lets go whenever the mouse is pulling away.
function mouseAssist(e, dt) {
  const ads = !!Input.mouse[2] && !e.buildMode;
  const started = ads && !e.adsWas;
  e.adsWas = ads;
  if (!ads || !G.aimAssist || G.state !== 'play') return;
  const tgt = assistTarget(e);
  if (!tgt) return;
  const ex = e.pos[0], ey = entEye(e), ez = e.pos[2];
  const o = tgt.ent;
  const flat = Math.sqrt(dist2(ex, ez, o.pos[0], o.pos[2]));
  const wantYaw = Math.atan2(-(o.pos[0] - ex), -(o.pos[2] - ez));
  const wantPitch = Math.atan2(entEye(o) - ey, flat);
  const dyaw = angleDelta(e.yaw, wantYaw), dpitch = wantPitch - e.pitch;
  // e.yaw -= dx, so a mouse moving with the pull has dx and dyaw of opposite sign;
  // the same sign is a deliberate turn away. Same for pitch.
  if (Input.dx * dyaw > 0 && Math.abs(Input.dx) > 0.0015) return;
  if (Input.dy * dpitch > 0 && Math.abs(Input.dy) > 0.0015) return;
  const near = tgt.aim;                                  // 0 = cone edge, 1 = centred
  const k = started ? 0.3 + 0.3 * near : Math.min(1, 1.2 * near * dt);
  e.yaw = wrapAngle(e.yaw + dyaw * k);
  e.pitch = clamp(e.pitch + dpitch * k, -1.5, 1.5);
}

const ASSIST_CONE = 0.975;        // ~12.8 degrees — outside this there is no assist at all
const ASSIST_FULL = 0.9955;       // ~5.4 degrees — full strength

// Nearest enemy under the crosshair, with how centred they are. Measured from the
// eye so it agrees with the magnetism in padLook.
function assistTarget(e) {
  const ex = e.pos[0], ey = entEye(e), ez = e.pos[2];
  const d = dirFrom(e.yaw, e.pitch, _av);
  let best = null, bestDot = ASSIST_CONE;
  for (const o of G.ents) {
    if (o === e || !o.alive) continue;
    const dx = o.pos[0] - ex, dy = entEye(o) - ey, dz = o.pos[2] - ez;
    const l = len3(dx, dy, dz);
    if (l > 95 || l < 1) continue;
    const dot = (dx * d[0] + dy * d[1] + dz * d[2]) / l;
    if (dot <= bestDot) continue;
    if (!losClear(ex, ey, ez, o.pos[0], entEye(o), o.pos[2])) continue;
    bestDot = dot; best = o;
  }
  if (!best) return null;
  const n = clamp((bestDot - ASSIST_CONE) / (ASSIST_FULL - ASSIST_CONE), 0, 1);
  return { ent: best, aim: n * n * (3 - 2 * n) };      // smoothstep, so it fades in
}

function updateSkydive(e, dt, wishX, wishZ, isPlayer) {
  const ground = terrainHeight(e.pos[0], e.pos[2]);
  const glide = e.pos[1] - ground < 45;
  e.glide = glide;
  const fall = glide ? 13 : 42;
  const drive = glide ? 16 : 26;
  e.vel[1] = -fall;
  const dive = isPlayer ? (Input.down('KeyW') || Input.moveZ > 0.45 ? 1 : 0) : 1;
  e.vel[0] = lerp(e.vel[0], wishX * drive * (dive ? 1 : 0.6), Math.min(1, 2.4 * dt));
  e.vel[2] = lerp(e.vel[2], wishZ * drive * (dive ? 1 : 0.6), Math.min(1, 2.4 * dt));
  e.pos[0] = clamp(e.pos[0] + e.vel[0] * dt, -HALF + 2, HALF - 2);
  e.pos[2] = clamp(e.pos[2] + e.vel[2] * dt, -HALF + 2, HALF - 2);
  const prevY = e.pos[1];
  e.pos[1] += e.vel[1] * dt;
  // land on whatever is under you — a roof or a floor as readily as the ground
  const land = surfaceUnder(e.pos[0], e.pos[1], e.pos[2], prevY);
  if (e.pos[1] <= land + 0.05) {
    e.pos[1] = land; e.vel[0] = e.vel[1] = e.vel[2] = 0; e.glide = false; e.grounded = true;
    spawnParticles(e.pos[0], e.pos[1] + 0.1, e.pos[2], 8, [0.6, 0.55, 0.45], 2.5, 0.12, 0.45, 8);
    if (isPlayer) { G.state = 'play'; say('LOOT UP'); e.landK = 1; if (Sfx.land) Sfx.land(1); }
    else e.landed = true;
  }
}

function nearChest(e) {
  for (const ch of World.chests) {
    if (ch.opened) continue;
    if (dist2(e.pos[0], e.pos[2], ch.x, ch.z) < 9 && Math.abs(e.pos[1] - ch.y) < 3) return ch;
  }
  return null;
}

function interact(e) {
  // chests first
  const ch = nearChest(e);
  if (ch) {
    playUpper(e, 'Interact', 0.6);
    if (!World.authority) { Net.chest(World.chests.indexOf(ch)); return; }   // the host rolls the loot
    openChest(ch, e);
    return;
  }
  // then whatever you are pointing at. Bots have no crosshair, so they still grab
  // the nearest thing instead.
  const l = e === G.player ? lookedAtLoot(e, PICKUP_RANGE) : nearestLoot(e, 2.4);
  if (l && requestTake(e, l, e === G.player)) playUpper(e, 'PickUp', 0.5);
}

// Roll and fling a chest's contents (solo / host). `e` is whoever opened it.
function openChest(ch, e) {
  if (ch.opened) return;
  ch.opened = true; ch.openT = 0;
  const n = 3 + ((Math.random() * 2) | 0);
  const before = World.loot.length;
  for (let i = 0; i < n; i++) randomLootAt(ch.x, ch.y + 0.9, ch.z, 1);
  // fling the contents out of the lid so they visibly come from the chest
  for (let i = before; i < World.loot.length; i++) {
    const a = ((i - before) / n) * Math.PI * 2 + rnd(-0.4, 0.4);
    tossLoot(World.loot[i], Math.cos(a) * rnd(3.5, 6), rnd(6, 8.5), Math.sin(a) * rnd(3.5, 6), 0.5);
  }
  if (Net.hosting) Net.chestOpened(World.chests.indexOf(ch));
  chestBurst(ch, e);
}
function chestBurst(ch, e) {
  spawnParticles(ch.x, ch.y + 0.8, ch.z, 14, [1.0, 0.85, 0.35], 3.5, 0.1, 0.8, 6);
  if (e) { sfxNear(e, () => Sfx.chest()); if (e === G.player) say('CHEST OPENED'); }
}

// Picking something up. Solo and the host just take it; a client asks the host,
// who removes the item for everyone and tells the taker to pocket it — so two
// people lunging for one gun can't both get it.
function requestTake(e, l, swap) {
  if (World.authority) return takeLoot(e, l, swap);
  if (l.cool > 0) return false;
  if (l.kind !== 'ammo' && l.kind !== 'mats') {
    const free = e.inv.findIndex((x, i) => i > 0 && !x) > 0;
    if (!free && !swap) return false;
  }
  return Net.take(l, swap);
}

// A dropped or swapped-out item. Solo and the host spawn it; a client asks the
// host to, so the item gets one id everyone agrees on.
function netDropLoot(kind, x, y, z, data, vx, vy, vz, cool) {
  if (World.authority) return tossLoot(spawnLoot(kind, x, y, z, data), vx, vy, vz, cool);
  Net.drop({ kind, x, y, z, data, vx, vy, vz, cool });
  return null;
}
function firstEmptyOr(e) { for (let i = 1; i < 5; i++) if (!e.inv[i]) return i; return 1; }

const PICKUP_RANGE = 4.5;

// The item you are pointing at: the one closest to the *centre of view*, scored by
// angle rather than distance, so aiming picks a specific gun out of a pile.
// The ray starts at the player's eye, not the camera — at pickup range the camera's
// shoulder offset is bigger than the gap between two items on the ground, so a
// camera ray reliably chooses the wrong one. If nothing is in view, whatever you are
// standing on counts; a press is still a press.
function lookedAtLoot(e, range) {
  const d = dirFrom(e.yaw, e.pitch, _lookv);
  const ox = e.pos[0], oy = entEye(e), oz = e.pos[2];
  let best = null, bestAng = 0.42;                 // ~24 degrees off centre, stick-friendly
  for (const l of World.loot) {
    if (l.cool > 0) continue;
    if (dist2(ox, oz, l.x, l.z) > range * range) continue;
    if (Math.abs(l.y - e.pos[1]) > 4) continue;
    const vx = l.x - ox, vy = (l.y + 0.35) - oy, vz = l.z - oz;
    const t = vx * d[0] + vy * d[1] + vz * d[2];
    if (t <= 0) continue;                                        // behind you
    const ang = len3(vx - d[0] * t, vy - d[1] * t, vz - d[2] * t) / t;
    if (ang < bestAng) { bestAng = ang; best = l; }
  }
  return best || nearestLoot(e, 2.2);
}

// Move one ground item into an entity. `swap` lets a manual pickup replace the held
// slot when the inventory is full — that's how you trade one gun for another.
// Returns false if there was no room for it.
function takeLoot(e, l, swap) {
  if (l.cool > 0) return false;
  if (l.kind === 'ammo') {
    e.ammo[l.data.type] += l.data.n; removeLoot(l, e.id); sfxNear(e, Sfx.pickup.bind(Sfx));
    if (e === G.player) say('PICKED UP ' + l.data.n + ' ' + l.data.type.toUpperCase() + ' AMMO');
    return true;
  }
  if (l.kind === 'mats') {
    e.mats[l.data.mat] = Math.min(999, e.mats[l.data.mat] + l.data.n);
    removeLoot(l, e.id); sfxNear(e, Sfx.pickup.bind(Sfx));
    return true;
  }
  // weapons, shields and medkits all want an inventory slot
  let slot = e.inv.findIndex((x, i) => i > 0 && !x);
  if (slot < 1 && swap) slot = e.slot === 0 ? firstEmptyOr(e) : e.slot;
  if (slot < 1) { if (e === G.player) say('INVENTORY FULL'); return false; }
  const old = e.inv[slot];
  e.inv[slot] = l.kind === 'weapon' ? l.data.item
    : { id: l.kind, rar: l.kind === 'shield' ? 2 : 3, mag: 0 };
  removeLoot(l, e.id);
  cancelActions(e);   // a reload or heal in progress must not carry over onto the new item
  if (old) {   // whatever was in that slot goes back on the ground
    const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
    netDropLoot(old.id === 'shield' || old.id === 'medkit' ? old.id : 'weapon',
      e.pos[0] + fx * 0.5, e.pos[1] + 1.2, e.pos[2] + fz * 0.5, { item: old },
      fx * 4.5, 3.2, fz * 4.5, 1.1);
  }
  sfxNear(e, Sfx.pickup.bind(Sfx));
  if (e === G.player) {
    e.slot = slot;
    const it = e.inv[slot];
    say('PICKED UP ' + (it.id === 'shield' ? 'SHIELD POTION' : it.id === 'medkit' ? 'MEDKIT'
      : weaponLabel(it)).toUpperCase());
  }
  return true;
}

// Only play an actor's sound if it's the player or close enough to hear.
function sfxNear(e, fn) {
  if (e === G.player || dist2(e.pos[0], e.pos[2], G.player.pos[0], G.player.pos[2]) < 45 * 45) fn();
}

// Throw whatever is in the held slot out in front of the player. The pickaxe
// can't be dropped (it is what you fall back on with an empty inventory).
function dropHeld(e) {
  if (e.slot === 0) { if (e === G.player) say("CAN'T DROP THE PICKAXE"); return false; }
  const it = e.inv[e.slot];
  if (!it) return false;
  const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
  netDropLoot(it.id === 'shield' || it.id === 'medkit' ? it.id : 'weapon',
    e.pos[0] + fx * 0.6, e.pos[1] + 1.25, e.pos[2] + fz * 0.6, { item: it },
    fx * 6.5, 3.4, fz * 6.5, 1.1);
  e.inv[e.slot] = null;
  cancelActions(e);
  playUpper(e, 'Throw', 0.5);
  Sfx.swing();
  if (e === G.player) {
    say('DROPPED ' + (it.id === 'shield' ? 'SHIELD POTION' : it.id === 'medkit' ? 'MEDKIT' : weaponLabel(it)).toUpperCase());
  }
  return true;
}

// Throw a stack of the held weapon's ammo (shift+G) — handy for a teammate or
// just clearing space you don't need.
function dropAmmo(e) {
  const it = curItem(e);
  const type = it && WEAPONS[it.id] ? WEAPONS[it.id].ammo : null;
  if (!type || e.ammo[type] <= 0) { if (e === G.player) say('NO AMMO TO DROP'); return false; }
  const n = Math.min(e.ammo[type], 30);
  e.ammo[type] -= n;
  const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
  netDropLoot('ammo', e.pos[0] + fx * 0.6, e.pos[1] + 1.25, e.pos[2] + fz * 0.6, { type, n },
    fx * 5.5, 3.2, fz * 5.5, 1.1);
  playUpper(e, 'Throw', 0.5);
  Sfx.swing();
  if (e === G.player) say('DROPPED ' + n + ' ' + type.toUpperCase());
  return true;
}

function nearestLoot(e, rad) {
  let best = null, bd = rad * rad;
  for (const l of World.loot) {
    if (l.cool > 0) continue;
    const d = dist2(e.pos[0], e.pos[2], l.x, l.z);
    if (d < bd && Math.abs(l.y - e.pos[1]) < 3) { bd = d; best = l; }
  }
  return best;
}
function removeLoot(l, by) {
  const i = World.loot.indexOf(l);
  if (i < 0) return;
  World.loot.splice(i, 1);
  if (Net.hosting) Net.lootGone(l, by);
}

// Walking over something only collects materials and ammo. Guns and heals have to
// be picked up deliberately with E / X so you never swallow a worse weapon by
// accident. Bots have no crosshair to point, so they keep hoovering everything up.
const AUTO_KINDS = { mats: 1, ammo: 1 };
function autoPickup(e) {
  const restricted = e === G.player;
  for (let i = World.loot.length - 1; i >= 0; i--) {
    const l = World.loot[i];
    if (restricted && !AUTO_KINDS[l.kind]) continue;
    if (l.cool > 0) continue;
    if (e.isBot && l.kind === 'weapon') { botPickupWeapon(e, l); continue; }
    if (dist2(e.pos[0], e.pos[2], l.x, l.z) > 2.6 || Math.abs(l.y - e.pos[1]) > 3) continue;
    requestTake(e, l, false);
  }
}

/* ---------------------------------- bots ----------------------------------- */

// Bots evaluate their own inventory and select a weapon for the current engagement.
const BOT_WEAPON_RANGES = {
  pistol: 30, smg: 24, tacsmg: 28, ar: 58, heavyAR: 72,
  shotgun: 10, autoShotgun: 13, revolver: 36, dmr: 112, sniper: 155,
};
function botWeaponScore(b, item, distance) {
  if (!item || !WEAPONS[item.id] || !WEAPONS[item.id].ammo) return -1e6;
  const w = WEAPONS[item.id], reserve = b.ammo[w.ammo] || 0;
  if ((item.mag || 0) <= 0 && reserve <= 0) return -1e6;
  const ideal = BOT_WEAPON_RANGES[item.id] || 45;
  const fit = Math.max(0, 1 - Math.abs(distance - ideal) / (ideal * 1.5 + 22));
  const rangePenalty = distance > w.range ? 2.4 : distance > w.range * 0.9 ? 0.65 : 0;
  return fit * 2.4 + (item.rar || 0) * 0.13 + ((item.mag || 0) > 0 ? 0.28 : -0.18)
    + (reserve > 0 ? 0.08 : 0) - rangePenalty;
}
function botBestWeaponSlot(b, distance) {
  let best = -1, score = -1e6;
  for (let i = 1; i < b.inv.length; i++) {
    const value = botWeaponScore(b, b.inv[i], distance);
    if (value > score) { score = value; best = i; }
  }
  return score > -1e5 ? best : -1;
}
function botUpgradeSlot(b, item, distance) {
  const empty = b.inv.findIndex((x, i) => i > 0 && !x);
  if (empty > 0) return empty;
  const incoming = botWeaponScore(b, item, distance);
  if (incoming < -1e5) return -1;
  let weakest = -1, weakScore = 1e6;
  for (let i = 1; i < b.inv.length; i++) {
    const value = botWeaponScore(b, b.inv[i], distance);
    if (value < weakScore) { weakScore = value; weakest = i; }
  }
  return weakest > 0 && incoming > weakScore + 0.38 ? weakest : -1;
}
function botPickupWeapon(b, loot) {
  const distance = b.target && b.target.alive
    ? Math.sqrt(dist2(b.pos[0], b.pos[2], b.target.pos[0], b.target.pos[2])) : 42;
  const slot = botUpgradeSlot(b, loot.data.item, distance);
  if (slot < 1) return false;
  const replacing = !!b.inv[slot];
  if (replacing) b.slot = slot;   // takeLoot swaps the selected slot when inventory is full
  if (!takeLoot(b, loot, replacing)) return false;
  const best = botBestWeaponSlot(b, distance);
  if (best > 0) b.slot = best;
  return true;
}
function botHasGun(b) { return botBestWeaponSlot(b, 45) > 0; }

function updateBot(b, dt) {
  if (!b.alive) return;
  if (b.targetMemory > 0) b.targetMemory = Math.max(0, b.targetMemory - dt);
  if (b.dodgeT > 0) b.dodgeT = Math.max(0, b.dodgeT - dt);
  // Still coming down from the bus: keep diving until touchdown.
  if (!b.landed && b.pos[1] > terrainHeight(b.pos[0], b.pos[2]) + 0.1) {
    const dx = b.landing.x - b.pos[0], dz = b.landing.z - b.pos[2];
    const l = len2(dx, dz) || 1;
    b.yaw = Math.atan2(-dx, -dz);
    updateSkydive(b, dt, dx / l, dz / l, false);
    return;
  }

  b.think -= dt;
  if (b.think <= 0) { b.think = 0.18 + Math.random() * 0.14; botThink(b); }

  const s = G.storm;
  let goX = null, goZ = null, sprint = false;
  const dc = Math.sqrt(dist2(b.pos[0], b.pos[2], s.cx, s.cz));
  const grabFirst = b.lootTarget && dist2(b.pos[0], b.pos[2], b.lootTarget[0], b.lootTarget[1]) < 25 * 25;

  if (dc > s.r * 0.78 && !grabFirst) {
    goX = s.cx; goZ = s.cz; sprint = true;
  } else if (b.target && b.target.alive) {
    if (b.useT > 0) { b.useT = 0; b.useKind = null; } // combat interrupts a heal
    const t = b.target;
    const visible = losClear(b.pos[0], entEye(b), b.pos[2], t.pos[0], entEye(t), t.pos[2]);
    let tx = visible ? t.pos[0] : (b.lastSeenX === null ? t.pos[0] : b.lastSeenX);
    let tz = visible ? t.pos[2] : (b.lastSeenZ === null ? t.pos[2] : b.lastSeenZ);
    if (visible) {
      b.lastSeenX = tx; b.lastSeenZ = tz; b.lastSeenY = entEye(t);
      b.targetMemory = Math.max(b.targetMemory, 2.1 + b.skill * 1.1);
    }
    const dx = tx - b.pos[0], dz = tz - b.pos[2];
    const d = len2(dx, dz);
    b.yaw = Math.atan2(-dx, -dz);
    const targetY = visible ? entEye(t) : (b.lastSeenY === null ? entEye(t) : b.lastSeenY);
    b.pitch = clamp(Math.atan2(targetY - entEye(b), Math.max(1, d)), -1, 1);

    const weaponSlot = botBestWeaponSlot(b, d);
    if (weaponSlot > 0 && weaponSlot !== b.slot) b.slot = weaponSlot;
    const item = curItem(b), weapon = item && WEAPONS[item.id];
    const baseRange = weapon ? (BOT_WEAPON_RANGES[item.id] || 35) : 18;
    const roleRange = b.role === 'aggressive' ? 0.78 : b.role === 'marksman' ? 1.28 : b.role === 'survivor' ? 1.08 : 1;
    const want = clamp(baseRange * roleRange, 7, 120);

    b.strafeT -= dt;
    if (b.strafeT <= 0) {
      b.strafeT = rnd(0.55, 1.25) + (1 - b.skill) * 0.35;
      b.strafe = Math.random() < (b.role === 'aggressive' ? 0.64 : 0.5) ? -1 : 1;
    }
    const rx = Math.cos(b.yaw), rz = -Math.sin(b.yaw);
    const fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw);
    if (visible) {
      const push = clamp((d - want) / Math.max(8, want * 0.72), -1.15, 1.15);
      const side = (b.role === 'marksman' ? 2.8 : 4.6) + b.skill * 1.6;
      goX = b.pos[0] + fx * push * 6.4 + rx * b.strafe * side;
      goZ = b.pos[2] + fz * push * 6.4 + rz * b.strafe * side;

      // Small lead helps against sprinting targets without giving bots perfect tracking.
      b.aimT -= dt;
      if (weapon && !weapon.melee && weapon.ammo && d < weapon.range * 0.84) {
        if (b.burst > 0 && b.fireT <= 0 && b.reloadT <= 0 && b.aimT <= 0) {
          const gp = gunPoint(b);
          const lead = clamp(d / 180 * (0.08 + b.skill * 0.16), 0.03, 0.24);
          const error = (1 - b.skill) * 0.48;
          const ax = t.pos[0] + t.vel[0] * lead + rnd(-error, error) - gp[0];
          const ay = entEye(t) + t.vel[1] * lead * 0.12 + rnd(-error * 0.45, error * 0.45) - gp[1];
          const az = t.pos[2] + t.vel[2] * lead + rnd(-error, error) - gp[2];
          const l = len3(ax, ay, az) || 1;
          tryFire(b, ax / l, ay / l, az / l);
          b.burst--;
          if (b.burst <= 0) b.aimT = rnd(0.72, 1.55) - b.skill * 0.22;
        }
      } else b.burst = 0;
    } else {
      // Lost sight: move toward the last place seen and try to find another angle.
      b.burst = 0;
      const push = clamp((d - 5) / 9, 0, 1);
      goX = b.pos[0] + fx * push * 7.2 + rx * b.strafe * 2.5;
      goZ = b.pos[2] + fz * push * 7.2 + rz * b.strafe * 2.5;
      sprint = d > 12;
    }

    // A little evasive movement when hit; higher-skill bots time it more often.
    if (b.hurtT > 0 && b.grounded && b.dodgeT <= 0 && Math.random() < 0.025 + b.skill * 0.035) {
      b.vel[1] = rnd(7.8, 9.6);
      b.dodgeT = rnd(0.85, 1.4);
    }

    // Build a panic wall sooner, and occasionally a ramp to change the angle.
    if (b.hp + b.shield < 82 && b.wallT <= 0 && b.mats[b.buildMat] >= BUILD_COST && b.grounded) {
      b.buildType = Math.random() < 0.72 ? 0 : 2;
      if (tryBuild(b)) b.wallT = rnd(1.8, 3.6);
    }
  } else {
    goX = b.wander[0]; goZ = b.wander[1];
    if (dist2(b.pos[0], b.pos[2], goX, goZ) < 9) { interact(b); botPickWander(b); }
    autoPickup(b);
    // Heal and shield up between fights, using items actually carried.
    if (b.useT <= 0) {
      const want = b.hp < 65 ? 'medkit' : b.shield < 78 ? 'shield' : null;
      const i = want ? b.inv.findIndex((x, ix) => ix > 0 && x && x.id === want) : -1;
      if (i > 0) { b.useT = want === 'shield' ? 2.2 : 3.6; b.useKind = want; b.useSlot = i; playUpper(b, 'Use_Item', b.useT); }
    }
    // Harvest for real: only gain mats from a prop actually within reach.
    b.harvestT = (b.harvestT || 0) - dt;
    if (b.harvestT <= 0) {
      b.harvestT = 1.2;
      const near = queryBoxes(b.pos[0] - 3, 0, b.pos[2] - 3, b.pos[0] + 3, 6, b.pos[2] + 3, []);
      const hit = near.find(c => c.kind === 'prop');
      if (hit) {
        const got = damageProp(hit.ref, WEAPONS.pickaxe.harvest);
        b.mats[hit.ref.mat] = Math.min(500, b.mats[hit.ref.mat] + got);
        if (b.slot === 0) playUpper(b, '1H_Melee_Attack_Chop', 0.5);
        materialChips(MAT_COLOR[hit.ref.mat], hit.ref.x, hit.ref.y + 1, hit.ref.z, 4);
      }
    }
  }
  b.wallT -= dt;

  let mvx = 0, mvz = 0;
  if (goX !== null) {
    const dx = goX - b.pos[0], dz = goZ - b.pos[2];
    const l = len2(dx, dz);
    if (l > 0.6) { mvx = dx / l; mvz = dz / l; if (!b.target || !b.target.alive) b.yaw = Math.atan2(-mvx, -mvz); }
  }
  const spd = sprint ? 10.2 : 7.4;
  b.vel[0] += (mvx * spd - b.vel[0]) * Math.min(1, 50 * dt);
  b.vel[2] += (mvz * spd - b.vel[2]) * Math.min(1, 50 * dt);
  b.vel[1] -= 30 * dt;

  const beforeX = b.pos[0], beforeZ = b.pos[2];
  moveEntity(b, dt);
  const moved = dist2(beforeX, beforeZ, b.pos[0], b.pos[2]);
  if ((mvx || mvz) && moved < 0.0004) {
    b.stuckT += dt;
    if (b.stuckT > 0.35) {
      if (b.grounded) b.vel[1] = 9.4;
      if (b.stuckT > 1.1) { botPickWander(b); b.stuckT = 0; }
      if (b.grounded && b.mats[b.buildMat] >= BUILD_COST && Math.random() < 0.35) {
        b.buildType = 2; tryBuild(b);
      }
    }
  } else b.stuckT = 0;

  if (b.fireT > 0) b.fireT -= dt;
  if (b.reloadT > 0) { b.reloadT -= dt; if (b.reloadT <= 0) finishReload(b); }
  if (b.useT > 0) { b.useT -= dt; if (b.useT <= 0) finishUse(b); }
}

function botThink(b) {
  let best = null, bd = 92 * 92;
  for (const e of G.ents) {
    if (e === b || !e.alive || sameTeam(b, e) || e.pos[1] > TERRAIN_MAX + 40) continue;
    if (sameTeam(b, e)) continue;
    const d = dist2(b.pos[0], b.pos[2], e.pos[0], e.pos[2]);
    if (d < bd && losClear(b.pos[0], entEye(b), b.pos[2], e.pos[0], entEye(e), e.pos[2])) { bd = d; best = e; }
  }
  // An unarmed bot only fights at close range; otherwise it keeps searching for loot.
  const canEngage = best && (botHasGun(b) || bd < 12 * 12);
  if (canEngage) {
    b.target = best;
    b.lastSeenX = best.pos[0]; b.lastSeenZ = best.pos[2]; b.lastSeenY = entEye(best);
    b.targetMemory = 2.1 + b.skill * 1.1;
  } else if (!b.target || !b.target.alive || b.targetMemory <= 0 || !botHasGun(b)) {
    b.target = null; b.burst = 0;
  }
  const distance = b.target && b.target.alive
    ? Math.sqrt(dist2(b.pos[0], b.pos[2], b.target.pos[0], b.target.pos[2])) : 45;
  const slot = botBestWeaponSlot(b, distance);
  if (slot > 0) b.slot = slot;
  b.lootTarget = findLootTarget(b, 76);
  if (b.lootTarget) {
    b.wander[0] = b.lootTarget[0]; b.wander[1] = b.lootTarget[1];
  } else if (!b.wander[0] && !b.wander[1]) botPickWander(b);
  if (b.target && b.target.alive) {
    if (b.burst <= 0 && Math.random() < 0.48 + b.skill * 0.42) b.burst = 2 + ((Math.random() * 5) | 0);
  } else b.burst = 0;
}

function findLootTarget(b, range) {
  let bx = null, bz = null, bd = range * range;
  const distance = b.target && b.target.alive
    ? Math.sqrt(dist2(b.pos[0], b.pos[2], b.target.pos[0], b.target.pos[2])) : 42;
  for (const l of World.loot) {
    if (l.kind !== 'weapon' || l.cool > 0 || !l.data || !l.data.item) continue;
    if (botUpgradeSlot(b, l.data.item, distance) < 1) continue;
    const d = dist2(b.pos[0], b.pos[2], l.x, l.z);
    if (d < bd) { bd = d; bx = l.x; bz = l.z; }
  }
  for (const ch of World.chests) {
    if (ch.opened) continue;
    const d = dist2(b.pos[0], b.pos[2], ch.x, ch.z);
    if (d < bd) { bd = d; bx = ch.x; bz = ch.z; }
  }
  return bx === null ? null : [bx, bz];
}

function botPickWander(b) {
  if (b.lootTarget) { b.wander[0] = b.lootTarget[0]; b.wander[1] = b.lootTarget[1]; return; }
  const s = G.storm;
  const a = rnd(0, Math.PI * 2), r = rnd(0, s.r * 0.7);
  b.wander[0] = clamp(s.cx + Math.cos(a) * r, -HALF + 5, HALF - 5);
  b.wander[1] = clamp(s.cz + Math.sin(a) * r, -HALF + 5, HALF - 5);
}

/* --------------------------------- camera ---------------------------------- */

// Camera smoothing, advanced once a frame. cameraState() itself has to be pure —
// it is called several times a frame (aim, build ghost, render) and every caller
// must see the same camera.
function updateCamera(e, dt) {
  const ey = entEye(e);
  // Stairs, ramps and rolling terrain move the eye in hard steps; lagging it
  // slightly is the difference between climbing a ramp and strobing up it.
  if (e.camY === undefined || Math.abs(e.camY - ey) > 3) e.camY = ey;
  else e.camY += (ey - e.camY) * Math.min(1, 16 * dt);

  const want = e.ads ? CAM_ADS : CAM_BOOM;
  const d = dirFrom(e.yaw, e.pitch, _camv);
  const rx = Math.cos(e.yaw), rz = -Math.sin(e.yaw);
  const off = e.ads ? 0.55 : 0.95;
  const bx = e.pos[0] + rx * off, by = e.camY + 0.5, bz = e.pos[2] + rz * off;
  const hit = rayWorld(bx, by, bz, -d[0], -d[1], -d[2], want);
  const target = hit ? Math.max(0.6, hit.t - 0.25) : want;
  if (e.camDist === undefined) e.camDist = target;
  // pull in instantly so the camera never clips through a wall, ease back out
  e.camDist = target < e.camDist ? target : e.camDist + (target - e.camDist) * Math.min(1, 7 * dt);

  // View bob: a soft two-beat cycle while the feet are on the ground and moving,
  // faster in a sprint, eased in and out so stopping never jolts. The landing
  // dip is a short half-sine started by whatever put the feet down.
  const spd = len2(e.vel[0], e.vel[2]);
  const moving = e.grounded && spd > 1.5 && (G.state === 'play');
  const sprinting = spd > WALK_SPEED * 1.35;
  e.bobT = (e.bobT || 0) + (moving ? (sprinting ? 12.5 : 9) * dt : 0);
  e.bobK = lerp(e.bobK || 0, moving ? clamp(spd / WALK_SPEED, 0, 2) : 0, Math.min(1, 6 * dt));
  if (e.landK > 0) e.landK = Math.max(0, e.landK - dt * 4);
  // a footstep at the bottom of every bob, on whatever is underfoot
  if (e === G.player && moving) {
    const beat = Math.floor(e.bobT / Math.PI);
    if (beat !== e.stepBeat) { e.stepBeat = beat; Sfx.footstep(groundMaterial(e), sprinting); }
  }

  // FOV eases into the aim rather than snapping — a hard cut every time you touch
  // the trigger is most of what "not smooth" feels like. A sprint opens it a touch.
  const it = curItem(e);
  let wantFov = (e.ads && it && WEAPONS[it.id]) ? (WEAPONS[it.id].scope ? FOV.scope : FOV.ads) : FOV.base;
  if (!e.ads && moving && sprinting) wantFov *= 1.05;
  if (e.fov === undefined) e.fov = wantFov;
  else e.fov += (wantFov - e.fov) * Math.min(1, 15 * dt);
}

// What is underfoot, for footsteps: a build piece's or prop's material, or -1 for the ground.
const _gq = [];
function groundMaterial(e) {
  queryBoxes(e.pos[0] - 0.3, e.pos[1] - 0.25, e.pos[2] - 0.3, e.pos[0] + 0.3, e.pos[1] + 0.05, e.pos[2] + 0.3, _gq);
  for (const c of _gq) if (c.ref && (c.kind === 'piece' || c.kind === 'prop')) return c.ref.mat;
  return -1;
}

// Other people's footsteps, by distance walked, audible within 30 m — you can
// hear someone coming up the stairs.
function stepSound(e) {
  const dx = e.pos[0] - (e.sx === undefined ? e.pos[0] : e.sx), dz = e.pos[2] - (e.sz === undefined ? e.pos[2] : e.sz);
  e.sx = e.pos[0]; e.sz = e.pos[2];
  const d = len2(dx, dz);
  if (d > 1.5 || !e.grounded) return;         // a teleport or a spawn, not a stride
  e.stepD = (e.stepD || 0) + d;
  if (e.stepD < 2.1) return;
  e.stepD = 0;
  const p = G.player, d2p = dist2(e.pos[0], e.pos[2], p.pos[0], p.pos[2]);
  if (d2p > 30 * 30 || d2p < 0.01) return;
  Sfx.footstep(groundMaterial(e), len2(e.vel[0], e.vel[2]) > WALK_SPEED * 1.35, clamp(1 - Math.sqrt(d2p) / 30, 0, 1) * 0.8);
}

// Everything the looping ambience needs to know this frame (see Sfx.update).
function audioState(dt) {
  if (!Sfx.ctx) return;
  const p = G.player, s = G.storm;
  const playing = G.state === 'play' || G.state === 'drop';
  let stormNear = 0, rush = 0;
  if (playing && s && p) {
    const d = Math.sqrt(dist2(p.pos[0], p.pos[2], s.cx, s.cz));
    stormNear = clamp(1 - Math.abs(s.r - d) / 45, 0, 1);
    if (G.state === 'drop') rush = clamp(-p.vel[1] / 42, 0, 1);
  }
  Sfx.update(dt, { playing, menu: G.state === 'menu', stormK: G.stormK || 0, stormNear, rush, lowK: G.lowK || 0, music: G.musicOn !== false });
}

// Camera offset from the bob and landing state — pure, so cameraState() stays pure.
function camBob(e, out) {
  const k = e.bobK || 0, t = e.bobT || 0;
  const amp = G.firstPerson ? 0.05 : 0.024;
  let y = -Math.abs(Math.sin(t)) * amp * k;
  const x = Math.sin(t * 0.5) * amp * 0.7 * k;
  if (e.landK > 0) y -= Math.sin(e.landK * Math.PI) * 0.26 * (G.firstPerson ? 1 : 0.7);
  out[0] = x; out[1] = y;
  return out;
}
const _bob = [0, 0];

const CAM_BOOM = 4.6, CAM_ADS = 2.4;

function cameraState(e) {
  const d = dirFrom(e.yaw, e.pitch, _camv);
  const rx = Math.cos(e.yaw), rz = -Math.sin(e.yaw);
  const bob = camBob(e, _bob);
  const ex = e.pos[0] + rx * bob[0], ez = e.pos[2] + rz * bob[0];
  const ey = (e.camY === undefined ? entEye(e) : e.camY) + bob[1];
  if (G.firstPerson) return { x: ex, y: ey, z: ez };
  const off = e.ads ? 0.55 : 0.95;
  const want = e.camDist === undefined ? (e.ads ? CAM_ADS : CAM_BOOM) : e.camDist;
  const bx = ex + rx * off, by = ey + 0.5, bz = ez + rz * off;
  return { x: bx - d[0] * want, y: by - d[1] * want, z: bz - d[2] * want };
}

/* --------------------------------- render ---------------------------------- */

// Fixed colours the scene loops used to build as fresh array literals on every
// object, every frame. Hoisted, they are read-only lookups instead of a few
// hundred short-lived allocations a frame.
const COL_FLASH = [1, 0.9, 0.6];
const COL_TRUNK = [0.36, 0.25, 0.15], COL_LEAF = [0.20, 0.45, 0.20];
const COL_ROCK = [0.48, 0.46, 0.44];
const COL_CHEST = [0.85, 0.68, 0.20], COL_CHEST_OPEN = [0.55, 0.44, 0.14];
const COL_GHOST_OK = [0.45, 0.85, 1.0], COL_GHOST_NO = [1.0, 0.25, 0.25];
const COL_SKIN = [0.90, 0.75, 0.62];
const COL_GLIDER = [0.92, 0.92, 0.97], COL_GLIDER_POLE = [0.35, 0.35, 0.38];
const COL_HURT = [1, 0.5, 0.5], COL_MUZZLE = [1, 0.85, 0.4];
// Tints for loaded models. These multiply the texture rather than replacing a
// flat colour, so "no tint" is white and the hit flash has to go above 1 to read
// as a flash at all.
const COL_WHITE = [1, 1, 1];
const COL_FLASH_TEX = [2.2, 1.9, 1.2];
const COL_HURT_TEX = [2.0, 1.1, 1.1];
const COL_SHIELD = [0.30, 0.55, 1.0], COL_MEDKIT = [0.95, 0.35, 0.35];
const COL_GUN_DARK = [0.20, 0.21, 0.24], COL_GUN_METAL = [0.55, 0.57, 0.62], COL_WOOD_DARK = [0.42, 0.28, 0.16];
const COL_BUS = [0.22, 0.48, 0.88], COL_BALLOON = [0.35, 0.62, 0.95];
const _aimv = [0, 0, 0], _lookv = [0, 0, 0];   // per-call-site, never shared
const _dark = [0, 0, 0], _tint = [1, 1, 1];
const _gm = new Float32Array(16), _gm2 = new Float32Array(16), _gm3 = new Float32Array(16), _gfix = new Float32Array(16);
const FOV = { base: 1.58, ads: 1.20, scope: 0.46 };   // vertical, radians (~90° V / ~123° H at 16:9)

// Model-space yaw of the KayKit characters: they face +Z, the game faces -Z.
const CHAR_YAW = Math.PI;
const CHAR_HEIGHT = 2.05;   // drawn height in metres (the collider stays ENT_H)
// The held weapon is anchored at the right hand slot but *oriented by the aim*
// (yaw + pitch), not by the hand bone — KayKit's aiming poses hold weapons
// angled across the body, and a gun that points where the character looks is
// what reads correctly. GRIP is where the hand sits in gun space.
const GUN_SCALE = 0.9;
const GUN_GRIP = { pickaxe: [0, -0.35, 0], pistol: [0, -0.14, 0.12], default: [0, -0.12, 0.16] };

// Real weapon models (Quaternius Zombie Apocalypse Kit) take over from the
// procedural assemblies in GUN_MODEL as soon as they load. The models point their
// muzzle down +Z with the origin at the grip; `pre` maps model axes into gun
// space (barrel along -Z; the fire axe is stood up like the pickaxe), `k` scales
// model units to metres, `grip` is where the hand sits and `muzzle` the barrel
// tip, both in model units. The sniper is the rifle drawn longer with a
// procedural scope on top (`extra`, same part format as GUN_MODEL).
const GUN_FLIP = [-1, 0, 0, 0, 1, 0, 0, 0, -1];
const GUN_GLTF = {
  pistol: { model: 'gun_pistol', k: 0.30, grip: [0, -0.03, -0.02], muzzle: 0.88 },
  smg: { model: 'gun_smg', k: 0.62, grip: [0, -0.07, 0.05], muzzle: 0.79 },
  ar: { model: 'gun_rifle', k: 0.55, grip: [0, -0.07, 0.17], muzzle: 1.02 },
  shotgun: { model: 'gun_shotgun', k: 0.85, grip: [0, -0.06, -0.04], muzzle: 0.97 },
  sniper: {
    model: 'gun_rifle', k: 0.74, grip: [0, -0.07, 0.17], muzzle: 1.02,
    extra: [[5, 0, 0.30, -0.02, 0.07, 0.07, 0.40, 'dark'], [0, 0, 0.25, 0.06, 0.04, 0.06, 0.05, 'acc'], [0, 0, 0.25, -0.10, 0.04, 0.06, 0.05, 'acc'], [5, 0, 0.11, -0.80, 0.06, 0.06, 0.14, 'dark']],
  },
  pickaxe: { model: 'gun_axe', k: 0.70, grip: [0.02, 0, 0.12], muzzle: 0, pre: [0, 0, -1, -1, 0, 0, 0, 1, 0] },
};
const _gunGrip = new Float32Array(3);
// Hand position in gun space for a weapon: from the model when it is loaded,
// else the table above.
function gunGrip(id) {
  const gd = GUN_GLTF[id];
  if (gd && Assets.get(gd.model)) {
    const P = gd.pre || GUN_FLIP, g = gd.grip, k = gd.k;
    _gunGrip[0] = (P[0] * g[0] + P[3] * g[1] + P[6] * g[2]) * k;
    _gunGrip[1] = (P[1] * g[0] + P[4] * g[1] + P[7] * g[2]) * k;
    _gunGrip[2] = (P[2] * g[0] + P[5] * g[1] + P[8] * g[2]) * k;
    return _gunGrip;
  }
  return GUN_GRIP[id] || GUN_GRIP.default;
}
// Muzzle offset along the gun's -Z (metres, before GUN_SCALE).
function gunMuzzle(id) {
  const gd = GUN_GLTF[id];
  return gd && Assets.get(gd.model) ? -gd.muzzle * gd.k : -1.0;
}
const PITCH_K = -0.62;   // chest bend per radian of aim pitch (sign: model faces +Z)

function renderScene() {
  const p = G.player;
  const ce = (G.spec && !p.alive) ? G.spec : p;   // whose eyes we look through (spectating follows someone else)
  let cam, yaw, pitch, fov;
  if (G.state === 'menu') {
    // slow orbit around the central POI behind the menu
    const poi = World.pois[0] || { x: 0, z: 0, y: 0 };
    const a = G.menuT * 0.08;
    const cx = poi.x + Math.cos(a) * 58, cz = poi.z + Math.sin(a) * 58, cy = poi.y + 24;
    yaw = Math.atan2(-(poi.x - cx), -(poi.z - cz));
    pitch = Math.atan2(poi.y + 4 - cy, 58);
    cam = { x: cx, y: cy, z: cz }; fov = 1.25;
  } else if (G.debugCam) {
    cam = G.debugCam; yaw = cam.yaw; pitch = cam.pitch; fov = 1.1;
  } else {
    cam = cameraState(ce);
    yaw = ce.yaw; pitch = ce.pitch;
    fov = ce.fov === undefined ? FOV.base : ce.fov;   // eased in updateCamera
  }
  R.time = G.t + G.menuT;
  R.begin(cam.x, cam.y, cam.z, yaw, pitch, fov);

  R.drawTerrain();

  const VIEW = 260;

  // build pieces
  for (const piece of World.pieces.values()) {
    const px = piece.gx * GRID + GRID / 2, pz = piece.gz * GRID + GRID / 2;
    if (!R.inView(px, pz, GRID, VIEW)) continue;
    const y0 = pieceY(piece);
    let cr, cg, cb;
    if (piece.hitT > 0) { cr = 1.8; cg = 1.6; cb = 1.1; }
    else {
      const k = 0.55 + 0.45 * (piece.hp / piece.maxHp);
      cr = k; cg = k; cb = k;
    }
    // pieces grow into place over a quarter second
    let s = 1;
    if (piece.born !== undefined && piece.born >= 0) {
      const age = G.t - piece.born;
      if (age < 0.26) { const t = age / 0.26; s = 0.12 + 0.88 * (1 + 1.5 * Math.pow(t - 1, 3) + 1.5 * Math.pow(t - 1, 2) * (t - 1) + 1) * 0.5; s = clamp(0.12 + 0.88 * (1 - Math.pow(1 - t, 3)), 0.12, 1.06); }
    }
    drawPiece(piece.type, piece.mat, piece.rot, px, y0, pz, s, cr, cg, cb, 0, 0);
  }
  for (const c of World.collapsing) {
    const [px, pz] = tileCenter(c.gx, c.gz);
    if (!R.inView(px, pz, GRID, VIEW)) continue;
    const k = 0.7 - c.t * 0.3;
    drawPiece(c.type, c.mat, c.rot, px, c.y, pz, Math.max(0.05, 1 - c.t * 0.6), k, k, k, c.spin * c.t, c.t * 0.6);
  }

  // props — a loaded .glb takes over when one is present, otherwise a plain box
  // of the same footprint. Colliders never look at the model, so sight lines and
  // cover read the same either way.
  for (const pr of World.props) {
    if (!R.inView(pr.x, pr.z, pr.cull, pr.kind === 'grass' ? 95 : pr.kind === 'bush' || pr.kind === 'rug' ? 150 : VIEW)) continue;
    const flash = pr.hitT > 0;
    const mdl = Assets.get(pr.model);
    if (mdl) {
      const t = flash ? COL_FLASH_TEX : COL_WHITE;
      R.pushModel(mdl, pr.x, pr.y, pr.z, pr.rot, pr.h, t[0], t[1], t[2], 1);
      continue;
    }
    if (pr.kind === 'tree' || pr.kind === 'tree_dead') {
      R.box(pr.x, pr.y + pr.h * 0.27, pr.z, 0.7, pr.h * 0.54, 0.7, flash ? COL_FLASH : COL_TRUNK);
      const cn = flash ? COL_FLASH : COL_LEAF;
      R.push(MESH_CONE, pr.x, pr.y + pr.h * 0.68, pr.z, 0, 0, 4.4, pr.h * 0.64, 4.4, cn[0], cn[1], cn[2], 1);
    } else {
      const c = pr.col;
      const w = c ? c.maxx - c.minx : 1, d = c ? c.maxz - c.minz : 1;
      R.box(pr.x, pr.y + pr.h / 2, pr.z, w, pr.h, d, flash ? COL_FLASH : (pr.kind === 'rock' ? COL_ROCK : MAT_COLOR[pr.mat]), 0);
    }
  }

  // chests
  const chestMdl = Assets.get('chest_z');
  for (const ch of World.chests) {
    if (!R.inView(ch.x, ch.z, 1.2, VIEW)) continue;
    const bob = ch.opened ? 0 : Math.sin(G.t * 2 + ch.t) * 0.05;
    if (chestMdl) {
      const t = ch.opened ? COL_CHEST_OPEN : COL_WHITE;
      R.pushModel(chestMdl, ch.x, ch.y + bob, ch.z, ch.rot || 0, 0.85, t[0], t[1], t[2], 1);
    } else {
      R.box(ch.x, ch.y + 0.45 + bob, ch.z, 1.4, 0.9, 1.0, ch.opened ? COL_CHEST_OPEN : COL_CHEST, ch.rot || 0);
    }
    if (!ch.opened) {   // a soft golden glow so unopened chests read from across a room
      R.push(MESH_SPHERE, ch.x, ch.y + 0.6 + bob, ch.z, 0, 0, 2.6, 1.6, 2.4, 1.0, 0.85, 0.35, 0.10);
    }
  }

  // loot — each kind gets its own silhouette so you can read it at a distance,
  // and a name tag on top of that once you are close (see drawLootLabels)
  for (const l of World.loot) {
    if (!R.inView(l.x, l.z, 2, 170)) continue;
    drawLoot(l);
  }

  // characters (dead ones linger for a few seconds, playing their fall)
  for (const e of G.ents) {
    if (!e.alive && e.deadT > 5) continue;
    if (e === ce && G.firstPerson && G.state !== 'menu') continue;   // never draw the head we look out of
    // the viewed body sits right where the boom camera pivots, so never cull it
    // on the wedge — only on distance, which it always passes
    if (e !== ce && !R.inView(e.pos[0], e.pos[2], 2.2, VIEW)) continue;   // glider is 3.4 across
    drawChar(e);
  }
  if (G.firstPerson && p.alive && G.state !== 'menu') drawFirstPersonGun(p, cam);

  // battle bus
  if (G.bus && G.bus.t < 40) drawBus(G.bus);

  // tracers + particles
  for (const t of G.tracers) R.line(t.ax, t.ay, t.az, t.bx, t.by, t.bz, 0.07, t.col, 0.9);
  for (const q of G.parts) {
    const k = 1 - q.t / q.life;
    R.push(MESH_CUBE, q.x, q.y, q.z, q.yaw, q.spin, q.size * k, q.size * k, q.size * k, q.col[0], q.col[1], q.col[2], 1);
  }

  // build ghost
  if (p.alive && p.buildMode && G.state === 'play') {
    const plan = buildPlan(p);
    const ok = canPlace(plan.type, plan.gx, plan.gy, plan.gz, plan.rot) && p.mats[p.buildMat] >= BUILD_COST;
    const c = ok ? COL_GHOST_OK : COL_GHOST_NO;
    const [gx, gz] = tileCenter(plan.gx, plan.gz);
    const y0 = plan.gy * LEV;
    if (plan.type === 'wall') {
      if (plan.rot === 0) R.box(gx, y0 + LEV / 2, plan.gz * GRID, GRID, LEV, 0.34, c, 0, 0.4);
      else R.box(plan.gx * GRID, y0 + LEV / 2, gz, 0.34, LEV, GRID, c, 0, 0.4);
    } else if (plan.type === 'floor') R.box(gx, y0 - 0.15, gz, GRID, 0.32, GRID, c, 0, 0.4);
    else if (plan.type === 'ramp') R.push(MESH_RAMP, gx, y0 + LEV / 2, gz, plan.rot * Math.PI / 2, 0, GRID, LEV, GRID, c[0], c[1], c[2], 0.4);
    else R.push(MESH_CONE, gx, y0 + CONE_H / 2, gz, 0, 0, GRID, CONE_H, GRID, c[0], c[1], c[2], 0.4);
  }

  // storm wall
  if (G.storm) {
    const s = G.storm;
    const sy = TERRAIN_MIN - 10, sh = 150;   // tall enough to wall off the highest ridge
    R.push(MESH_CYL, s.cx, sy, s.cz, 0, 0, s.r, sh, s.r, 0.55, 0.30, 0.92, 0.32);
    R.push(MESH_CYL, s.cx, sy, s.cz, 0, 0, s.r + 1.5, sh, s.r + 1.5, 0.35, 0.16, 0.75, 0.24);
  }

  updateScreenFx();
  R.end();
}

// What the post pass paints over the frame: the vignette, its purple storm
// version, the hurt flash and the low-health pulse — all eased so nothing snaps.
function updateScreenFx() {
  const fx = R.fx, p = G.player, dt = G.frameDt || 0.016;
  const playing = G.state === 'play' || G.state === 'drop';
  const inS = playing && G.storm && p && inStorm(p.pos[0], p.pos[2]) ? 1 : 0;
  G.stormK = lerp(G.stormK || 0, inS, Math.min(1, 3 * dt));
  fx[0] = G.state === 'menu' ? 0 : 0.32;
  fx[1] = G.stormK;
  fx[2] = clamp(G.hurtFlash, 0, 1);
  let low = 0;
  if (playing && p && p.alive && p.shield <= 0 && p.hp < 35) {
    const k = 1 - p.hp / 35;                       // 0 at 35 hp, 1 at death's door
    const beat = Math.sin(G.t * (5 + 5 * k));       // the heartbeat quickens as hp drops
    low = k * (0.55 + 0.45 * Math.max(0, beat));
  }
  G.lowK = lerp(G.lowK || 0, low, Math.min(1, 8 * dt));
  fx[3] = G.lowK;
}

// One build piece with its material texture. `s` is the build-up scale (walls
// grow upward from the ground, floors spread from their centre).
function drawPiece(type, mat, rot, px, y0, pz, s, cr, cg, cb, spin, tilt) {
  const M = PIECE_MESH[mat];
  if (type === 'wall') {
    if (rot === 0) R.push(M.cube, px, y0 + LEV * s / 2, pz - GRID / 2, spin, tilt, GRID * s, LEV * s, 0.32, cr, cg, cb, 1);
    else R.push(M.cube, px - GRID / 2, y0 + LEV * s / 2, pz, spin, tilt, 0.32, LEV * s, GRID * s, cr, cg, cb, 1);
  } else if (type === 'floor') {
    R.push(M.cube, px, y0 - 0.15, pz, spin, tilt, GRID * s, 0.3, GRID * s, cr, cg, cb, 1);
  } else if (type === 'ramp') {
    R.push(M.ramp, px, y0 + LEV * s / 2, pz, rot * Math.PI / 2 + spin, tilt, GRID * s, LEV * s, GRID * s, cr, cg, cb, 1);
  } else {
    R.push(M.cone, px, y0 + CONE_H * s / 2, pz, spin, tilt, GRID * s, CONE_H * s, GRID * s, cr, cg, cb, 1);
  }
}

/* --------------------------------- weapons --------------------------------- */
// Every gun is a small assembly of cubes and tubes whose silhouette identifies
// it. Parts are [mesh, dx, dy, dz, sx, sy, sz, colour] in gun space with the
// barrel along -Z; colour 'acc' takes the rarity tint, the rest gunmetal.
const C = MESH_CUBE, T = MESH_TUBE;
const GUN_MODEL = {
  pistol: [
    [C, 0, 0.05, -0.02, 0.10, 0.15, 0.40, 'dark'],   // slide
    [T, 0, 0.04, -0.28, 0.06, 0.06, 0.20, 'metal'],  // barrel
    [C, 0, -0.14, 0.13, 0.09, 0.26, 0.12, 'acc'],    // grip
    [C, 0, -0.04, 0.02, 0.03, 0.07, 0.12, 'dark'],   // trigger guard
  ],
  smg: [
    [C, 0, 0.07, 0.00, 0.13, 0.18, 0.56, 'dark'],    // receiver
    [T, 0, 0.08, -0.44, 0.07, 0.07, 0.30, 'metal'],  // barrel
    [T, 0, 0.08, -0.22, 0.14, 0.14, 0.26, 'acc'],    // shroud
    [C, 0, -0.18, 0.04, 0.10, 0.32, 0.17, 'acc'],    // fat magazine
    [C, 0, -0.12, 0.22, 0.09, 0.22, 0.11, 'dark'],   // grip
    [C, 0, 0.06, 0.36, 0.09, 0.14, 0.20, 'dark'],    // stubby stock
    [C, 0, 0.19, -0.05, 0.04, 0.06, 0.18, 'dark'],   // sight rail
  ],
  tacsmg: [
    [C, 0, 0.08, 0.02, 0.13, 0.18, 0.55, 'dark'],
    [T, 0, 0.09, -0.54, 0.065, 0.065, 0.34, 'metal'],
    [T, 0, 0.09, -0.25, 0.13, 0.13, 0.26, 'acc'],
    [C, 0, -0.17, 0.00, 0.11, 0.34, 0.18, 'acc'],
    [C, 0, -0.12, 0.20, 0.09, 0.23, 0.12, 'dark'],
    [C, 0, 0.07, 0.38, 0.10, 0.16, 0.23, 'dark'],
    [C, 0, 0.20, -0.06, 0.04, 0.06, 0.22, 'acc'],
  ],
  ar: [
    [C, 0, 0.09, 0.00, 0.12, 0.20, 0.72, 'dark'],    // receiver
    [T, 0, 0.10, -0.72, 0.06, 0.06, 0.60, 'metal'],  // barrel
    [T, 0, 0.10, -0.44, 0.13, 0.13, 0.36, 'acc'],    // handguard
    [C, 0, -0.17, -0.02, 0.09, 0.30, 0.13, 'acc'],   // magazine
    [C, 0, -0.12, 0.16, 0.09, 0.22, 0.10, 'dark'],   // grip
    [C, 0, 0.06, 0.52, 0.10, 0.19, 0.32, 'acc'],     // stock
    [C, 0, 0.25, -0.08, 0.06, 0.09, 0.24, 'dark'],   // carry handle
    [T, 0, 0.10, -1.03, 0.09, 0.09, 0.10, 'dark'],   // muzzle
  ],
  shotgun: [
    [C, 0, 0.10, 0.02, 0.14, 0.20, 0.58, 'dark'],    // receiver
    [T, 0, 0.17, -0.74, 0.09, 0.09, 0.90, 'metal'],  // barrel
    [T, 0, 0.02, -0.34, 0.08, 0.08, 0.40, 'metal'],  // tube magazine
    [T, 0, 0.02, -0.66, 0.13, 0.13, 0.34, 'acc'],    // pump
    [C, 0, -0.12, 0.24, 0.09, 0.22, 0.12, 'dark'],   // grip
    [C, 0, 0.03, 0.52, 0.12, 0.21, 0.40, 'acc'],     // wide stock
  ],
  autoShotgun: [
    [C, 0, 0.10, 0.02, 0.16, 0.23, 0.55, 'dark'],
    [T, 0, 0.14, -0.63, 0.12, 0.12, 0.76, 'metal'],
    [C, 0, -0.17, -0.06, 0.20, 0.28, 0.27, 'acc'],
    [C, 0, -0.13, 0.20, 0.10, 0.22, 0.12, 'dark'],
    [C, 0, 0.04, 0.49, 0.13, 0.20, 0.35, 'acc'],
    [T, 0, 0.26, -0.07, 0.10, 0.10, 0.16, 'dark'],
  ],
  sniper: [
    [C, 0, 0.08, 0.00, 0.11, 0.18, 0.70, 'dark'],    // receiver
    [T, 0, 0.09, -0.92, 0.05, 0.05, 1.00, 'metal'],  // very long barrel
    [T, 0, 0.29, -0.10, 0.11, 0.11, 0.50, 'dark'],   // scope
    [C, 0, 0.20, 0.02, 0.04, 0.10, 0.06, 'acc'],     // scope mount
    [C, 0, 0.20, -0.22, 0.04, 0.10, 0.06, 'acc'],
    [C, 0, -0.14, 0.00, 0.09, 0.22, 0.16, 'acc'],    // magazine
    [C, 0, -0.12, 0.20, 0.09, 0.22, 0.10, 'dark'],   // grip
    [C, 0, 0.03, 0.56, 0.11, 0.20, 0.46, 'acc'],     // long stock
    [T, 0, 0.09, -1.46, 0.08, 0.08, 0.12, 'dark'],   // muzzle brake
  ],
  heavyAR: [
    [C, 0, 0.09, 0.03, 0.15, 0.23, 0.76, 'dark'],
    [T, 0, 0.10, -0.73, 0.075, 0.075, 0.66, 'metal'],
    [T, 0, 0.10, -0.43, 0.15, 0.15, 0.38, 'acc'],
    [C, 0, -0.18, -0.03, 0.12, 0.33, 0.17, 'acc'],
    [C, 0, -0.13, 0.18, 0.10, 0.25, 0.12, 'dark'],
    [C, 0, 0.07, 0.56, 0.12, 0.20, 0.34, 'acc'],
    [C, 0, 0.27, -0.12, 0.065, 0.10, 0.28, 'dark'],
    [T, 0, 0.10, -1.03, 0.10, 0.10, 0.12, 'dark'],
  ],
  dmr: [
    [C, 0, 0.09, 0.02, 0.12, 0.20, 0.76, 'dark'],
    [T, 0, 0.10, -0.98, 0.055, 0.055, 0.96, 'metal'],
    [T, 0, 0.30, -0.16, 0.12, 0.12, 0.52, 'dark'],
    [C, 0, 0.21, -0.08, 0.06, 0.10, 0.26, 'acc'],
    [C, 0, -0.16, 0.00, 0.10, 0.24, 0.17, 'acc'],
    [C, 0, -0.12, 0.21, 0.09, 0.22, 0.11, 'dark'],
    [C, 0, 0.04, 0.58, 0.11, 0.18, 0.44, 'acc'],
    [T, 0, 0.10, -1.42, 0.08, 0.08, 0.13, 'dark'],
  ],
  revolver: [
    [C, 0, 0.07, -0.06, 0.11, 0.14, 0.36, 'dark'],
    [T, 0, 0.08, -0.36, 0.055, 0.055, 0.28, 'metal'],
    [T, 0, 0.04, 0.00, 0.15, 0.15, 0.23, 'acc'],
    [C, 0, -0.15, 0.13, 0.11, 0.27, 0.14, 'acc'],
    [C, 0, -0.04, 0.08, 0.035, 0.08, 0.10, 'dark'],
    [C, 0, 0.18, -0.09, 0.045, 0.05, 0.15, 'dark'],
  ],
  pickaxe: [
    [C, 0, -0.10, 0.00, 0.06, 1.10, 0.06, 'wood'],   // handle, along Y
    [C, 0, 0.50, 0.00, 0.07, 0.11, 0.62, 'metal'],   // head
    [C, 0, 0.50, -0.40, 0.05, 0.08, 0.22, 'acc'],    // pick tip
    [C, 0, 0.50, 0.36, 0.09, 0.14, 0.12, 'acc'],     // hammer end
  ],
};

// base = 4x4 rigid transform (rotation + translation, uniform scale allowed);
// every part is placed relative to it.
function drawGunXf(id, base, acc, scale) {
  const m = _gm2, sc = scale || 1;
  const gd = GUN_GLTF[id], mdl = gd && Assets.get(gd.model);
  let parts = GUN_MODEL[id];
  if (mdl) {
    // model matrix = base · pre-rotation · scale (columns of `pre` are the model
    // axes expressed in gun space)
    const P = gd.pre || GUN_FLIP, s = sc * gd.k;
    for (let c = 0; c < 3; c++) {
      const px = P[c * 3], py = P[c * 3 + 1], pz = P[c * 3 + 2];
      m[c * 4] = (base[0] * px + base[4] * py + base[8] * pz) * s;
      m[c * 4 + 1] = (base[1] * px + base[5] * py + base[9] * pz) * s;
      m[c * 4 + 2] = (base[2] * px + base[6] * py + base[10] * pz) * s;
      m[c * 4 + 3] = 0;
    }
    m[12] = base[12]; m[13] = base[13]; m[14] = base[14]; m[15] = 1;
    R.pushModelXf(mdl, m, 1, 1, 1, 1);
    parts = gd.extra;
    if (!parts) return;
  }
  if (!parts) return;
  for (let i = 0; i < parts.length; i++) {
    const q = parts[i];
    const sx = q[4] * sc, sy = q[5] * sc, sz = q[6] * sc;
    m[0] = base[0] * sx; m[1] = base[1] * sx; m[2] = base[2] * sx; m[3] = 0;
    m[4] = base[4] * sy; m[5] = base[5] * sy; m[6] = base[6] * sy; m[7] = 0;
    m[8] = base[8] * sz; m[9] = base[9] * sz; m[10] = base[10] * sz; m[11] = 0;
    const dx = q[1] * sc, dy = q[2] * sc, dz = q[3] * sc;
    m[12] = base[12] + base[0] * dx + base[4] * dy + base[8] * dz;
    m[13] = base[13] + base[1] * dx + base[5] * dy + base[9] * dz;
    m[14] = base[14] + base[2] * dx + base[6] * dy + base[10] * dz;
    m[15] = 1;
    const col = q[7] === 'acc' ? acc : q[7] === 'metal' ? COL_GUN_METAL : q[7] === 'wood' ? COL_WOOD_DARK : COL_GUN_DARK;
    R.pushXf(q[0], m, col[0], col[1], col[2], 1);
  }
}

// Rigid transform from position + yaw + pitch (same convention as Renderer.push).
function m4YawPitch(o, x, y, z, yaw, pitch, s) {
  const ca = Math.cos(yaw), sa = Math.sin(yaw), cb = Math.cos(pitch), sb = Math.sin(pitch);
  o[0] = ca * s; o[1] = 0; o[2] = -sa * s; o[3] = 0;
  o[4] = sa * sb * s; o[5] = cb * s; o[6] = ca * sb * s; o[7] = 0;
  o[8] = sa * cb * s; o[9] = -sb * s; o[10] = ca * cb * s; o[11] = 0;
  o[12] = x; o[13] = y; o[14] = z; o[15] = 1;
  return o;
}
function drawGun(id, x, y, z, yaw, pitch, scale, acc) {
  drawGunXf(id, m4YawPitch(_gm, x, y, z, yaw, pitch, 1), acc, scale);
}

function quatEuler(rx, ry, rz) {   // X then Y then Z
  const cx = Math.cos(rx / 2), sx = Math.sin(rx / 2), cy = Math.cos(ry / 2), sy = Math.sin(ry / 2), cz = Math.cos(rz / 2), sz = Math.sin(rz / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

/* ---------------------------------- loot ----------------------------------- */

const LOOT_SHAPE = {
  ammo: [0.60, 0.44, 0.60],   // a squat crate
  mats: [0.50, 0.50, 0.50],   // a cube
  shield: [0.46, 0.90, 0.46],
  medkit: [0.70, 0.52, 0.70],
};

function drawLoot(l) {
  const col = lootColor(l);
  // only settled loot bobs; airborne loot tumbles where the physics put it
  const bob = l.rest ? Math.sin(G.t * 2.5 + l.spin) * 0.10 : 0;
  const s = 1 + l.pop * 0.5;                       // little pop as it spawns
  const spin = l.rest ? G.t * 1.2 + l.spin : G.t * 7 + l.spin;
  const y = l.y + 0.45 + bob;
  if (l.kind === 'weapon') {
    drawGun(l.data.item.id, l.x, y, l.z, spin, l.rest ? 0.0 : G.t * 4, 0.85 * s, col);
  } else if (l.kind === 'ammo') {
    const m = Assets.get('pickup_bullets');
    if (m) R.pushModel(m, l.x, y - 0.22, l.z, spin, 0.5 * s, 1, 1, 1, 1);
    else R.push(ITEM_MESH.ammo, l.x, y, l.z, spin, l.rest ? 0 : G.t * 4, 0.55 * s, 0.4 * s, 0.55 * s, col[0], col[1], col[2], 1);
  } else if (l.kind === 'medkit') {
    const m = Assets.get('pickup_health');
    if (m) R.pushModel(m, l.x, y - 0.25, l.z, spin, 0.55 * s, 1, 1, 1, 1);
    else R.push(ITEM_MESH.medkit, l.x, y, l.z, spin, l.rest ? 0 : G.t * 4, 0.62 * s, 0.42 * s, 0.62 * s, 1, 1, 1, 1);
  } else if (l.kind === 'shield') {
    const m = Assets.get('bottle_a');
    if (m) R.pushModel(m, l.x, y - 0.3, l.z, spin, 0.9 * s, 0.55, 0.9, 1.9, 1);
    else R.push(MESH_CONE, l.x, y, l.z, spin, 0, 0.45 * s, 0.9 * s, 0.45 * s, col[0], col[1], col[2], 1);
    R.push(MESH_SPHERE, l.x, y + 0.2, l.z, 0, 0, 1.1, 1.1, 1.1, 0.35, 0.6, 1.0, 0.12);
  } else if (l.kind === 'mats') {
    const m = Assets.get(l.data.mat === MAT_WOOD ? 'lumber' : l.data.mat === MAT_BRICK ? 'stone' : null);
    if (m) R.pushModel(m, l.x, y - 0.3, l.z, spin, 0.8 * s, 1, 1, 1, 1);
    else {
      // metal: a little stack of bars
      for (let i = 0; i < 3; i++) R.push(MESH_CUBE, l.x, y - 0.2 + i * 0.16, l.z, spin + i * 0.3, 0, 0.7 * s, 0.14 * s, 0.22 * s, col[0], col[1], col[2], 1);
    }
  }
  // rarity beacon + ground disc
  R.box(l.x, l.y + 2.0, l.z, 0.45, 3.6, 0.45, col, 0, 0.14);
  R.push(MESH_CYL, l.x, l.y + 0.03, l.z, 0, 0, 0.7, 0.05, 0.7, col[0], col[1], col[2], 0.35);
}

/* ------------------------------- characters -------------------------------- */

// Start (or restart) an upper-body one-shot: a gunshot, a swing, a reload…
function playUpper(e, name, dur) {
  e.upper = { name, t: 0, dur: dur || 0.4 };
  e.upSeq = (e.upSeq | 0) + 1;      // remote copies replay one-shots when this changes
  e.upName = name; e.upDur = dur || 0.4;
}

const _maskCache = new Map();
function upperMask(rig) {
  let m = _maskCache.get(rig);
  if (!m) { m = rigMask(rig, 'spine'); _maskCache.set(rig, m); }
  return m;
}

// Which clips a character plays this frame, from what it is doing.
function updateAnim(e, dt) {
  if (!e.anim) {
    const m = Assets.get(e.skin);
    if (!m || !m.skinned) return;
    e.anim = new Animator(m.rig);
    e.anim.play('Idle', 0, true);
  }
  const a = e.anim;
  if (!e.alive) { a.update(dt); return; }
  const vx = e.vel[0], vz = e.vel[2];
  const speed = len2(vx, vz);
  const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw), rx = Math.cos(e.yaw), rz = -Math.sin(e.yaw);
  const vf = vx * fx + vz * fz, vr = vx * rx + vz * rz;
  const it = curItem(e);
  const gun = it && WEAPONS[it.id] && WEAPONS[it.id].ammo ? it.id : null;
  let name, loop = true, spd = 1;
  if (G.state === 'drop' && !e.landed && e !== G.player || (G.state === 'drop' && e === G.player)) {
    name = e.glide ? 'Jump_Idle' : 'Jump_Idle';
  } else if (!e.grounded) {
    name = e.vel[1] > 2 ? 'Jump_Start' : 'Jump_Idle';
    loop = name === 'Jump_Idle';
  } else if (speed > 1.0) {
    if (Math.abs(vr) > Math.abs(vf) * 1.2 && speed > 3) name = vr > 0 ? 'Running_Strafe_Right' : 'Running_Strafe_Left';
    else if (vf < -0.5) name = 'Walking_Backwards';
    else name = speed > 8.5 ? 'Running_A' : speed > 4.5 ? 'Running_A' : 'Walking_A';
    spd = name === 'Walking_A' || name === 'Walking_Backwards' ? clamp(speed / 3.2, 0.7, 1.6) : clamp(speed / 7.0, 0.7, 1.7);
  } else name = gun && !e.buildMode ? 'Idle' : 'Idle';
  a.speed = spd;
  a.play(name, 0.12, loop);
  a.update(dt);
  if (e.upper) { e.upper.t += dt; if (e.upper.t >= e.upper.dur) e.upper = null; }
}

function drawChar(e) {
  const mdl = Assets.get(e.skin);
  if (!mdl || !mdl.skinned || !e.anim) { drawCharBoxes(e); return; }
  const a = e.anim, rig = a.rig;
  const it = curItem(e);
  const gun = it && WEAPONS[it.id] && WEAPONS[it.id].ammo ? it.id : null;
  // upper-body layer: the held weapon's pose, or a one-shot on top of it
  let upper = null;
  if (e.alive) {
    if (e.upper) upper = { name: e.upper.name, time: e.upper.t, weight: 1, mask: upperMask(rig), loop: false };
    else if (gun && !e.buildMode) upper = { name: gun === 'pistol' ? '1H_Ranged_Aiming' : '2H_Ranged_Aiming', time: G.t * 0.5 + e.animPhase, weight: 1, mask: upperMask(rig), loop: true };
  }
  const pose = a.evalPose(upper);
  // bend the chest toward the aim pitch (and the head a little more)
  if (e.alive && (gun || e.buildMode || e.slot === 0)) {
    const chest = rig.names.chest, head = rig.names.head;
    const ang = (e.pitch + 0.06 * e.gunKick * gunPunch(it)) * PITCH_K;   // a shot rocks the chest back
    if (chest !== undefined) poseRotateLocal(pose, chest, Math.sin(ang * 0.5), 0, 0, Math.cos(ang * 0.5));
    if (head !== undefined) poseRotateLocal(pose, head, Math.sin(ang * 0.25), 0, 0, Math.cos(ang * 0.25));
  }
  const joints = a.finish();
  const sc = CHAR_HEIGHT / mdl.h;
  const x = e.pos[0], y = e.pos[1] - mdl.by * sc, z = e.pos[2];
  m4Place(e.xf, x, y, z, e.yaw + CHAR_YAW, sc);
  const hurt = e.hurtT > 0;
  const t = hurt ? COL_HURT_TEX : COL_WHITE;
  R.pushSkinned(mdl, e.xf, joints, t[0], t[1], t[2], 1);

  // held item, glued to the right hand slot
  if (e.alive) {
    const hs = rig.names['handslot.r'];
    if (hs !== undefined && !e.buildMode && it) {
      m4Mul(_gm, e.xf, a.nodeWorld(hs));
      const grip = gunGrip(it.id);
      // recoil jolt: the muzzle rises and the gun is shoved back along its barrel (+Z in gun space)
      const punch = e.gunKick * gunPunch(it), back = 0.07 * punch;
      m4YawPitch(_gm3, 0, 0, 0, e.yaw, it.id === 'pickaxe' ? 0 : -e.pitch - 0.10 * punch, 1);
      const gs = GUN_SCALE;
      _gm3[12] = _gm[12] - (_gm3[0] * grip[0] + _gm3[4] * grip[1] + _gm3[8] * grip[2]) * gs + _gm3[8] * back;
      _gm3[13] = _gm[13] - (_gm3[1] * grip[0] + _gm3[5] * grip[1] + _gm3[9] * grip[2]) * gs + _gm3[9] * back;
      _gm3[14] = _gm[14] - (_gm3[2] * grip[0] + _gm3[6] * grip[1] + _gm3[10] * grip[2]) * gs + _gm3[10] * back;
      drawGunXf(it.id, _gm3, it.id === 'pickaxe' ? COL_GUN_METAL : RARITY[it.rar].col, gs);
      if (e.muzzleT > 0 && gun) {
        const mz = gunMuzzle(it.id) * gs;   // muzzle along the gun's -Z
        const mx = _gm3[12] + _gm3[8] * mz, my = _gm3[13] + _gm3[9] * mz, mzz = _gm3[14] + _gm3[10] * mz;
        R.push(MESH_SPHERE, mx, my, mzz, 0, 0, 0.5, 0.5, 0.5, 1.0, 0.85, 0.4, 0.85);
      }
    } else if (e.buildMode) {
      const rx = Math.cos(e.yaw), rz = -Math.sin(e.yaw), fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
      R.push(PIECE_MESH[e.buildMat].cube, x + rx * 0.4 + fx * 0.5, e.pos[1] + 1.2, z + rz * 0.4 + fz * 0.5, e.yaw, 0, 0.3, 0.3, 0.3, 1, 1, 1, 1);
    }
  }
  if (e.glide) drawGlider(e);
}

// Fallback figure while a character file is still loading (or missing).
function drawCharBoxes(e) {
  const x = e.pos[0], y = e.pos[1], z = e.pos[2], yaw = e.yaw;
  const hurt = e.hurtT > 0;
  const body = hurt ? COL_HURT : e.color;
  _dark[0] = body[0] * 0.55; _dark[1] = body[1] * 0.55; _dark[2] = body[2] * 0.55;
  const dark = _dark;
  R.box(x, y + 0.42, z, 0.5, 0.84, 0.34, dark, yaw);
  R.box(x, y + 1.14, z, 0.72, 0.72, 0.42, body, yaw);
  R.box(x, y + 1.68, z, 0.44, 0.44, 0.44, COL_SKIN, yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw), fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const it = curItem(e);
  if (it && e.alive) drawGun(it.id, x + rx * 0.36 + fx * 0.8, y + 1.28, z + rz * 0.36 + fz * 0.8, yaw, -e.pitch, 0.9, it.id === 'pickaxe' ? COL_GUN_METAL : RARITY[it.rar].col);
  if (e.glide) drawGlider(e);
}

function drawGlider(e) {
  const x = e.pos[0], y = e.pos[1], z = e.pos[2];
  R.push(MESH_SPHERE, x, y + 3.0, z, e.yaw, 0, 3.6, 1.1, 3.6, COL_GLIDER[0], COL_GLIDER[1], COL_GLIDER[2], 1);
  R.push(MESH_SPHERE, x, y + 2.98, z, e.yaw, 0, 3.7, 0.5, 3.7, 0.25, 0.55, 0.95, 1);
  R.box(x, y + 2.4, z, 0.1, 1.0, 0.1, COL_GLIDER_POLE, e.yaw);
  for (const [dx, dz] of [[1.4, 1.4], [-1.4, 1.4], [1.4, -1.4], [-1.4, -1.4]]) {
    R.line(x, y + 1.6, z, x + dx, y + 2.9, z + dz, 0.03, COL_GLIDER_POLE, 1);
  }
}

// In first person the body is hidden; the held gun floats at the bottom right
// of the view, pitching with the camera.
function drawFirstPersonGun(p, cam) {
  const it = curItem(p);
  if (!it || p.buildMode) return;
  const d = dirFrom(p.yaw, p.pitch, _av);
  const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
  const ux = -d[1] * d[0], uy = Math.cos(p.pitch), uz = -d[1] * d[2];
  // a shot shoves the gun back along the aim, hops it up and lifts the muzzle; it
  // springs back as gunKick decays (the aim itself is moved by updateRecoil)
  const punch = p.gunKick * gunPunch(it);
  const fwd = 0.55 - 0.06 * punch, up = 0.26 - 0.018 * punch, rise = 0.14 * punch;
  const x = cam.x + d[0] * fwd + rx * 0.30 - ux * up, y = cam.y + d[1] * fwd - uy * up, z = cam.z + d[2] * fwd + rz * 0.30 - uz * up;
  drawGun(it.id, x, y, z, p.yaw, -p.pitch - rise, 0.75, it.id === 'pickaxe' ? COL_GUN_METAL : RARITY[it.rar].col);
}

function drawBus(b) {
  const yaw = Math.atan2(-b.dx, -b.dz);
  const x = b.x, y = b.y, z = b.z;
  R.push(ITEM_MESH.bus, x, y, z, yaw, 0, 4.0, 3.2, 12, 1, 1, 1, 1);          // body
  R.push(MESH_CUBE, x, y + 1.7, z, yaw, 0, 3.6, 0.3, 11.5, 0.9, 0.92, 0.96, 1);  // roof
  for (const [dx, dz] of [[1.9, 4], [-1.9, 4], [1.9, -4], [-1.9, -4]]) {
    const wx = x + Math.cos(yaw) * dx - Math.sin(yaw) * dz, wz = z - Math.sin(yaw) * dx - Math.cos(yaw) * dz;
    R.push(MESH_TUBE, wx, y - 1.5, wz, yaw + Math.PI / 2, 0, 1.3, 1.3, 0.5, 0.1, 0.1, 0.12, 1);
  }
  R.push(MESH_SPHERE, x, y + 11, z, 0, 0, 9.5, 9.5, 9.5, COL_BALLOON[0], COL_BALLOON[1], COL_BALLOON[2], 1);
  R.push(MESH_SPHERE, x, y + 11, z, 0, 0, 9.8, 6.0, 9.8, 0.95, 0.55, 0.2, 1);
  for (const [dx, dz] of [[1.5, 4], [-1.5, 4], [1.5, -4], [-1.5, -4]]) {
    const wx = x + Math.cos(yaw) * dx - Math.sin(yaw) * dz, wz = z - Math.sin(yaw) * dx - Math.cos(yaw) * dz;
    R.line(wx, y + 1.8, wz, x + (wx - x) * 0.4, y + 7, z + (wz - z) * 0.4, 0.05, COL_GLIDER_POLE, 1);
  }
  R.push(MESH_SPHERE, x, y + 4.5, z, 0, 0, 1.6, 1.6, 1.6, 1.0, 0.7, 0.3, 0.9);   // burner
}

/* ----------------------------------- HUD ----------------------------------- */

function drawHUD() {
  // Work in a virtual 1400-wide-ish space so the HUD never collides with itself
  // on small windows.
  const S = clamp(hudCv.width / 1400, 0.5, 1.15);
  hud.setTransform(S, 0, 0, S, 0, 0);
  const W = hudCv.width / S, H = hudCv.height / S;
  hud.clearRect(0, 0, W, H);
  if (window.__AUTO) hud.drawImage(R.canvas, 0, 0, W, H);   // screenshot mode: composite the GL frame ourselves
  hud.textBaseline = 'middle';
  const p = G.player;
  if (G.state === 'menu') return;

  // with the GL post pass off (low quality / no targets) these are painted here instead
  if (!R.postActive) {
    drawVignette(W, H);
    if (G.hurtFlash > 0) {
      hud.fillStyle = `rgba(200,20,20,${G.hurtFlash * 0.35})`;
      hud.fillRect(0, 0, W, H);
    }
  }
  if (G.showPerf) drawPerf(W, H);

  if (G.state === 'drop' || G.state === 'play' || G.state === 'dead' || G.state === 'win') {
    drawTopRight(W, H);
    drawCompass(W, H);
    drawFeed(W, H);
    if (p.alive) { drawBars(W, H); drawSlots(W, H); drawMats(W, H); drawCrosshair(W, H); drawTargetInfo(W, H); }
    if (G.state === 'play') drawLootLabels();
    if (Net.inMatch) drawNameTags();
    drawDamageNumbers(W, H);
    if (G.spec && !p.alive) {
      hud.font = '700 15px system-ui, sans-serif'; hud.textAlign = 'center'; hud.fillStyle = 'rgba(255,255,255,.85)';
      hud.fillText('SPECTATING  ' + G.spec.name.toUpperCase() + '   ·   click to switch   ·   Esc twice for the menu', W / 2, H - 40);
    }
    if (G.msgT > 0) {
      hud.globalAlpha = clamp(G.msgT, 0, 1);
      hud.font = '800 24px system-ui, sans-serif';
      hud.textAlign = 'center';
      hud.fillStyle = '#fff'; hud.strokeStyle = 'rgba(0,0,0,.65)'; hud.lineWidth = 5;
      hud.strokeText(G.msg, W / 2, H * 0.18);
      hud.fillText(G.msg, W / 2, H * 0.18);
      hud.globalAlpha = 1;
    }
    if (G.elimFlash > 0) drawElimBanner(W, H);
    if (p.alive && G.hurtDirs.length) drawHurtDirs(W, H);
  }

  if (G.state === 'drop') {
    hud.font = '700 16px system-ui, sans-serif'; hud.textAlign = 'center'; hud.fillStyle = '#fff';
    const how = Input.padActive ? 'push the left stick to dive and steer' : 'W to dive, mouse to steer';
    hud.fillText(p.pos[1] - terrainHeight(p.pos[0], p.pos[2]) > 45 ? 'FREEFALL — ' + how : 'GLIDING', W / 2, H - 150);
  }
  if (Input.padActive) {
    hud.font = '700 11px system-ui, sans-serif'; hud.textAlign = 'right';
    hud.fillStyle = 'rgba(255,255,255,.42)';
    hud.fillText('GAMEPAD · BUILDER PRO', W - 26, H - 20);
  }
  if (!Input.locked && !Input.padActive && !window.__NOLOCK && (G.state === 'play' || G.state === 'drop')) {
    hud.fillStyle = 'rgba(0,0,0,.55)'; hud.fillRect(0, 0, W, H);
    hud.font = '700 26px system-ui, sans-serif'; hud.textAlign = 'center'; hud.fillStyle = '#fff';
    hud.fillText('CLICK TO RESUME', W / 2, H / 2);
  }
}

// "ELIMINATED <name>" with the running count: punches in over the first tenth
// of a second, holds, then fades out.
function drawElimBanner(W, H) {
  const life = 1.7, age = life - G.elimFlash;
  const pop = 1 + 0.35 * Math.max(0, 1 - age / 0.12);
  hud.save();
  hud.globalAlpha = clamp(G.elimFlash * 1.6, 0, 1);
  hud.translate(W / 2, H * 0.27);
  hud.scale(pop, pop);
  hud.textAlign = 'center';
  hud.font = '900 34px system-ui, sans-serif';
  const title = 'ELIMINATED ' + (G.elimName || '').toUpperCase();
  const w = hud.measureText(title).width + 60;
  hud.fillStyle = 'rgba(0,0,0,.42)'; hud.fillRect(-w / 2, -26, w, 52);
  hud.fillStyle = '#ffd24a'; hud.fillRect(-w / 2, 24, w, 3);
  hud.fillStyle = '#ffdd55'; hud.strokeStyle = 'rgba(0,0,0,.6)'; hud.lineWidth = 5;
  hud.strokeText(title, 0, -2); hud.fillText(title, 0, -2);
  hud.font = '700 13px system-ui, sans-serif'; hud.fillStyle = 'rgba(255,255,255,.85)';
  const k = G.player.kills;
  hud.fillText(k + ' ELIMINATION' + (k === 1 ? '' : 'S'), 0, 40);
  hud.restore();
}

// Red arcs around the crosshair pointing at whoever hit you, fading over a second.
function drawHurtDirs(W, H) {
  const p = G.player, cx = W / 2, cy = H / 2, r = 92;
  hud.lineCap = 'round';
  for (const h of G.hurtDirs) {
    // yaw grows turning left, so a positive delta is an attacker on the left;
    // the canvas rotates clockwise, hence the sign flip
    const a = -angleDelta(p.yaw, Math.atan2(-(h.x - p.pos[0]), -(h.z - p.pos[2])));
    hud.save();
    hud.translate(cx, cy); hud.rotate(a);
    hud.globalAlpha = clamp(h.t, 0, 1) * 0.9;
    hud.strokeStyle = 'rgba(0,0,0,.5)'; hud.lineWidth = 10;
    hud.beginPath(); hud.arc(0, 0, r, -Math.PI / 2 - 0.4, -Math.PI / 2 + 0.4); hud.stroke();
    hud.strokeStyle = '#ff4040'; hud.lineWidth = 6;
    hud.beginPath(); hud.arc(0, 0, r, -Math.PI / 2 - 0.4, -Math.PI / 2 + 0.4); hud.stroke();
    hud.restore();
  }
  hud.lineCap = 'butt';
  hud.globalAlpha = 1;
}

// Frame-time readout (Settings → show performance, or FN.perf(true)): frame
// and render milliseconds as running averages, draw calls and instances.
function drawPerf(W, H) {
  const q = G.perf;
  if (!q) return;
  hud.font = '600 11px ui-monospace, Consolas, monospace'; hud.textAlign = 'left';
  hud.fillStyle = 'rgba(0,0,0,.5)'; hud.fillRect(18, H * 0.5 - 12, 214, 60);
  hud.fillStyle = '#9f9';
  hud.fillText('frame ' + q.frame.toFixed(1) + ' ms  (' + (1000 / Math.max(0.1, q.frame)).toFixed(0) + ' fps)', 24, H * 0.5);
  hud.fillText('render ' + q.render.toFixed(1) + ' ms   sim ' + q.sim.toFixed(1) + ' ms', 24, H * 0.5 + 16);
  hud.fillText('draws ' + R.drawCalls + '   inst ' + R.instances + '   ' + (R.postActive ? (R.post.msaa ? 'msaa' + R.post.samples : 'fxaa') : 'direct'), 24, H * 0.5 + 32);
}

let _vig = null, _vigKey = '';
function drawVignette(W, H) {
  const inStormNow = G.storm && G.player && inStorm(G.player.pos[0], G.player.pos[2]) && G.state === 'play';
  const key = W + 'x' + H + (inStormNow ? 's' : '');
  if (key !== _vigKey) {
    _vig = hud.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.75);
    _vig.addColorStop(0, 'rgba(0,0,0,0)');
    _vig.addColorStop(1, inStormNow ? 'rgba(90,20,150,.55)' : 'rgba(0,0,0,.32)');
    _vigKey = key;
  }
  hud.fillStyle = _vig;
  hud.fillRect(0, 0, W, H);
}

function bar(x, y, w, h, k, col, bg) {
  hud.fillStyle = bg || 'rgba(0,0,0,.55)';
  hud.fillRect(x, y, w, h);
  hud.fillStyle = col;
  hud.fillRect(x + 2, y + 2, Math.max(0, (w - 4) * clamp(k, 0, 1)), h - 4);
  hud.strokeStyle = 'rgba(255,255,255,.35)'; hud.lineWidth = 1.5;
  hud.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function drawBars(W, H) {
  const p = G.player, x = 26, w = 300, h = 20;
  let y = H - 152;   // sits above the hotbar, never under it
  bar(x, y, w, h, p.shield / 100, '#3fb8ff');
  y += h + 4;
  bar(x, y, w, h, p.hp / 100, p.hp > 50 ? '#5ee06a' : '#e05e5e');
  hud.font = '800 15px system-ui, sans-serif'; hud.textAlign = 'left'; hud.fillStyle = '#fff';
  hud.fillText(Math.ceil(p.shield) + '', x + w + 10, y - h / 2 - 2);
  hud.fillText(Math.ceil(p.hp) + '', x + w + 10, y + h / 2);
  if (p.useT > 0) {
    bar(W / 2 - 110, H - 200, 220, 14, 1 - p.useT / (p.useKind === 'shield' ? 2.2 : 3.6), '#ffffff');
    hud.textAlign = 'center'; hud.fillStyle = '#fff';
    hud.fillText('USING ' + p.useKind.toUpperCase(), W / 2, H - 215);
  }
}

// Small vector icons for the hotbar. Side view, barrel to the right.
function drawItemIcon(id, x, y, w, h, col) {
  hud.save();
  hud.translate(x, y);
  hud.fillStyle = col;
  const u = w / 20, v = h / 12;
  const rect = (a, b, c, d) => hud.fillRect(a * u, b * v, c * u, d * v);
  if (id === 'pickaxe') { hud.strokeStyle = col; hud.lineWidth = 2; hud.beginPath(); hud.moveTo(3 * u, 11 * v); hud.lineTo(15 * u, 2 * v); hud.stroke(); rect(11, 0, 9, 2.4); rect(16, 0, 2.4, 6); }
  else if (id === 'pistol') { rect(4, 3, 12, 3); rect(5, 6, 3.5, 5); rect(15, 3.6, 4, 1.8); }
  else if (id === 'smg') { rect(3, 4, 12, 3); rect(6, 7, 3, 4.5); rect(15, 4.4, 4, 1.6); rect(1, 4.4, 2.5, 2); rect(10, 2.5, 3, 1.5); }
  else if (id === 'tacsmg') { rect(2, 4, 13, 3); rect(6, 7, 3, 4.5); rect(15, 4.7, 5, 1.4); rect(0, 4.5, 2, 2); rect(10, 2.5, 4, 1.5); }
  else if (id === 'ar') { rect(4, 4, 11, 3); rect(9, 7, 2.6, 4); rect(15, 4.6, 5, 1.6); rect(0, 4.5, 4, 2.2); rect(8, 2.6, 4, 1.4); }
  else if (id === 'heavyAR') { rect(3, 4, 12, 3.2); rect(9, 7, 3.2, 4.5); rect(15, 4.7, 5, 1.8); rect(0, 4.7, 3, 2.3); rect(8, 2.3, 5, 1.7); }
  else if (id === 'shotgun' || id === 'autoShotgun') { rect(4, 4.5, 10, 2.6); rect(14, 4.6, 6, 2); rect(0, 4.8, 4, 2.6); rect(11, 7, 3, 1.6); if (id === 'autoShotgun') rect(7, 7, 4, 3); }
  else if (id === 'sniper' || id === 'dmr') { rect(3, 5, 10, 2.4); rect(13, 5.4, 7, 1.4); rect(0, 5.2, 3, 2.2); rect(7, 2.6, 5, 1.8); rect(6, 7.4, 2, 3); }
  else if (id === 'revolver') { rect(4, 4, 11, 2.5); rect(8, 6, 4, 3); rect(3, 4.2, 3, 2); rect(15, 4.4, 5, 1.4); rect(6, 7, 3, 4); }
  else if (id === 'shield') { rect(8, 4, 4, 7); rect(8.8, 1.5, 2.4, 2.8); hud.fillStyle = '#fff'; rect(8.8, 6, 1, 3); }
  else if (id === 'medkit') { rect(4, 3, 12, 8); hud.fillStyle = '#e33'; rect(9, 4, 2, 6); rect(6.5, 6, 7, 2); }
  hud.restore();
}

function drawSlots(W, H) {
  const p = G.player;
  const sw = 84, sh = 58, gap = 6;
  const total = 5 * sw + 4 * gap;
  const x0 = W / 2 - total / 2, y = H - 78;
  for (let i = 0; i < 5; i++) {
    const x = x0 + i * (sw + gap);
    const it = p.inv[i];
    const sel = i === p.slot && !p.buildMode;
    hud.fillStyle = sel ? 'rgba(255,255,255,.28)' : 'rgba(0,0,0,.5)';
    hud.fillRect(x, y, sw, sh);
    hud.strokeStyle = sel ? '#fff' : 'rgba(255,255,255,.25)';
    hud.lineWidth = 2; hud.strokeRect(x, y, sw, sh);
    hud.textAlign = 'center';
    if (it) {
      const c = RARITY[it.rar].col;
      const css = `rgb(${c[0] * 255 | 0},${c[1] * 255 | 0},${c[2] * 255 | 0})`;
      hud.fillStyle = css;
      hud.fillRect(x + 2, y + sh - 6, sw - 4, 4);
      drawItemIcon(it.id, x + sw / 2 - 20, y + 6, 40, 24, it.id === 'pickaxe' ? '#ddd' : css);
      hud.fillStyle = '#fff'; hud.font = '700 10px system-ui, sans-serif';
      const nm = it.id === 'pickaxe' ? 'PICKAXE' : it.id === 'shield' ? 'SHIELD' : it.id === 'medkit' ? 'MEDKIT'
        : WEAPONS[it.id].name.toUpperCase();
      if (WEAPONS[it.id] && WEAPONS[it.id].ammo) {
        hud.font = '800 14px system-ui, sans-serif';
        hud.fillText(it.mag + ' / ' + p.ammo[WEAPONS[it.id].ammo], x + sw / 2, y + 42);
      } else hud.fillText(nm.slice(0, 12), x + sw / 2, y + 42);
    }
    hud.fillStyle = 'rgba(255,255,255,.6)'; hud.font = '700 10px system-ui, sans-serif';
    hud.textAlign = 'left'; hud.fillText(i + 1, x + 5, y + 9);
    // drop hint on the held slot
    if (i === p.slot && i > 0 && it && !p.buildMode) {
      hud.fillStyle = 'rgba(255,255,255,.55)'; hud.font = '700 10px system-ui, sans-serif';
      hud.textAlign = 'center'; hud.fillText('[G] DROP', x + sw / 2, y + sh + 11);
    }
  }
  const held = curItem(p), heldW = held && WEAPONS[held.id];
  if (p.reloadT > 0 && heldW && heldW.reload) {
    bar(W / 2 - 90, y - 26, 180, 12, 1 - p.reloadT / heldW.reload, '#ffcc44');
    hud.textAlign = 'center'; hud.fillStyle = '#fff'; hud.font = '700 12px system-ui, sans-serif';
    hud.fillText('RELOADING', W / 2, y - 36);
  }
  // build bar
  if (p.buildMode) {
    const bw = 74, by = y - 104;
    const bx0 = W / 2 - (4 * bw + 3 * gap) / 2;
    const labels = ['WALL [Z]', 'FLOOR [X]', 'RAMP [C]', 'CONE [V]'];
    for (let i = 0; i < 4; i++) {
      const x = bx0 + i * (bw + gap);
      hud.fillStyle = i === p.buildType ? 'rgba(90,200,255,.45)' : 'rgba(0,0,0,.5)';
      hud.fillRect(x, by, bw, 46);
      hud.strokeStyle = i === p.buildType ? '#7fd8ff' : 'rgba(255,255,255,.25)';
      hud.lineWidth = 2; hud.strokeRect(x, by, bw, 46);
      // piece glyph
      hud.fillStyle = i === p.buildType ? '#fff' : 'rgba(255,255,255,.7)';
      const gx = x + bw / 2, gy = by + 14;
      if (i === 0) hud.fillRect(gx - 9, gy - 8, 18, 14);
      else if (i === 1) hud.fillRect(gx - 12, gy + 1, 24, 5);
      else if (i === 2) { hud.beginPath(); hud.moveTo(gx - 12, gy + 7); hud.lineTo(gx + 12, gy - 8); hud.lineTo(gx + 12, gy + 7); hud.closePath(); hud.fill(); }
      else { hud.beginPath(); hud.moveTo(gx - 13, gy + 7); hud.lineTo(gx, gy - 8); hud.lineTo(gx + 13, gy + 7); hud.closePath(); hud.fill(); }
      hud.font = '700 10px system-ui, sans-serif'; hud.textAlign = 'center';
      hud.fillText(labels[i], x + bw / 2, by + 35);
    }
  }
}

function drawMats(W, H) {
  const p = G.player;
  const x = W - 200, y = H - 168;
  for (let i = 0; i < 3; i++) {
    const c = MAT_COLOR[i];
    const yy = y + i * 26;
    hud.fillStyle = `rgba(0,0,0,${i === p.buildMat ? 0.7 : 0.4})`;
    hud.fillRect(x, yy, 176, 24);
    hud.fillStyle = `rgb(${c[0] * 255 | 0},${c[1] * 255 | 0},${c[2] * 255 | 0})`;
    hud.fillRect(x + 4, yy + 4, 16, 16);
    hud.fillStyle = i === p.buildMat ? '#fff' : 'rgba(255,255,255,.6)';
    hud.font = '700 13px system-ui, sans-serif'; hud.textAlign = 'left';
    hud.fillText(MAT_NAME[i] + '  ' + p.mats[i], x + 28, yy + 13);
    if (i === p.buildMat) {
      hud.textAlign = 'right'; hud.fillText('[T]', x + 170, yy + 13);
    }
  }
}

function drawCrosshair(W, H) {
  const p = G.player;
  if (p.buildMode) {
    hud.fillStyle = 'rgba(255,255,255,.8)';
    hud.fillRect(W / 2 - 2, H / 2 - 2, 4, 4);
    return;
  }
  // The gap is the cone the next shot actually leaves through (shotSpread: base,
  // ADS, movement, bloom) projected through the live FOV, plus the recoil the view
  // has yet to recover and a pulse on each shot — so it opens on the move, closes
  // when you aim in, blooms while the trigger is held and settles as the gun does.
  const w = curWeapon(p);
  const cone = w ? shotSpread(p, w) : 0.02;
  const pxr = (H / 2) / Math.tan((p.fov === undefined ? FOV.base : p.fov) / 2);   // virtual px per radian at the centre
  const spread = clamp(cone * pxr + (Math.abs(p.rpT) + Math.abs(p.ryT)) * pxr * 0.5 + p.gunKick * 5, 4, 90);
  const cx = W / 2, cy = H / 2;
  hud.strokeStyle = 'rgba(255,255,255,.9)'; hud.lineWidth = 2;
  hud.beginPath();
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    hud.moveTo(cx + dx * spread, cy + dy * spread);
    hud.lineTo(cx + dx * (spread + 8), cy + dy * (spread + 8));
  }
  hud.stroke();
  hud.fillStyle = 'rgba(255,255,255,.9)';
  hud.fillRect(cx - 1, cy - 1, 2, 2);
  if (G.hitMark > 0) {
    hud.strokeStyle = G.critMark > 0 ? '#ffd24a' : '#fff';
    hud.lineWidth = 3; hud.beginPath();
    hud.moveTo(cx - 10, cy - 10); hud.lineTo(cx - 4, cy - 4);
    hud.moveTo(cx + 10, cy - 10); hud.lineTo(cx + 4, cy - 4);
    hud.moveTo(cx - 10, cy + 10); hud.lineTo(cx - 4, cy + 4);
    hud.moveTo(cx + 10, cy + 10); hud.lineTo(cx + 4, cy + 4);
    hud.stroke();
  }
}

// What the crosshair rests on: a build piece or prop shows its name and health
// (so you know what a wall has left before you push through it).
function drawTargetInfo(W, H) {
  const p = G.player;
  if (G.state !== 'play') return;
  const cam = cameraState(p);
  const d = dirFrom(p.yaw, p.pitch, _av);
  const hit = rayWorld(cam.x, cam.y, cam.z, d[0], d[1], d[2], 16);
  if (!hit || !hit.col.ref) return;
  const c = hit.col;
  let name, hp, max;
  if (c.kind === 'piece') { name = MAT_NAME[c.ref.mat].toUpperCase() + ' ' + c.ref.type.toUpperCase(); hp = c.ref.hp; max = c.ref.maxHp; }
  else if (c.kind === 'prop') { name = c.ref.kind.replace('_', ' ').toUpperCase(); hp = c.ref.hp; max = c.ref.maxHp; }
  else return;
  const w = 150, x = W / 2 - w / 2, y = H / 2 + 34;
  hud.fillStyle = 'rgba(0,0,0,.45)'; hud.fillRect(x, y, w, 30);
  hud.font = '700 11px system-ui, sans-serif'; hud.textAlign = 'center'; hud.fillStyle = 'rgba(255,255,255,.9)';
  hud.fillText(name, W / 2, y + 9);
  bar(x + 8, y + 17, w - 16, 8, hp / max, c.kind === 'piece' ? '#7fd8ff' : '#ffd24a', 'rgba(0,0,0,.4)');
}

function drawCompass(W, H) {
  const p = G.player;
  const cx = W / 2, y = 22, span = 260;
  hud.fillStyle = 'rgba(0,0,0,.35)'; hud.fillRect(cx - span / 2, y - 12, span, 26);
  const heading = -p.yaw;   // north is -Z
  hud.font = '700 11px system-ui, sans-serif'; hud.textAlign = 'center';
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    let d = angleDelta(heading, a);
    if (Math.abs(d) > 1.1) continue;
    const x = cx + d / 1.1 * (span / 2);
    const k = 1 - Math.abs(d) / 1.1;
    hud.fillStyle = `rgba(255,255,255,${0.35 + 0.65 * k})`;
    hud.fillText(labels[i], x, y + 1);
  }
  // nearest POI name under the compass
  let best = null, bd = 1e9;
  for (const q of World.pois) { const d = dist2(p.pos[0], p.pos[2], q.x, q.z); if (d < bd) { bd = d; best = q; } }
  if (best && bd < 90 * 90) {
    hud.fillStyle = 'rgba(255,255,255,.85)'; hud.font = '800 13px system-ui, sans-serif';
    hud.fillText(best.name.toUpperCase(), cx, y + 26);
  }
  hud.fillStyle = '#ffd24a'; hud.fillRect(cx - 1, y - 12, 2, 6);
}

// Terrain + roads + POIs painted once per match; the minimap just blits it.
function buildMinimap() {
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S), d = img.data;
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const x = -HALF + (i + 0.5) / S * 2 * HALF, z = -HALF + (j + 0.5) / S * 2 * HALF;
      const h = terrainHeight(x, z);
      const k = clamp((h - TERRAIN_MIN) / (TERRAIN_MAX - TERRAIN_MIN + 1), 0, 1);
      const slope = Math.abs(terrainHeight(x + 3, z) - h) + Math.abs(terrainHeight(x, z + 3) - h);
      let r = 60 + k * 70, g = 110 + k * 60, b = 55 + k * 30;
      if (slope > 1.6) { r = 110; g = 105; b = 95; }
      if (nearRoad(x, z, 4)) { r = 150; g = 130; b = 100; }
      const o = (j * S + i) * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  for (const q of World.pois) {
    const x = (q.x + HALF) / (2 * HALF) * S, z = (q.z + HALF) / (2 * HALF) * S;
    ctx.beginPath(); ctx.arc(x, z, 2.2, 0, Math.PI * 2); ctx.fill();
  }
  return c;
}

function drawTopRight(W, H) {
  const s = G.storm, p = G.player;
  const R2 = 84, cx = W - R2 - 30, cy = R2 + 34;
  hud.save();
  hud.beginPath(); hud.arc(cx, cy, R2, 0, Math.PI * 2); hud.clip();
  if (G.mini) hud.drawImage(G.mini, cx - R2, cy - R2, R2 * 2, R2 * 2);
  else { hud.fillStyle = '#2c4a2c'; hud.fillRect(cx - R2, cy - R2, R2 * 2, R2 * 2); }
  const k = R2 / HALF;
  // storm + next circle
  hud.fillStyle = 'rgba(150,60,230,.34)';
  hud.fillRect(cx - R2, cy - R2, R2 * 2, R2 * 2);
  hud.globalCompositeOperation = 'destination-out';
  hud.beginPath(); hud.arc(cx + s.cx * k, cy + s.cz * k, s.r * k, 0, Math.PI * 2); hud.fill();
  hud.globalCompositeOperation = 'source-over';
  if (G.mini) {
    hud.save(); hud.beginPath(); hud.arc(cx + s.cx * k, cy + s.cz * k, s.r * k, 0, Math.PI * 2); hud.clip();
    hud.drawImage(G.mini, cx - R2, cy - R2, R2 * 2, R2 * 2); hud.restore();
  }
  hud.strokeStyle = 'rgba(255,255,255,.85)'; hud.lineWidth = 1.5;
  hud.beginPath(); hud.arc(cx + s.tcx * k, cy + s.tcz * k, s.tr * k, 0, Math.PI * 2); hud.stroke();
  hud.strokeStyle = 'rgba(180,90,255,.9)'; hud.lineWidth = 2;
  hud.beginPath(); hud.arc(cx + s.cx * k, cy + s.cz * k, s.r * k, 0, Math.PI * 2); hud.stroke();
  // player arrow
  const px = cx + p.pos[0] * k, pz = cy + p.pos[2] * k;
  hud.save(); hud.translate(px, pz); hud.rotate(-p.yaw);
  hud.fillStyle = '#fff'; hud.strokeStyle = 'rgba(0,0,0,.6)'; hud.lineWidth = 1.5; hud.beginPath();
  hud.moveTo(0, -6); hud.lineTo(4.5, 5); hud.lineTo(-4.5, 5); hud.closePath(); hud.fill(); hud.stroke();
  hud.restore();
  hud.restore();
  hud.strokeStyle = 'rgba(255,255,255,.55)'; hud.lineWidth = 2;
  hud.beginPath(); hud.arc(cx, cy, R2, 0, Math.PI * 2); hud.stroke();

  hud.textAlign = 'right';
  hud.font = '800 20px system-ui, sans-serif'; hud.fillStyle = '#fff';
  hud.fillText(G.mode === 'rumble' ? ('BLUE  ' + G.teamScores[0] + '  —  ' + G.teamScores[1] + '  RED') : (G.alive + ' ALIVE'), W - 30, cy + R2 + 22);
  hud.font = '700 13px system-ui, sans-serif';
  hud.fillStyle = s.shrinking ? '#c98bff' : 'rgba(255,255,255,.75)';
  hud.fillText(stormLabel(s), W - 30, cy + R2 + 44);
  hud.fillStyle = 'rgba(255,255,255,.75)';
  hud.fillText('ELIMS  ' + G.player.kills, W - 30, cy + R2 + 64);
}

function drawFeed(W, H) {
  hud.textAlign = 'right'; hud.font = '600 13px system-ui, sans-serif';
  for (let i = 0; i < G.feed.length; i++) {
    const f = G.feed[i];
    hud.globalAlpha = clamp(f.t, 0, 1);
    hud.fillStyle = 'rgba(0,0,0,.45)';
    const text = f.a + '  ⚔  ' + f.b;
    const w = hud.measureText(text).width + 16;
    hud.fillRect(W - 30 - w, 300 + i * 24, w, 20);
    hud.fillStyle = f.a === G.player.name ? '#ffd24a' : '#fff';   // my own elims in gold, whatever my lobby name is
    hud.fillText(text, W - 38, 310 + i * 24);
  }
  hud.globalAlpha = 1;
}

/* -------------------------- loot identification ---------------------------- */

function lootColor(l) {
  return l.kind === 'weapon' ? RARITY[l.data.item.rar].col
    : l.kind === 'ammo' ? AMMO_COLOR[l.data.type]
      : l.kind === 'mats' ? MAT_COLOR[l.data.mat]
        : l.kind === 'shield' ? COL_SHIELD : COL_MEDKIT;
}

function lootName(l) {
  if (l.kind === 'weapon') return weaponLabel(l.data.item).toUpperCase();
  if (l.kind === 'ammo') return l.data.n + ' ' + l.data.type.toUpperCase();
  if (l.kind === 'mats') return l.data.n + ' ' + MAT_NAME[l.data.mat].toUpperCase();
  if (l.kind === 'shield') return 'SHIELD POTION';
  if (l.kind === 'medkit') return 'MEDKIT';
  return l.kind.toUpperCase();
}

const LABEL_RANGE = 26, LABEL_MAX = 10;

function drawLootLabels() {
  const p = G.player;
  if (!p.alive || p.buildMode) return;
  const near = [];
  for (const l of World.loot) {
    const d = dist2(p.pos[0], p.pos[2], l.x, l.z);
    if (d > LABEL_RANGE * LABEL_RANGE || Math.abs(l.y - p.pos[1]) > 8) continue;
    near.push({ l, d });
  }
  if (!near.length) return;
  near.sort((a, b) => a.d - b.d);
  near.length = Math.min(near.length, LABEL_MAX);

  hud.save();
  hud.setTransform(1, 0, 0, 1, 0, 0);
  const W = hudCv.width, H = hudCv.height, S = clamp(W / 1400, 0.5, 1.15);
  hud.textAlign = 'center';
  const grab = Input.padActive ? '[X]' : '[E]';
  const aimed = lookedAtLoot(p, PICKUP_RANGE);      // the one E / X would actually take
  const h = 20 * S, placed = [];
  for (let i = near.length - 1; i >= 0; i--) {          // nearest drawn last, on top
    const l = near[i].l;
    if (!projectPoint(R.vp, l.x, l.y + 1.15, l.z, W, H, _scr)) continue;
    const name = lootName(l);
    const c = lootColor(l);
    hud.font = '700 ' + (13 * S).toFixed(1) + 'px system-ui, sans-serif';
    const w = hud.measureText(name).width + 14 * S;
    // a pile of loot would stack every tag on the same pixel — lift until it's clear
    let x = _scr[0] - w / 2, y = _scr[1] - h / 2;
    for (let g = 0; g < 8; g++) {
      const clash = placed.some(r => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y);
      if (!clash) break;
      y -= h + 2 * S;
    }
    placed.push({ x, y, w, h });
    const isAimed = l === aimed;
    const fade = clamp(1 - Math.sqrt(near[i].d) / LABEL_RANGE, 0, 1);
    hud.globalAlpha = isAimed ? 1 : 0.4 + 0.6 * fade;
    hud.fillStyle = isAimed ? 'rgba(0,0,0,.85)' : 'rgba(0,0,0,.66)';
    hud.fillRect(x, y, w, h);
    hud.fillStyle = `rgb(${c[0] * 255 | 0},${c[1] * 255 | 0},${c[2] * 255 | 0})`;
    hud.fillRect(x, y + h - 2.5 * S, w, 2.5 * S);
    if (isAimed) { hud.strokeStyle = '#fff'; hud.lineWidth = 1.5 * S; hud.strokeRect(x, y, w, h); }
    hud.fillStyle = '#fff';
    hud.fillText(name, x + w / 2, y + h / 2);
    // prompt on the one you are pointing at — that is what E / X takes
    if (isAimed) {
      hud.font = '700 ' + (11 * S).toFixed(1) + 'px system-ui, sans-serif';
      hud.fillStyle = '#ffd24a';
      const full = l.kind !== 'ammo' && l.kind !== 'mats' && !p.inv.some((x2, i2) => i2 > 0 && !x2);
      hud.fillText(grab + ' ' + (full ? 'SWAP' : 'PICK UP'), x + w / 2, y - 9 * S);
    }
  }
  hud.globalAlpha = 1;
  hud.restore();
}

// The other humans' names float over their heads with a sliver of health, so
// friends can tell each other apart from the bots at a glance.
function drawNameTags() {
  const p = G.player;
  hud.save();
  hud.setTransform(1, 0, 0, 1, 0, 0);
  const W = hudCv.width, H = hudCv.height, S = clamp(W / 1400, 0.5, 1.15);
  hud.textAlign = 'center';
  for (const e of G.ents) {
    if (e === p || !e.human || !e.alive) continue;
    const d = dist2(p.pos[0], p.pos[2], e.pos[0], e.pos[2]);
    if (d > 90 * 90) continue;
    if (!projectPoint(R.vp, e.pos[0], e.pos[1] + 2.35, e.pos[2], W, H, _scr)) continue;
    const far = clamp(1 - Math.sqrt(d) / 90, 0.35, 1);
    hud.globalAlpha = far;
    hud.font = '700 ' + (13 * S).toFixed(1) + 'px system-ui, sans-serif';
    hud.fillStyle = '#fff'; hud.strokeStyle = 'rgba(0,0,0,.7)'; hud.lineWidth = 3;
    hud.strokeText(e.name, _scr[0], _scr[1]);
    hud.fillText(e.name, _scr[0], _scr[1]);
    const w = 44 * S, h = 4 * S, x = _scr[0] - w / 2, y = _scr[1] + 8 * S;
    hud.fillStyle = 'rgba(0,0,0,.55)'; hud.fillRect(x, y, w, h);
    hud.fillStyle = '#5ee36a'; hud.fillRect(x, y, w * clamp(e.hp / 100, 0, 1), h);
    if (e.shield > 0) { hud.fillStyle = '#4fa8ff'; hud.fillRect(x, y - h - 1, w * clamp(e.shield / 100, 0, 1), h); }
  }
  hud.globalAlpha = 1;
  hud.restore();
}

function drawDamageNumbers() {
  // world-space projection needs real pixels, so drop the HUD scale transform
  hud.save();
  hud.setTransform(1, 0, 0, 1, 0, 0);
  const W = hudCv.width, H = hudCv.height;
  hud.textAlign = 'center';
  for (const d of G.dmgNums) {
    if (!projectPoint(R.vp, d.x + d.ox, d.y + d.t * 1.6, d.z, W, H, _scr)) continue;
    const a = clamp(1 - d.t / d.life, 0, 1);
    hud.globalAlpha = a;
    // a pop on arrival; blue for shield damage, gold for a headshot, white for health
    const pop = 1 + 0.45 * Math.max(0, 1 - d.t / 0.1);
    hud.font = (d.crit ? '800 ' + (26 * pop).toFixed(1) + 'px ' : '700 ' + (20 * pop).toFixed(1) + 'px ') + 'system-ui, sans-serif';
    hud.fillStyle = d.crit ? '#ffd24a' : d.shield ? '#5fc4ff' : '#fff';
    hud.strokeStyle = 'rgba(0,0,0,.7)'; hud.lineWidth = 3;
    hud.strokeText(d.val, _scr[0], _scr[1]);
    hud.fillText(d.val, _scr[0], _scr[1]);
  }
  hud.globalAlpha = 1;
  hud.restore();
}

/* ------------------------------- main loop --------------------------------- */

function update(dt) {
  G.t += dt;
  const p = G.player;

  if (G.state === 'drop' || G.state === 'play') {
    if (p.alive) updatePlayer(p, dt);
    if (p.fireT > 0) p.fireT -= dt;
    if (p.swingT > 0) p.swingT -= dt;
    if (p.buildT > 0) p.buildT -= dt;
    if (p.muzzleT > 0) p.muzzleT -= dt;
    if (p.reloadT > 0) { p.reloadT -= dt; if (p.reloadT <= 0) finishReload(p); }
  }

  const simulate = G.state !== 'menu';
  if (simulate) {
    const now = performance.now();
    for (const e of G.ents) {
      if (e === p) continue;
      if (e.remote) Net.interp(e, now);
      else if (e.alive) updateBot(e, dt);
      if (e.alive) stepSound(e);
      if (e.muzzleT > 0) e.muzzleT -= dt;
      if (e.hurtT > 0) e.hurtT -= dt;
      decayKick(e, dt);
    }
    // spectating: follow someone who is still in it, click to move on
    if (G.spec && !p.alive) {
      if (!G.spec.alive || Input.clicked[0]) G.spec = nextSpectate(G.spec);
      if (G.spec) updateCamera(G.spec, dt);
    }
    updateLoot(dt);
    updateSupport();
    updateCollapsing(dt);
    updateParticles(dt);
    for (const ch of World.chests) if (ch.opened && ch.openT < 1) ch.openT = Math.min(1, (ch.openT || 0) + dt * 3);
    if (G.state !== 'drop') updateStorm(dt);
    else { G.storm.timer -= dt * 0.4; if (G.storm.timer < 1) G.storm.timer = 1; }
    if (G.bus) { G.bus.t += dt; G.bus.x += G.bus.dx * 30 * dt; G.bus.z += G.bus.dz * 30 * dt; }
    tickRespawns(dt);
    for (const e of G.ents) { if (!e.alive) e.deadT += dt; updateAnim(e, dt); }
  }
  if (G.state === 'drop' && G.ents.every(e => !e.alive || e.landed || e === p)) {
    if (p.pos[1] <= terrainHeight(p.pos[0], p.pos[2]) + 0.06) G.state = 'play';
  }

  // timers / fx
  if (p.hurtT > 0) p.hurtT -= dt;
  G.hitMark -= dt; G.critMark -= dt; G.elimFlash -= dt * 1.2; G.hurtFlash -= dt * 2;
  G.msgT -= dt;
  for (let i = G.tracers.length - 1; i >= 0; i--) { G.tracers[i].t -= dt; if (G.tracers[i].t <= 0) G.tracers.splice(i, 1); }
  for (let i = G.dmgNums.length - 1; i >= 0; i--) { G.dmgNums[i].t += dt; if (G.dmgNums[i].t >= G.dmgNums[i].life) G.dmgNums.splice(i, 1); }
  for (let i = G.feed.length - 1; i >= 0; i--) { G.feed[i].t -= dt; if (G.feed[i].t <= 0) G.feed.splice(i, 1); }
  for (let i = G.hurtDirs.length - 1; i >= 0; i--) { G.hurtDirs[i].t -= dt; if (G.hurtDirs[i].t <= 0) G.hurtDirs.splice(i, 1); }
  for (let i = World.flashing.length - 1; i >= 0; i--) {
    const f = World.flashing[i];
    f.hitT -= dt;
    if (f.hitT <= 0) { f.hitT = 0; World.flashing[i] = World.flashing[World.flashing.length - 1]; World.flashing.pop(); }
  }
  if (Net.inMatch) Net.tick(dt);
}

// Who to watch next after dying in a lobby: the other humans first, then bots.
function nextSpectate(cur) {
  const order = G.ents.filter(e => e.alive && e !== G.player).sort((a, b) => (b.human - a.human) || (a.id - b.id));
  if (!order.length) return null;
  const i = order.indexOf(cur);
  return order[(i + 1) % order.length];
}

// A solo match waits while the mouse isn't captured (Esc, alt-tab). A lobby match
// never pauses: the host's tab *is* everyone's match, and a client's poses are
// expected too — a host pressing Esc used to freeze the bots, the storm and every
// snapshot for the whole lobby. (A hidden host tab is covered by the interval in
// boot(), since requestAnimationFrame stops there.)
function canRunNow() {
  return Input.locked || Input.padActive || G.state === 'dead' || G.state === 'win' || !!window.__NOLOCK || Net.inMatch;
}

let lastT = 0;
function frame(now) {
  if (!window.__AUTO) requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
  lastT = now;
  Input.pollPad();
  // Start / A works the menu and the end screen, so a pad never needs the mouse.
  if ((G.state === 'menu' || G.state === 'dead' || G.state === 'win') && !Net.active) {
    if (Input.padHit(PAD.START) || Input.padHit(PAD.A)) { startGame(); Input.endFrame(); return; }
  }
  const hw = Math.floor(window.innerWidth), hh = Math.floor(window.innerHeight);
  if (hudCv.width !== hw || hudCv.height !== hh) { hudCv.width = hw; hudCv.height = hh; }
  if (G.state === 'menu') {
    // the world turns slowly behind the menu; characters idle in place
    G.menuT += dt;
    for (const e of G.ents) { if (!e.anim) updateAnim(e, dt); else e.anim.update(dt); }
    renderScene();
    drawHUD();
    audioState(dt);
    Input.endFrame();
    return;
  }
  G.frameDt = dt;
  const perf = G.perf || (G.perf = { frame: 16, render: 0, sim: 0 });
  const t0 = performance.now();
  if (canRunNow()) update(dt);
  const t1 = performance.now();
  // Only resize when it actually changed — assigning width/height reallocates the
  // whole backing store, and doing that 60 times a second is a real frame cost.
  // (drawHUD clears the whole canvas itself, so skipping the resize is safe)
  renderScene();
  drawHUD();
  const t2 = performance.now();
  perf.frame += (dt * 1000 - perf.frame) * 0.05;
  perf.sim += (t1 - t0 - perf.sim) * 0.05;
  perf.render += (t2 - t1 - perf.render) * 0.05;
  updateOverlays();
  audioState(dt);
  Input.endFrame();
}

/* --------------------------------- shell ----------------------------------- */

// The end screen only ever changes when the match does, so look the nodes up once
// and write to them on a transition instead of touching the DOM 60 times a second.
let _ovState = null, _ovDead = null, _ovTitle = null, _ovSub = null;

function updateOverlays() {
  const mp = Net.active;
  const showing = (G.state === 'dead' || G.state === 'win') && !(G.spec && !G.player.alive);
  const key = showing ? G.state + '|' + G.placement + '|' + G.player.kills + '|' + Net.endTitle + '|' + mp + '|' + (G.alive > 0) : 'hidden';
  if (key === _ovState) return;
  _ovState = key;
  if (!_ovDead) {
    _ovDead = document.getElementById('endScreen');
    _ovTitle = document.getElementById('endTitle');
    _ovSub = document.getElementById('endSub');
  }
  if (key === 'hidden') { _ovDead.style.display = 'none'; return; }
  _ovDead.style.display = 'flex';
  const won = G.state === 'win';
  _ovTitle.textContent = won ? '#1 VICTORY ROYALE' : (Net.endTitle || 'ELIMINATED');
  _ovTitle.style.color = won ? '#ffd24a' : '#ff6b6b';
  _ovSub.textContent =
    (won ? 'You outlasted everyone' : '#' + G.placement + ' of ' + G.ents.length) +
    '  ·  ' + G.player.kills + ' elimination' + (G.player.kills === 1 ? '' : 's');
  document.getElementById('againBtn').style.display = mp ? 'none' : '';
  document.getElementById('specBtn').style.display = (mp && !won && !Net.endTitle && G.alive > 0) ? '' : 'none';
  document.getElementById('lobbyBtn').style.display = mp ? '' : 'none';
  document.getElementById('endNote').style.display = mp ? 'none' : '';
}

function startGame(setup) {
  if (!setup && Net.active) Net.leave();   // DROP IN alone means leaving the lobby
  Sfx.init();
  Net.endTitle = '';
  newMatch(setup || null);
  document.getElementById('menu').style.display = 'none';
  document.getElementById('endScreen').style.display = 'none';
  _ovState = null;
  // A pad drives the camera directly — grabbing the mouse would only get in the way.
  if (!window.__NOLOCK) Input.lock(R.canvas);
}

// Back to the front screen (the lobby panel stays open while connected).
function showMenu() {
  G.state = 'menu'; G.spec = null;
  document.getElementById('endScreen').style.display = 'none';
  document.getElementById('menu').style.display = '';
  _ovState = null;
  if (document.pointerLockElement) document.exitPointerLock();
}

// Every model the game can use. Props fall back to boxes, characters to the
// old blocky figure, until their file lands — see assets/README.md.
const MANIFEST = (() => {
  const m = {};
  for (const k in PROP_DEF) for (const name of PROP_DEF[k].models) m[name] = 'assets/' + name + '.glb';
  for (const name of ['chest_z', 'bottle_a', 'pickup_health', 'pickup_bullets']) m[name] = 'assets/' + name + '.glb';
  for (const k in GUN_GLTF) m[GUN_GLTF[k].model] = 'assets/' + GUN_GLTF[k].model + '.glb';
  for (const c of CHAR_SKINS) m[c] = { url: 'assets/' + c + '.glb', skipNodes: '^handslot\\.' };
  return m;
})();

const GAME_SETTINGS_KEY = 'fortniteLite.settings.v1';
const GAME_SETTINGS_DEFAULTS = {
  quality: 'high', fov: 90, sensitivity: 0.0022,
  master: 50, sfx: 100, music: 35, showPerf: false,
};
function readGameSettings() {
  const s = Object.assign({}, GAME_SETTINGS_DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(GAME_SETTINGS_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      if (['low', 'medium', 'high', 'epic'].includes(saved.quality)) s.quality = saved.quality;
      if (Number.isFinite(+saved.fov)) s.fov = Math.max(75, Math.min(105, +saved.fov));
      if (Number.isFinite(+saved.sensitivity)) s.sensitivity = Math.max(0.001, Math.min(0.0045, +saved.sensitivity));
      for (const k of ['master', 'sfx', 'music']) if (Number.isFinite(+saved[k])) s[k] = Math.max(0, Math.min(100, +saved[k]));
      s.showPerf = saved.showPerf === true;
    }
  } catch (e) { /* storage may be disabled; defaults still work */ }
  return s;
}
function setupSettings() {
  const ids = ['qualitySetting', 'fovSetting', 'sensitivitySetting', 'masterSetting', 'sfxSetting', 'musicSetting', 'perfSetting'];
  const els = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const saved = readGameSettings();
  els.qualitySetting.value = saved.quality;
  els.fovSetting.value = saved.fov;
  els.sensitivitySetting.value = saved.sensitivity;
  els.masterSetting.value = saved.master;
  els.sfxSetting.value = saved.sfx;
  els.musicSetting.value = saved.music;
  els.perfSetting.checked = saved.showPerf;

  const apply = () => {
    const settings = {
      quality: els.qualitySetting.value,
      fov: Math.max(75, Math.min(105, +els.fovSetting.value || 90)),
      sensitivity: Math.max(0.001, Math.min(0.0045, +els.sensitivitySetting.value || 0.0022)),
      master: Math.max(0, Math.min(100, +els.masterSetting.value || 0)),
      sfx: Math.max(0, Math.min(100, +els.sfxSetting.value || 0)),
      music: Math.max(0, Math.min(100, +els.musicSetting.value || 0)),
      showPerf: els.perfSetting.checked,
    };
    R.setQuality(settings.quality);
    Input.sens = settings.sensitivity;
    FOV.base = settings.fov * Math.PI / 180;
    Sfx.setVolume(settings.master / 100, settings.sfx / 100, settings.music / 100);
    G.showPerf = settings.showPerf;
    document.getElementById('fovValue').textContent = settings.fov + '°';
    document.getElementById('sensitivityValue').textContent = settings.sensitivity.toFixed(4);
    document.getElementById('masterValue').textContent = settings.master + '%';
    document.getElementById('sfxValue').textContent = settings.sfx + '%';
    document.getElementById('musicValue').textContent = settings.music + '%';
    try { localStorage.setItem(GAME_SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* optional persistence */ }
  };
  for (const id of ['fovSetting', 'sensitivitySetting', 'masterSetting', 'sfxSetting', 'musicSetting']) {
    els[id].addEventListener('input', apply);
  }
  els.qualitySetting.addEventListener('change', apply);
  els.perfSetting.addEventListener('change', apply);
  apply();
}

function boot() {
  const canvas = document.getElementById('gl');
  hudCv = document.getElementById('hud');
  hud = hudCv.getContext('2d');
  // size the backing store before the context exists — a context created on the
  // default 300x150 canvas and grown afterwards is not composited by every build
  const dpr0 = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.floor(window.innerWidth * dpr0); canvas.height = Math.floor(window.innerHeight * dpr0);
  try { R = new Renderer(canvas); }
  catch (err) {
    document.getElementById('menu').innerHTML = '<div style="padding:40px;color:#fff">' + err.message + '</div>';
    return;
  }
  Input.attach(canvas);
  setupSettings();
  World.ents = G.ents;

  // procedural materials + the textured meshes the build pieces are drawn with
  TEX = Textures.build(R);
  const mats = [TEX.wood, TEX.brick, TEX.metal];
  PIECE_MESH = mats.map((t, i) => ({
    cube: R.addTextured(MESH_CUBE, t, 0.5, i === MAT_METAL ? 0.55 : 0.06),
    ramp: R.addTextured(MESH_RAMP, t, 0.5, i === MAT_METAL ? 0.55 : 0.06),
    cone: R.addTextured(MESH_CONE, t, 0.5, i === MAT_METAL ? 0.55 : 0.06),
  }));
  ITEM_MESH = {
    ammo: R.addTextured(MESH_CUBE, TEX.ammo, 1.6, 0.1),
    medkit: R.addTextured(MESH_CUBE, TEX.medkit, 1.5, 0.2),
    bus: R.addTextured(MESH_CUBE, TEX.bus, 0.25, 0.3),
  };

  // Models load in the background; the menu, the map and the match never wait on
  // them, and one that arrives mid-round just starts being drawn.
  // NOTE: file:// cannot fetch these (CORS), so models only appear over
  // http:// — run `node server.js`.
  Assets.init(R);
  Assets.loadAll(MANIFEST);

  addEventListener('resize', () => R.resize());
  // audio can only start on a gesture; the first click or key anywhere is enough
  // for the menu ambience and pad to come up before DROP IN
  addEventListener('pointerdown', () => Sfx.init(), { once: true });
  addEventListener('keydown', () => Sfx.init(), { once: true });
  document.getElementById('playBtn').addEventListener('click', () => startGame());
  document.getElementById('againBtn').addEventListener('click', () => startGame());
  document.getElementById('specBtn').addEventListener('click', () => {
    G.spec = nextSpectate(null);
    document.getElementById('endScreen').style.display = 'none'; _ovState = null;
    if (!window.__NOLOCK) Input.lock(R.canvas);
  });
  document.getElementById('lobbyBtn').addEventListener('click', () => Net.backToLobby());
  Net.init();
  // The host's browser is the match for everyone in the lobby, so when its tab
  // is hidden and requestAnimationFrame stops, keep stepping the simulation.
  setInterval(() => {
    if (!document.hidden || !Net.hosting || G.state === 'menu') return;
    Input.pollPad(); update(1 / 20); Input.endFrame();
  }, 50);

  // control-list tabs; a pad plugging itself in flips to its own list
  const tabKb = document.getElementById('tabKb'), tabPad = document.getElementById('tabPad');
  const showPad = on => {
    document.getElementById('keysKb').style.display = on ? 'none' : 'grid';
    document.getElementById('keysPad').style.display = on ? 'grid' : 'none';
    tabKb.setAttribute('aria-selected', String(!on));
    tabPad.setAttribute('aria-selected', String(on));
  };
  tabKb.addEventListener('click', () => showPad(false));
  tabPad.addEventListener('click', () => showPad(true));
  addEventListener('gamepadconnected', () => showPad(true));
  if (Array.from(navigator.getGamepads ? navigator.getGamepads() : []).some(p => p && p.connected)) showPad(true);
  addEventListener('keydown', e => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (e.code === 'Escape' && G.spec && !G.player.alive && !document.pointerLockElement) { Net.backToLobby(); return; }
    if (Net.active) return;
    if (e.code === 'Enter' && (G.state === 'dead' || G.state === 'win' || G.state === 'menu')) startGame();
  });

  // a world to look at behind the menu
  newMatch();
  for (const e of G.ents) { e.pos[1] = terrainHeight(e.pos[0], e.pos[2]); e.landed = true; e.grounded = true; }
  G.state = 'menu';

  // headless/debug helpers
  window.FN = {
    G, World,
    start: () => { window.__NOLOCK = true; startGame(); document.exitPointerLock && document.exitPointerLock(); },
    god: () => { G.player.hp = 1e9; G.player.shield = 1e9; },
    give: (id, rar) => { G.player.inv[1] = { id, rar: rar || 4, mag: WEAPONS[id].mag }; G.player.slot = 1; },
    mats: n => { G.player.mats = [n, n, n]; },
    tp: (x, z) => { G.player.pos[0] = x; G.player.pos[2] = z; G.player.pos[1] = 30; },
    // gamepad tuning / testing
    Input,
    sens: n => { Input.padLook = n; },
    fov: n => { FOV.base = n; },
    terrain: (x, z) => terrainHeight(x, z),
    // what loaded, what failed and why, and how heavy each model is
    assets: () => Assets.report(),
    reload: (name, url) => Assets.load(name, url || 'assets/' + name + '.glb', MANIFEST[name]),
    aimAssist: on => { G.aimAssist = on !== false; },
    recoil: s => { G.recoilScale = s === undefined ? 1 : +s; },   // kick multiplier: 0 none, 2 double
    shadows: on => { R.shadowsOn = on !== false; },
    post: on => { R.post.on = on !== false; },
    quality: q => { R.setQuality(q || 'high'); },
    perf: on => { G.showPerf = on !== false; },
    // what pad was detected and which slots are live — for diagnosing an odd controller
    pad: () => Input.pad && ({
      id: Input.pad.id, mapping: Input.pad.mapping, profile: Input._prof,
      axes: Array.prototype.slice.call(Input.pad.axes).map(v => +v.toFixed(2)),
      down: Object.keys(PAD).filter(k => Input.padDown(PAD[k])),
    }),
  };

  // ?auto=…: headless screenshot mode. Waits for the models, starts a match, puts
  // the player where the query says, steps the simulation without rendering, then
  // renders once and sets the title to READY. dev/README.md has the parameters.
  const q = new URLSearchParams(location.search);
  if (q.has('auto')) { window.__AUTO = true; autoRun(q); }
  else requestAnimationFrame(frame);
}

async function autoRun(q) {
  const num = (k, d) => q.has(k) ? parseFloat(q.get(k)) : d;
  const t0 = performance.now();
  while (Assets.pending > 0 && performance.now() - t0 < 20000) await new Promise(r => setTimeout(r, 50));
  window.__NOLOCK = true;
  if (q.get('auto') === 'menu') { G.menuT = num('t', 20); }
  else if (q.get('auto') === 'drop') {   // mid-air during the drop: bus, glider, the map below
    startGame();
    Input.keys.KeyW = true;
    for (let i = 0; i < num('steps', 90); i++) update(1 / 30);
    updateCamera(G.player, 1);
  }
  else {
    startGame();
    const p = G.player;
    const poi = World.pois[num('poi', 0)] || World.pois[0];
    const x = q.has('x') ? num('x', 0) : poi.x + num('ox', 0), z = q.has('z') ? num('z', 0) : poi.z + num('oz', 0);
    p.pos[0] = x; p.pos[2] = z; p.pos[1] = surfaceUnder(x, 200, z, 200) + 0.01;
    p.yaw = num('yaw', 0); p.pitch = num('pitch', -0.1);
    if (q.get('give')) { FN.give(q.get('give'), num('rar', 3)); }
    if (q.has('mats')) FN.mats(num('mats', 500));
    if (q.get('fp')) G.firstPerson = true;
    if (q.get('build')) { p.buildMode = true; p.buildType = num('build', 1) | 0; }
    G.state = 'play';
    for (const e of G.ents) { if (e === p) continue; e.landed = true; e.pos[1] = terrainHeight(e.pos[0], e.pos[2]); }
    // bring a few bots close so they are in the shot
    if (q.has('bots')) {
      const n = num('bots', 3);
      for (let i = 1; i <= n && i < G.ents.length; i++) {
        const b = G.ents[i];
        const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw), dd = num('bdist', 7) + i * 2.5, ss = (i - 2) * 3;
        b.pos[0] = x + fx * dd + rx * ss; b.pos[2] = z + fz * dd + rz * ss; b.pos[1] = surfaceUnder(b.pos[0], 200, b.pos[2], 200);
        b.wander[0] = b.pos[0]; b.wander[1] = b.pos[2]; b.think = 999;
        b.inv[1] = { id: GUN_IDS[i % GUN_IDS.length], rar: i % 5, mag: 10 }; b.slot = 1;
        b.yaw = Math.atan2(-(x - b.pos[0]), -(z - b.pos[2]));
      }
    }
    const steps = num('steps', 30);
    for (let i = 0; i < steps; i++) { Input.keys.KeyW = q.get('walk') === '1'; update(1 / 30); }
    if (q.get('ads')) p.ads = true;
    if (q.get('place')) { p.buildMode = true; for (let i = 0; i < num('place', 1); i++) { p.buildT = 0; tryBuild(p); update(0.05); } }
    updateCamera(p, 1);
    p.camDist = undefined; updateCamera(p, 1);
    if (q.get('fire')) {   // fire=N holds the trigger for N shots, so recoil, bloom and the gun kick build up
      for (let i = 0; i < num('fire', 1); i++) { const aim = playerAimDir(p); p.fireT = 0; tryFire(p, aim[0], aim[1], aim[2]); update(0.016); }
    }
    if (q.has('side')) {    // look at the player from the right, for weapon checks
      const d = num('side', 3), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
      G.debugCam = { x: p.pos[0] + rx * d, y: p.pos[1] + 1.3, z: p.pos[2] + rz * d, yaw: wrapAngle(p.yaw + Math.PI / 2), pitch: -0.05 };
    }
    if (q.has('front')) {   // look back at the player from in front, for character checks
      const d = num('front', 3), fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      G.debugCam = { x: p.pos[0] + fx * d, y: p.pos[1] + 1.4, z: p.pos[2] + fz * d, yaw: wrapAngle(p.yaw + Math.PI), pitch: -0.08 };
    }
  }
  hudCv.width = window.innerWidth; hudCv.height = window.innerHeight;
  // present through real animation frames so the compositor picks the frame up
  await new Promise(r => requestAnimationFrame(r));
  renderScene(); drawHUD();
  await new Promise(r => requestAnimationFrame(r));
  renderScene(); drawHUD();
  const _gl = R.gl, _w = R.canvas.width, _h = R.canvas.height, _px = new Uint8Array(_w * _h * 4);
  _gl.readPixels(0, 0, _w, _h, _gl.RGBA, _gl.UNSIGNED_BYTE, _px);
  let _dark = 0; for (let i = 0; i < _px.length; i += 4) if (_px[i] + _px[i + 1] + _px[i + 2] < 30) _dark++;
  window.__READY = { calls: R.drawCalls, instances: R.instances, errors: Assets.errors.slice(), loaded: Object.keys(Assets.models).length, glError: _gl.getError(), dark: +(100 * _dark / (_w * _h)).toFixed(1), size: _w + "x" + _h, state: G.state, pos: G.player.pos.map(v => +v.toFixed(1)), anim: G.player.anim && G.player.anim.curName, upper: G.player.upper, slot: G.player.slot, item: curItem(G.player) && curItem(G.player).id };
  document.title = 'READY';
  const status = () => {
    hud.setTransform(1, 0, 0, 1, 0, 0); hud.font = '12px monospace'; hud.fillStyle = '#5f5'; hud.textAlign = 'left'; hud.textBaseline = 'top';
    hud.fillText('READY ' + JSON.stringify(window.__READY), 8, 4);
  };
  status();
  // dev/shot.js calls this after poking at the page so the frame it captures is current
  window.__shot = () => { if (G.player && G.state !== 'menu') updateCamera(G.player, 1); renderScene(); drawHUD(); updateOverlays(); status(); };
}

addEventListener('DOMContentLoaded', boot);
