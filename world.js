'use strict';
/* =============================================================================
   fortnite-lite / world.js
   Grid build system (absolute world grid + structural support), static
   colliders + spatial hash, collision, raycasting, terrain + roads, map gen
   with themed POIs, loot.
   ============================================================================= */

const GRID = 4;          // tile size (also wall width / floor span)
const LEV = 4;           // one storey — same as GRID so ramps scale uniformly
const HALF = 340;        // map spans -HALF..HALF on X and Z
const CELL = 8;          // spatial-hash cell (XZ only)
const BUILD_COST = 10;
const TSTEP = 6;         // terrain mesh cell size
const CONE_H = LEV * 0.55;   // a roof piece is about half a storey tall, as in Fortnite
const STEP_UP = 0.85;    // how high a ledge you can walk straight up onto
const SPLAT = 512;       // splat-map resolution (roads / dirt), covers the whole map

const MAT_WOOD = 0, MAT_BRICK = 1, MAT_METAL = 2;
const MAT_NAME = ['Wood', 'Brick', 'Metal'];
const MAT_COLOR = [[0.76, 0.55, 0.30], [0.72, 0.36, 0.31], [0.60, 0.65, 0.70]];
const MAT_HP = [150, 280, 460];

/* ------------------------------ weapon tables ------------------------------ */

const RARITY = [
  { name: 'Common', col: [0.62, 0.65, 0.68], mul: 1.00 },
  { name: 'Uncommon', col: [0.36, 0.78, 0.27], mul: 1.08 },
  { name: 'Rare', col: [0.26, 0.50, 0.92], mul: 1.17 },
  { name: 'Epic', col: [0.62, 0.33, 0.87], mul: 1.27 },
  { name: 'Legendary', col: [0.95, 0.62, 0.18], mul: 1.38 },
];

const WEAPONS = {
  pickaxe: { name: 'Pickaxe', dmg: 20, rate: 0.5, mag: 0, ammo: null, spread: 0, range: 3.4, melee: true, harvest: 34 },
  pistol: { name: 'Pistol', dmg: 26, rate: 0.17, mag: 16, ammo: 'light', spread: 0.014, range: 180, reload: 1.3 },
  smg: { name: 'SMG', dmg: 17, rate: 0.075, mag: 30, ammo: 'light', spread: 0.030, range: 120, reload: 2.0 },
  ar: { name: 'Assault Rifle', dmg: 33, rate: 0.12, mag: 30, ammo: 'medium', spread: 0.021, range: 220, reload: 2.3 },
  shotgun: { name: 'Pump Shotgun', dmg: 12, pellets: 9, rate: 0.95, mag: 5, ammo: 'shells', spread: 0.055, range: 40, reload: 2.6 },
  sniper: { name: 'Bolt Sniper', dmg: 105, rate: 1.5, mag: 1, ammo: 'medium', spread: 0.002, range: 400, reload: 2.7, scope: true },
};
const GUN_IDS = ['pistol', 'smg', 'ar', 'shotgun', 'sniper'];
const AMMO_TYPES = ['light', 'medium', 'shells'];
const AMMO_COLOR = { light: [0.85, 0.80, 0.45], medium: [0.85, 0.55, 0.30], shells: [0.85, 0.35, 0.35] };

function rollWeapon(minRar) {
  const r = Math.random();
  let rar = r < 0.36 ? 0 : r < 0.66 ? 1 : r < 0.86 ? 2 : r < 0.96 ? 3 : 4;
  if (minRar) rar = Math.max(rar, minRar);
  const id = pick(GUN_IDS);
  const w = WEAPONS[id];
  return { id, rar, mag: w.mag, cooldown: 0, reloading: 0 };
}
function weaponDamage(item) { return WEAPONS[item.id].dmg * RARITY[item.rar].mul; }
function weaponLabel(item) { return RARITY[item.rar].name + ' ' + WEAPONS[item.id].name; }

/* --------------------------------- world ----------------------------------- */

const World = {
  pieces: new Map(),   // key -> piece (player + bot + prefab structures)
  keyMap: new Map(),   // edge/face key -> Set<piece>, the structural-support graph
  props: [],           // trees / rocks / vehicles / decoration (harvestable when solid)
  loot: [],            // ground items
  chests: [],
  pads: [],            // flattened plateaus under the POIs
  pois: [],            // { x, z, y, theme, name }
  roads: [],           // [x0, z0, x1, z1] segments
  hash: new Map(),     // "cx,cz" -> collider[]
  colliders: [],
  collapsing: [],      // pieces falling away after losing support
  ents: [],            // the game's entity list (set by newMatch), for push-out
  supportDirty: false,
  // Pieces and props currently flashing from a hit. Ticking these down used to
  // mean walking every piece in the world once a frame — thousands of them late
  // in a match — to find the two that were actually hit. They enrol themselves
  // when damaged and drop out when the flash ends.
  flashing: [],
  // Multiplayer. `authority` is false on a client whose lobby host owns the world:
  // pieces then only vanish and structures only collapse when the host says so.
  // Props and loot carry ids (assigned in generation order, which is seeded, so
  // every client numbers them identically); the hooks let net.js broadcast
  // whatever the host's simulation does to the world.
  authority: true,
  nextLootId: 1, nextPropId: 1, propById: new Map(),
  onPieceGone: null, onCollapse: null, onPropGone: null, onLootToss: null,
  reset() {
    this.pieces.clear(); this.keyMap.clear(); this.props.length = 0; this.loot.length = 0;
    this.chests.length = 0; this.hash.clear(); this.colliders.length = 0;
    this.pads.length = 0; this.pois.length = 0; this.roads.length = 0; this.flashing.length = 0;
    this.collapsing.length = 0; this.supportDirty = false;
    this.nextLootId = 1; this.nextPropId = 1; this.propById.clear();
    _tbase.clear(); _tground.clear();
  }
};

let _stamp = 0;

/* -------------------------------- terrain ---------------------------------- */
// The ground is a heightfield: three summed sine ridges, deliberately gentle
// (max slope ~20 degrees) so every hill stays walkable, but tall enough that a
// ridge between two players genuinely breaks the sight line. Around each POI the
// field is flattened to a plateau whose height is a multiple of LEV, so buildings
// and the build grid sit perfectly level exactly where people actually fight.

const TERR = { a: 0, b: 0, c: 0, d: 0, e: 0, amp: 1 };
let TERRAIN_MIN = -22, TERRAIN_MAX = 22;

function seedTerrain() {
  TERR.a = rnd(0, 100); TERR.b = rnd(0, 100); TERR.c = rnd(0, 100);
  TERR.d = rnd(0, 100); TERR.e = rnd(0, 100);
  TERR.amp = rnd(0.85, 1.15);
}

function terrainHeight(x, z) {
  const A = TERR.amp;
  let h = Math.sin(x * 0.0121 + TERR.a) * Math.cos(z * 0.0103 + TERR.b) * 15 * A
    + Math.sin(x * 0.0272 + TERR.c) * Math.cos(z * 0.0231 + TERR.d) * 5.5 * A
    + Math.sin((x + z) * 0.047 + TERR.e) * 1.5 * A;
  // flatten toward any POI plateau, with a soft skirt so the seam isn't a cliff
  const pads = World.pads;
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (Math.abs(x - p.x) > p.r || Math.abs(z - p.z) > p.r) continue;
    const d = Math.sqrt(dist2(x, z, p.x, p.z));
    if (d >= p.r) continue;
    // the skirt eats the outer 55% of the radius, which keeps the plateau edge a
    // walkable slope rather than a cliff even where it has to climb 15m
    h = lerp(h, p.y, clamp((p.r - d) / (p.r * 0.55), 0, 1));
  }
  return h;
}

// Ground height at a tile centre, memoised — read by prop spawning and the
// tile-ground rule below.
const _tbase = new Map();
function terrainBase(gx, gz) {
  const k = gx + ',' + gz;
  let v = _tbase.get(k);
  if (v === undefined) {
    const [cx, cz] = tileCenter(gx, gz);
    v = terrainHeight(cx, cz);
    _tbase.set(k, v);
  }
  return v;
}

// Lowest / highest ground inside a tile (corners + centre), memoised. A piece
// whose base is between the two — give or take — is standing on the ground.
const _tground = new Map();
function tileGround(gx, gz) {
  const k = gx + ',' + gz;
  let v = _tground.get(k);
  if (v === undefined) {
    const x0 = gx * GRID, z0 = gz * GRID;
    const hs = [terrainHeight(x0, z0), terrainHeight(x0 + GRID, z0), terrainHeight(x0, z0 + GRID),
      terrainHeight(x0 + GRID, z0 + GRID), terrainHeight(x0 + GRID / 2, z0 + GRID / 2)];
    v = { lo: Math.min.apply(null, hs), hi: Math.max.apply(null, hs) };
    _tground.set(k, v);
  }
  return v;
}

// Nearest terrain crossing along a ray: coarse march (steps grow with distance,
// since detail matters least far away) then a short binary refine.
function rayTerrain(ox, oy, oz, dx, dy, dz, maxT) {
  if (oy > TERRAIN_MAX && dy >= 0) return -1;      // above every hill, heading up
  let t = 0, prev = oy - terrainHeight(ox, oz);
  if (prev <= 0) return 0;                          // already underground
  let guard = 0;
  while (t < maxT && guard++ < 300) {
    const step = Math.max(1.5, t * 0.035);
    const nt = Math.min(maxT, t + step);
    const h = (oy + dy * nt) - terrainHeight(ox + dx * nt, oz + dz * nt);
    if (h <= 0) {
      let lo = t, hi = nt;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if ((oy + dy * mid) - terrainHeight(ox + dx * mid, oz + dz * mid) > 0) lo = mid; else hi = mid;
      }
      return hi;
    }
    if (nt >= maxT) break;
    prev = h; t = nt;
  }
  return -1;
}

const TERRAIN_COL = { kind: 'ground', ref: null, dead: false, stamp: -1 };

// One smooth-shaded terrain mesh; the terrain shader picks grass / dirt / rock
// per pixel from slope, height and the splat map, so no colour bands any more.
function buildTerrainMesh() {
  const verts = [];
  let lo = Infinity, hi = -Infinity;
  const n = Math.ceil((HALF * 2) / TSTEP);
  const H = new Float32Array((n + 1) * (n + 1));
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const h = terrainHeight(-HALF + i * TSTEP, -HALF + j * TSTEP);
      H[i * (n + 1) + j] = h;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  TERRAIN_MIN = lo; TERRAIN_MAX = hi;
  const at = (i, j) => H[clamp(i, 0, n) * (n + 1) + clamp(j, 0, n)];
  const NX = new Float32Array((n + 1) * (n + 1)), NZ = new Float32Array((n + 1) * (n + 1));
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * TSTEP), dz = (at(i, j + 1) - at(i, j - 1)) / (2 * TSTEP);
      const l = len3(dx, 1, dz);
      NX[i * (n + 1) + j] = -dx / l; NZ[i * (n + 1) + j] = -dz / l;
    }
  }
  const V = (i, j) => {
    const k = i * (n + 1) + j, nx = NX[k], nz = NZ[k];
    verts.push(-HALF + i * TSTEP, H[k], -HALF + j * TSTEP, nx, Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz)), nz);
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      V(i, j); V(i + 1, j); V(i + 1, j + 1);
      V(i, j); V(i + 1, j + 1); V(i, j + 1);
    }
  }
  return [{ verts }];
}

// Distance from a point to a segment, squared.
function segDist2(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az, wx = px - ax, wz = pz - az;
  const l2 = vx * vx + vz * vz || 1;
  const t = clamp((wx * vx + wz * vz) / l2, 0, 1);
  const cx = ax + vx * t - px, cz = az + vz * t - pz;
  return cx * cx + cz * cz;
}
function nearRoad(x, z, w) {
  const w2 = w * w;
  for (const r of World.roads) if (segDist2(x, z, r[0], r[1], r[2], r[3]) < w2) return true;
  return false;
}

// Splat map (RGBA8): R = dirt. Roads between POIs, worn plazas in the middle of
// each POI, and scattered bare patches from a little hash noise.
function buildSplat() {
  const S = SPLAT, data = new Uint8Array(S * S * 4);
  const cell = (2 * HALF) / S;
  const smooth = (x, z, n) => {          // bilinear hash noise, n cells across the map
    const fx = (x + HALF) / (2 * HALF) * n, fz = (z + HALF) / (2 * HALF) * n;
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
    return lerp(lerp(hash2(ix, iz), hash2(ix + 1, iz), sx), lerp(hash2(ix, iz + 1), hash2(ix + 1, iz + 1), sx), sz);
  };
  for (let j = 0; j < S; j++) {
    const z = -HALF + (j + 0.5) * cell;
    for (let i = 0; i < S; i++) {
      const x = -HALF + (i + 0.5) * cell;
      let d = 0;
      let best = 1e9;
      for (const r of World.roads) { const q = segDist2(x, z, r[0], r[1], r[2], r[3]); if (q < best) best = q; }
      const rd = Math.sqrt(best);
      d = Math.max(d, 1 - smoothstep(2.6, 5.2, rd));
      for (const p of World.pois) {
        const q = Math.sqrt(dist2(x, z, p.x, p.z));
        if (p.theme === 'town' || p.theme === 'spacebase') d = Math.max(d, (1 - smoothstep(14, 24, q)) * 0.9);
        else if (p.theme === 'farm' || p.theme === 'camp') d = Math.max(d, (1 - smoothstep(6, 12, q)) * 0.7);
      }
      const nz = smooth(x, z, 48) * 0.6 + smooth(x, z, 130) * 0.4;
      d = Math.max(d, smoothstep(0.66, 0.78, nz) * 0.55);
      const o = (j * S + i) * 4;
      data[o] = clamp(d, 0, 1) * 255; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 255;
    }
  }
  return { data, size: S };
}

function hashKey(cx, cz) { return cx + ',' + cz; }

function addCollider(c) {
  c.dead = false; c.stamp = -1;
  World.colliders.push(c);
  for (let cx = Math.floor(c.minx / CELL); cx <= Math.floor(c.maxx / CELL); cx++) {
    for (let cz = Math.floor(c.minz / CELL); cz <= Math.floor(c.maxz / CELL); cz++) {
      const k = hashKey(cx, cz);
      let a = World.hash.get(k);
      if (!a) { a = []; World.hash.set(k, a); }
      a.push(c);
    }
  }
  return c;
}

function queryBoxes(minx, miny, minz, maxx, maxy, maxz, out) {
  out.length = 0; _stamp++;
  for (let cx = Math.floor(minx / CELL); cx <= Math.floor(maxx / CELL); cx++) {
    for (let cz = Math.floor(minz / CELL); cz <= Math.floor(maxz / CELL); cz++) {
      const arr = World.hash.get(hashKey(cx, cz));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        if (c.dead || c.stamp === _stamp) continue;
        c.stamp = _stamp;
        if (c.maxx <= minx || c.minx >= maxx || c.maxy <= miny || c.miny >= maxy ||
          c.maxz <= minz || c.minz >= maxz) continue;
        out.push(c);
      }
    }
  }
  return out;
}

/* ------------------------------- build pieces ------------------------------ */
// The build grid is absolute: tile (gx, gz) spans [gx*GRID, (gx+1)*GRID) and
// storey gy has its floor at exactly gy*LEV, everywhere on the map. Neighbouring
// pieces therefore always line up — a floor meets the next floor flush, a ramp's
// top edge lands exactly on the storey above — and on a hillside a ground piece
// simply sinks partway into the slope, as it does in Fortnite.
//
// Walls are stored canonically: only rot 0 (on the tile's -Z edge) and rot 3
// (on the -X edge) exist, so two players can never stack two walls on one edge.

function normalizeWall(gx, gy, gz, rot) {
  if (rot === 2) return [gx, gy, gz + 1, 0];
  if (rot === 1) return [gx + 1, gy, gz, 3];
  return [gx, gy, gz, rot];
}
function pieceKey(type, gx, gy, gz, rot) {
  return type === 'wall' ? `w|${gx}|${gy}|${gz}|${rot}` : `${type[0]}|${gx}|${gy}|${gz}`;
}
function tileCenter(gx, gz) { return [gx * GRID + GRID / 2, gz * GRID + GRID / 2]; }
function pieceY(p) { return p.gy * LEV; }

function pieceBox(p) {
  const [cx, cz] = tileCenter(p.gx, p.gz);
  const y0 = pieceY(p);
  if (p.type === 'wall') {
    if (p.rot === 0) return { minx: cx - GRID / 2, maxx: cx + GRID / 2, miny: y0, maxy: y0 + LEV, minz: p.gz * GRID - 0.2, maxz: p.gz * GRID + 0.2 };
    return { minx: p.gx * GRID - 0.2, maxx: p.gx * GRID + 0.2, miny: y0, maxy: y0 + LEV, minz: cz - GRID / 2, maxz: cz + GRID / 2 };
  }
  if (p.type === 'floor') return { minx: cx - GRID / 2, maxx: cx + GRID / 2, miny: y0 - 0.3, maxy: y0, minz: cz - GRID / 2, maxz: cz + GRID / 2 };
  if (p.type === 'cone') return { minx: cx - GRID / 2, maxx: cx + GRID / 2, miny: y0, maxy: y0 + CONE_H, minz: cz - GRID / 2, maxz: cz + GRID / 2 };
  return { minx: cx - GRID / 2, maxx: cx + GRID / 2, miny: y0, maxy: y0 + LEV, minz: cz - GRID / 2, maxz: cz + GRID / 2 };
}

function inMap(gx, gz) {
  const x = gx * GRID, z = gz * GRID;
  return x > -HALF && x < HALF - GRID && z > -HALF && z < HALF - GRID;
}

// Which way a ramp rises, per rot: 0:-Z 1:-X 2:+Z 3:+X.
const RISE_DIR = [[0, -1], [-1, 0], [0, 1], [1, 0]];

/* Structural support. Every piece owns a few *contact keys* — the grid edges its
   corners run along and, for walls, the face a ramp can lean on. Two pieces that
   share a key are connected; anything connected to a grounded piece stands.
   That is what lets a wall hang under a floor, a ramp lean on the wall beside
   it, and a whole tower fall the moment its bottom ramp is shot out. */
function pieceKeys(type, gx, gy, gz, rot) {
  const H = (x, y, z, d) => `h|${d}|${x}|${y}|${z}`;      // horizontal edge: d='x' along X at z-line z; d='z' along Z at x-line x
  const V = (x, y, z) => `v|${x}|${y}|${z}`;              // vertical edge at corner (x, z) through storey y
  const F = (d, line, y, i) => `f|${d}|${line}|${y}|${i}`; // wall face on a line, storey y, tile index i along it
  if (type === 'floor' || type === 'cone') {
    return [H(gx, gy, gz, 'x'), H(gx, gy, gz + 1, 'x'), H(gx, gy, gz, 'z'), H(gx + 1, gy, gz, 'z')];
  }
  if (type === 'wall') {
    if (rot === 0) return [H(gx, gy, gz, 'x'), H(gx, gy + 1, gz, 'x'), V(gx, gy, gz), V(gx + 1, gy, gz), F('z', gz, gy, gx)];
    return [H(gx, gy, gz, 'z'), H(gx, gy + 1, gz, 'z'), V(gx, gy, gz), V(gx, gy, gz + 1), F('x', gx, gy, gz)];
  }
  // ramp: low edge at this storey, high edge one storey up, and the two walls
  // that can flank it
  switch (rot & 3) {
    case 0: return [H(gx, gy, gz + 1, 'x'), H(gx, gy + 1, gz, 'x'), F('x', gx, gy, gz), F('x', gx + 1, gy, gz)];
    case 2: return [H(gx, gy, gz, 'x'), H(gx, gy + 1, gz + 1, 'x'), F('x', gx, gy, gz), F('x', gx + 1, gy, gz)];
    case 1: return [H(gx + 1, gy, gz, 'z'), H(gx, gy + 1, gz, 'z'), F('z', gz, gy, gx), F('z', gz + 1, gy, gx)];
    default: return [H(gx, gy, gz, 'z'), H(gx + 1, gy + 1, gz, 'z'), F('z', gz, gy, gx), F('z', gz + 1, gy, gx)];
  }
}

// Standing on the ground: the piece's base sits at or just above the highest
// ground in its tile, or partly buried in a slope (but not a whole storey deep).
function grounded(type, gx, gy, gz, rot) {
  const base = gy * LEV;
  let lo, hi;
  if (type === 'wall') {
    // a wall lives on an edge between two tiles — either tile can hold it up
    const a = tileGround(gx, gz), b = rot === 0 ? tileGround(gx, gz - 1) : tileGround(gx - 1, gz);
    lo = Math.min(a.lo, b.lo); hi = Math.max(a.hi, b.hi);
  } else { const g = tileGround(gx, gz); lo = g.lo; hi = g.hi; }
  return base <= hi + 0.6 && base >= lo - LEV * 0.8;
}

function hasSupport(type, gx, gy, gz, rot) {
  if (grounded(type, gx, gy, gz, rot)) return true;
  for (const k of pieceKeys(type, gx, gy, gz, rot)) if (World.keyMap.has(k)) return true;
  return false;
}

function canPlace(type, gx, gy, gz, rot) {
  if (!inMap(gx, gz) || gy < -7 || gy > 16) return false;
  if (World.pieces.has(pieceKey(type, gx, gy, gz, rot))) return false;
  return hasSupport(type, gx, gy, gz, rot);
}

function rampSurf(p, x, z) { return rampHeightAt(p, x, z); }
function coneSurf(p, x, z) {
  const [cx, cz] = tileCenter(p.gx, p.gz);
  const dx = Math.abs(x - cx), dz = Math.abs(z - cz);
  if (dx > GRID / 2 || dz > GRID / 2) return null;
  return pieceY(p) + CONE_H * (1 - Math.max(dx, dz) / (GRID / 2));
}

function addPiece(type, gx, gy, gz, rot, mat, owner) {
  const key = pieceKey(type, gx, gy, gz, rot);
  if (World.pieces.has(key)) return null;
  const hp = MAT_HP[mat] * (type === 'wall' ? 1 : 0.85);
  const p = { key, type, gx, gy, gz, rot: rot | 0, mat, hp, maxHp: hp, owner, built: true, t: 0 };
  const b = pieceBox(p);
  p.col = addCollider({
    minx: b.minx, miny: b.miny, minz: b.minz, maxx: b.maxx, maxy: b.maxy, maxz: b.maxz,
    kind: 'piece', ref: p,
    slope: type === 'ramp' || type === 'cone',
    surf: type === 'ramp' ? rampSurf : type === 'cone' ? coneSurf : null,
    deck: type === 'ramp' ? RAMP_DECK * LEV : CONE_H + 1,
  });
  p.keys = pieceKeys(type, gx, gy, gz, rot);
  for (const k of p.keys) {
    let s = World.keyMap.get(k);
    if (!s) { s = new Set(); World.keyMap.set(k, s); }
    s.add(p);
  }
  World.pieces.set(key, p);
  pushEntitiesOut(p.col);
  return p;
}

function removePiece(p, silent) {
  if (!World.pieces.has(p.key)) return;
  World.pieces.delete(p.key);
  p.col.dead = true;
  for (const k of p.keys) {
    const s = World.keyMap.get(k);
    if (s) { s.delete(p); if (!s.size) World.keyMap.delete(k); }
  }
  if (!silent) {
    World.supportDirty = true;
    if (World.onPieceGone) World.onPieceGone(p);
  }
}

// Walk the support graph from every grounded piece; whatever is left over has
// nothing holding it up and falls. Runs once per frame at most, only after a
// removal, and is a plain BFS over the pieces.
function updateSupport() {
  if (!World.supportDirty || !World.authority) return;
  World.supportDirty = false;
  const ok = new Set();
  const open = [];
  for (const p of World.pieces.values()) {
    if (grounded(p.type, p.gx, p.gy, p.gz, p.rot)) { ok.add(p); open.push(p); }
  }
  while (open.length) {
    const p = open.pop();
    for (const k of p.keys) {
      const s = World.keyMap.get(k);
      if (!s) continue;
      for (const q of s) if (!ok.has(q)) { ok.add(q); open.push(q); }
    }
  }
  const fallen = [];
  for (const p of Array.from(World.pieces.values())) {
    if (ok.has(p)) continue;
    collapsePiece(p);
    fallen.push(p.key);
  }
  if (fallen.length && World.onCollapse) World.onCollapse(fallen);
}

// Take a piece out of the world and start it falling.
function collapsePiece(p) {
  removePiece(p, true);
  World.collapsing.push({ type: p.type, gx: p.gx, gy: p.gy, gz: p.gz, rot: p.rot, mat: p.mat, t: 0, y: pieceY(p), vy: rnd(0.5, 2), spin: rnd(-1.5, 1.5) });
  if (World.collapsing.length > 400) World.collapsing.splice(0, World.collapsing.length - 400);
}

function updateCollapsing(dt) {
  for (let i = World.collapsing.length - 1; i >= 0; i--) {
    const c = World.collapsing[i];
    c.t += dt;
    c.vy -= 22 * dt;
    c.y += c.vy * dt;
    if (c.t > 1.1) { World.collapsing[i] = World.collapsing[World.collapsing.length - 1]; World.collapsing.pop(); }
  }
}

// Returns mats harvested.
function damagePiece(p, dmg, harvest) {
  p.hp -= dmg;
  if (!(p.hitT > 0)) World.flashing.push(p);   // undefined on a fresh piece/prop
  p.hitT = 0.18;
  if (p.hp <= 0) { removePiece(p); return harvest ? 30 : 0; }
  return harvest ? 12 : 0;
}

/* --------------------------------- props ----------------------------------- */
// Everything that is not a build piece: trees, rocks, cars, crates, street
// furniture, gravestones, space cargo… `PROP_DEF` maps a kind to its models
// (variants picked at random), height, footprint, material and hit points.
// A solid prop gets a collider (so it blocks, shields and can be harvested); a
// decorative one is just drawn.

// `maxR` caps the collider taken from the model's footprint — a tree blocks at its
// trunk, not at the edge of its canopy. `weights` biases the random variant pick
// (lighter tree meshes are drawn more often: 1500 of them are on the map).
const PROP_DEF = {
  // Quaternius Ultimate Stylized Nature (textured bark, alpha-cutout leaves)
  tree: {
    models: ['tree_pine_1', 'tree_pine_2', 'tree_pine_4', 'tree_pine_5', 'tree_birch_1', 'tree_birch_4', 'tree_birch_5', 'tree_maple_1', 'tree_maple_4', 'tree_maple_5', 'tree_oak_3', 'tree_oak_5'],
    h: [9.5, 12, 9, 8.5, 10, 8, 10.5, 9, 7, 10, 9, 7],
    weights: [3, 2, 2, 3, 2, 3, 1, 1, 3, 1, 1, 2],
    rx: 0.55, maxR: 0.55, mat: MAT_WOOD, hp: 100, rot: 'any', cull: 6,
  },
  tree_dead: { models: ['tree_dead_1', 'tree_dead_3', 'tree_dead_5', 'tree_dead_9'], h: [8.0, 7.0, 4.0, 4.5], rx: 0.5, maxR: 0.5, mat: MAT_WOOD, hp: 80, rot: 'any', cull: 5 },
  rock: { models: ['rock_1', 'rock_2', 'rock_3', 'rock_4', 'rock_5'], h: [1.6, 1.9, 2.3, 3.0, 2.5], rx: 1.2, mat: MAT_BRICK, hp: 130, rot: 'any' },
  bush: { models: ['bush_1', 'bush_2', 'bush_3', 'bush_4', 'bush_5'], h: [1.3, 1.5, 1.2, 1.3, 1.5], rx: 0.7, mat: MAT_WOOD, hp: 20, solid: false, rot: 'any' },
  grass: { models: ['grass_1', 'grass_2', 'plant_1', 'plant_2', 'plant_3'], h: [0.55, 0.45, 0.5, 0.5, 1.0], rx: 0.5, mat: MAT_WOOD, hp: 5, solid: false, rot: 'any', cull: 1.5 },
  log: { models: ['log_large', 'log_medium'], h: [1.1, 0.9], rx: 0.6, rz: 1.6, mat: MAT_WOOD, hp: 80, rot: 'any' },
  // Quaternius Zombie Apocalypse Kit — vehicles and street furniture
  car: { models: ['car_pickup', 'car_sports', 'car_truck', 'car_pickup_armored', 'car_sports_armored', 'car_truck_armored'], h: [1.8, 1.9, 2.9, 2.0, 2.0, 2.9], rx: 1.2, rz: 2.6, mat: MAT_METAL, hp: 170, rot: 'any' },
  streetlight: { models: ['streetlight_z'], h: 6.6, rx: 0.3, maxR: 0.35, mat: MAT_METAL, hp: 60 },
  trafficlight: { models: ['trafficlight_1', 'trafficlight_2'], h: [4.7, 4.7], rx: 0.3, maxR: 0.4, mat: MAT_METAL, hp: 60 },
  hydrant: { models: ['hydrant_z'], h: 0.8, rx: 0.25, mat: MAT_METAL, hp: 40 },
  trash: { models: ['trash_a', 'trash_b', 'trashbag_1', 'trashbag_2'], h: [1.1, 1.1, 0.6, 0.5], rx: 0.35, mat: MAT_METAL, hp: 30 },
  cone: { models: ['cone_1', 'cone_2'], h: 0.7, rx: 0.3, mat: MAT_METAL, hp: 15, rot: 'any' },
  barrier: { models: ['barrier_1', 'barrier_2', 'barrier_plastic'], h: [1.1, 0.8, 0.6], rx: 0.8, rz: 0.4, mat: MAT_WOOD, hp: 40 },
  container_z: { models: ['container_green', 'container_red'], h: 2.6, rx: 1.3, rz: 2.9, mat: MAT_METAL, hp: 300 },
  watertower: { models: ['watertower_z'], h: 11, rx: 1.6, mat: MAT_METAL, hp: 400 },
  townsign: { models: ['townsign'], h: 5.5, rx: 3.0, rz: 0.9, mat: MAT_METAL, hp: 120 },
  wheels: { models: ['wheels_stack'], h: 0.6, rx: 0.4, mat: MAT_METAL, hp: 30, rot: 'any' },
  pipes: { models: ['pipes'], h: 0.7, rx: 0.4, rz: 1.7, mat: MAT_METAL, hp: 60, rot: 'any' },
  drum: { models: ['barrel_z'], h: 1.1, rx: 0.4, mat: MAT_METAL, hp: 45 },
  couch_z: { models: ['couch_z'], h: 1.2, rx: 1.5, rz: 0.6, mat: MAT_WOOD, hp: 50 },
  // KayKit street / farm / camp props
  bench: { models: ['bench'], h: 0.9, rx: 1.0, rz: 0.4, mat: MAT_WOOD, hp: 50 },
  dumpster: { models: ['dumpster'], h: 1.5, rx: 1.0, rz: 0.7, mat: MAT_METAL, hp: 120 },
  box: { models: ['box_a', 'box_b', 'crate_big', 'crates_stacked', 'crate_small'], h: [1.0, 1.0, 1.4, 1.9, 0.8], rx: 0.6, mat: MAT_WOOD, hp: 45 },
  barrel: { models: ['barrel', 'barrel_large', 'keg', 'barrel_stack'], h: [1.1, 1.3, 1.0, 1.5], rx: 0.5, mat: MAT_WOOD, hp: 45 },
  fence: { models: ['fence_wood'], h: 1.2, rx: 1.7, rz: 0.15, mat: MAT_WOOD, hp: 40 },
  fence_iron: { models: ['fence_iron', 'fence_gate'], h: 1.5, rx: 1.7, rz: 0.15, mat: MAT_METAL, hp: 60 },
  tent: { models: ['tent'], h: 2.6, rx: 1.9, rz: 1.9, mat: MAT_WOOD, hp: 60 },
  wheelbarrow: { models: ['wheelbarrow'], h: 1.0, rx: 0.5, rz: 0.9, mat: MAT_METAL, hp: 40 },
  pallet: { models: ['pallet', 'pallet_z', 'pallet_broken'], h: [0.35, 0.15, 0.2], rx: 0.9, mat: MAT_WOOD, hp: 30, solid: false },
  sack: { models: ['sack'], h: 0.8, rx: 0.4, mat: MAT_WOOD, hp: 25 },
  lumber: { models: ['lumber'], h: 1.1, rx: 0.9, rz: 0.6, mat: MAT_WOOD, hp: 70 },
  stone: { models: ['stone'], h: 1.3, rx: 0.9, mat: MAT_BRICK, hp: 90 },
  // the space base: KayKit containers / cargo / turbine / pad + Quaternius Ultimate Space Kit
  container: { models: ['container_a', 'container_b'], h: 3.0, rx: 1.5, rz: 3.4, mat: MAT_METAL, hp: 300 },
  cargo: { models: ['cargo'], h: 2.3, rx: 1.3, mat: MAT_METAL, hp: 150 },
  crate: { models: ['pickup_crate'], h: 0.9, rx: 0.45, mat: MAT_METAL, hp: 50 },
  ship: { models: ['ship_bee', 'ship_frog', 'ship_panda'], h: [4.8, 3.2, 2.6], rx: 3.5, rz: 3.5, mat: MAT_METAL, hp: 400, rot: 'any' },
  rover: { models: ['rover_1', 'rover_2', 'rover_round'], h: [3.2, 3.2, 3.5], rx: 1.5, rz: 2.4, mat: MAT_METAL, hp: 250, rot: 'any' },
  dome: { models: ['dome', 'base_large'], h: [5.3, 5.0], rx: 4.2, mat: MAT_METAL, hp: 600 },
  spacehouse: { models: ['house_single', 'house_long', 'house_cylinder'], h: [4.0, 4.3, 4.3], rx: 2.0, rz: 2.0, mat: MAT_METAL, hp: 500 },
  turbine: { models: ['turbine'], h: 24, rx: 1.0, mat: MAT_METAL, hp: 500 },
  solar: { models: ['solar_ground', 'solar_structure'], h: [1.1, 3.1], rx: 0.7, rz: 0.9, mat: MAT_METAL, hp: 80 },
  radar: { models: ['radar'], h: 3.5, rx: 0.8, mat: MAT_METAL, hp: 80 },
  support: { models: ['metal_support'], h: 1.2, rx: 0.1, rz: 3.0, mat: MAT_METAL, hp: 120 },
  alien: { models: ['alien_blob', 'alien_spikes', 'alien_spiral', 'alien_swirl'], h: [5.0, 4.5, 4.0, 6.0], rx: 0.5, maxR: 0.5, mat: MAT_WOOD, hp: 60, rot: 'any' },
  srock: { models: ['srock_1', 'srock_2', 'srock_large_1', 'srock_large_2', 'srock_large_3'], h: [3.4, 2.6, 3.2, 7.5, 6.5], rx: 1.5, mat: MAT_BRICK, hp: 200, rot: 'any' },
  landingpad: { models: ['landingpad'], h: 0.45, rx: 5, mat: MAT_METAL, hp: 300, solid: false },
  // the graveyard (KayKit Halloween)
  grave: { models: ['grave_a', 'grave_b', 'gravestone'], h: [1.4, 1.2, 1.0], rx: 0.5, mat: MAT_BRICK, hp: 60 },
  crypt: { models: ['crypt'], h: 5.8, rx: 3.0, rz: 3.6, mat: MAT_BRICK, hp: 500 },
  lantern: { models: ['lantern', 'post_lantern'], h: [1.3, 3.4], rx: 0.25, mat: MAT_METAL, hp: 30 },
  pumpkin: { models: ['pumpkin'], h: 0.65, rx: 0.4, mat: MAT_WOOD, hp: 15 },
  arch_gate: { models: ['arch_gate'], h: 4.8, rx: 2.4, rz: 0.4, mat: MAT_METAL, hp: 200 },
  // furniture (house interiors)
  table: { models: ['table'], h: 0.9, rx: 1.0, rz: 0.6, mat: MAT_WOOD, hp: 40 },
  chair: { models: ['chair'], h: 1.0, rx: 0.35, mat: MAT_WOOD, hp: 25 },
  bed: { models: ['bed'], h: 0.9, rx: 0.8, rz: 1.5, mat: MAT_WOOD, hp: 50 },
  couch: { models: ['couch', 'armchair'], h: [0.95, 1.0], rx: 1.3, rz: 0.6, mat: MAT_WOOD, hp: 50 },
  cabinet: { models: ['cabinet', 'shelf'], h: [1.6, 2.0], rx: 0.7, rz: 0.35, mat: MAT_WOOD, hp: 50 },
  lamp: { models: ['lamp'], h: 1.7, rx: 0.25, mat: MAT_METAL, hp: 20 },
  rug: { models: ['rug'], h: 0.06, rx: 1.4, rz: 1.0, mat: MAT_WOOD, hp: 10, solid: false },
};

function propFootprint(def, model, h, rot) {
  // prefer the loaded model's real footprint; fall back to the table
  let rx = def.rx, rz = def.rz === undefined ? def.rx : def.rz;
  const m = (typeof Assets !== 'undefined') ? Assets.get(model) : null;
  if (m && m.h > 0) {
    const s = h / m.h;
    rx = Math.max(0.2, m.w * s / 2); rz = Math.max(0.2, m.d * s / 2);
    if (def.maxR) { rx = Math.min(rx, def.maxR); rz = Math.min(rz, def.maxR); }   // trunk, not canopy
  }
  // a rotated box is approximated by a square that covers it
  const q = Math.round(rot / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(rot - q) > 0.05) { const r = Math.max(rx, rz) * 0.9; rx = r; rz = r; }
  else if (Math.abs(Math.round(rot / (Math.PI / 2))) % 2 === 1) { const t = rx; rx = rz; rz = t; }
  return [rx, rz];
}

// Random variant index, honouring the kind's `weights` when it has them.
function pickVariant(def) {
  const w = def.weights;
  if (!w) return (Math.random() * def.models.length) | 0;
  let total = 0;
  for (let i = 0; i < w.length; i++) total += w[i];
  let r = Math.random() * total;
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i; }
  return w.length - 1;
}

function addProp(kind, x, z, opts) {
  const def = PROP_DEF[kind];
  if (!def) return null;
  const o = opts || {};
  const vi = o.variant !== undefined ? o.variant : pickVariant(def);
  const model = def.models[vi];
  const h = (Array.isArray(def.h) ? def.h[vi] : def.h) * (o.scale || 1);
  const rot = o.rot !== undefined ? o.rot : (def.rot === 'any' ? rnd(0, Math.PI * 2) : 0);
  const y = o.y !== undefined ? o.y : terrainHeight(x, z);
  const p = { kind, model, x, y, z, rot, h, mat: def.mat, hp: def.hp, maxHp: def.hp, t: Math.random() * 6, solid: def.solid !== false, col: null, cull: def.cull || Math.max(2, h * 0.5), id: World.nextPropId++ };
  World.propById.set(p.id, p);
  if (p.solid) {
    const [rx, rz] = propFootprint(def, model, h, rot);
    p.col = addCollider({ minx: x - rx, maxx: x + rx, miny: y - 1, maxy: y + h, minz: z - rz, maxz: z + rz, kind: 'prop', ref: p });
  }
  World.props.push(p);
  return p;
}

function damageProp(p, dmg) {
  p.hp -= dmg;
  if (!(p.hitT > 0)) World.flashing.push(p);   // undefined on a fresh piece/prop
  p.hitT = 0.15;
  if (p.hp <= 0) {
    destroyProp(p);
    if (World.onPropGone) World.onPropGone(p);
    return 34;
  }
  return 15;
}
function destroyProp(p) {
  if (p.col) p.col.dead = true;
  const i = World.props.indexOf(p);
  if (i >= 0) World.props.splice(i, 1);
  World.propById.delete(p.id);
}

/* ---------------------------------- loot ----------------------------------- */

// Loot is a physical object: it falls, bounces once and settles on whatever is
// under it (ground, floor piece, roof). `cool` blocks pickup so a dropped item
// isn't instantly re-collected by the person who threw it.
function spawnLoot(kind, x, y, z, data) {
  const it = {
    kind, x, y, z, spin: Math.random() * 6, data: data || {},
    vx: 0, vy: 0, vz: 0, rest: false, cool: 0, pop: 0, id: World.nextLootId++
  };
  World.loot.push(it);
  return it;
}
function spawnWeaponLoot(x, y, z, item) { return spawnLoot('weapon', x, y, z, { item }); }
function spawnAmmoLoot(x, y, z, type, n) { return spawnLoot('ammo', x, y, z, { type, n }); }

// Throw an item out with an arc — used by chests, eliminations and manual drops.
function tossLoot(it, vx, vy, vz, cool) {
  it.vx = vx; it.vy = vy; it.vz = vz;
  it.rest = false; it.cool = cool || 0; it.pop = 1;
  if (World.onLootToss) World.onLootToss(it);
  return it;
}
function lootById(id) { for (const l of World.loot) if (l.id === id) return l; return null; }

// Top surface directly beneath a point, so loot and skydivers land on builds,
// roofs, ramps and props as well as the ground.
function surfaceUnder(x, y, z, prevY) {
  let top = terrainHeight(x, z);
  queryBoxes(x - 0.3, y - 1.0, z - 0.3, x + 0.3, prevY + 0.6, z + 0.3, _q);
  for (const c of _q) {
    if (c.noclip) continue;
    if (c.slope) {
      const h = c.surf(c.ref, x, z);
      if (h !== null && h <= prevY + 0.35 && h > top) top = h;
      continue;
    }
    if (c.maxy <= prevY + 0.35 && c.maxy > top) top = c.maxy;
  }
  return top;
}

function updateLoot(dt) {
  for (const l of World.loot) {
    if (l.cool > 0) l.cool -= dt;
    if (l.pop > 0) l.pop = Math.max(0, l.pop - dt * 4);
    if (l.rest) continue;
    const prevY = l.y;
    l.vy -= 24 * dt;
    l.x = clamp(l.x + l.vx * dt, -HALF + 1, HALF - 1);
    l.z = clamp(l.z + l.vz * dt, -HALF + 1, HALF - 1);
    l.y += l.vy * dt;
    const top = surfaceUnder(l.x, l.y, l.z, prevY);
    if (l.y <= top) {
      l.y = top;
      if (l.vy < -4) { l.vy *= -0.3; l.vx *= 0.45; l.vz *= 0.45; }   // one small bounce
      else { l.vy = 0; l.vx = 0; l.vz = 0; l.rest = true; }
    }
    const drag = Math.max(0, 1 - 1.8 * dt);
    l.vx *= drag; l.vz *= drag;
  }
}

// Healing is deliberately common: long fights only work if you can top up
// between them, the way you rotate out of a Fortnite fight to shield up.
function randomLootAt(x, y, z, minRar) {
  const r = Math.random();
  if (r < 0.48) spawnWeaponLoot(x, y, z, rollWeapon(minRar));
  else if (r < 0.68) spawnAmmoLoot(x, y, z, pick(AMMO_TYPES), 40 + ((Math.random() * 3) | 0) * 15);
  else if (r < 0.88) spawnLoot('shield', x, y, z);
  else spawnLoot('medkit', x, y, z);
}

/* ------------------------------- map building ------------------------------ */

function tileHasPiece(gx, gz) {
  for (const t of ['f', 'r', 'c']) for (let gy = -1; gy <= 4; gy++) if (World.pieces.has(`${t}|${gx}|${gy}|${gz}`)) return true;
  for (let gy = -1; gy <= 4; gy++) {
    if (World.pieces.has(`w|${gx}|${gy}|${gz}|0`) || World.pieces.has(`w|${gx}|${gy}|${gz}|3`) ||
      World.pieces.has(`w|${gx}|${gy}|${gz + 1}|0`) || World.pieces.has(`w|${gx + 1}|${gy}|${gz}|3`)) return true;
  }
  return false;
}

// A simple house: perimeter walls per storey, a floor slab above, a ramp inside,
// a pyramid roof cap, furniture and a chest. All of it is real, destructible,
// harvestable build pieces on the absolute grid; gy0 is the plateau's storey.
function buildHouse(gx0, gz0, w, d, storeys, mat, gy0) {
  const gy = s => gy0 + s;
  for (let s = 0; s < storeys; s++) {
    for (let ix = 0; ix < w; ix++) {
      for (let iz = 0; iz < d; iz++) {
        const gx = gx0 + ix, gz = gz0 + iz;
        if (s > 0) addPiece('floor', gx, gy(s), gz, 0, mat, null);
        if (iz === 0) addPiece('wall', ...normalizeWall(gx, gy(s), gz, 0), mat, null);
        if (iz === d - 1) addPiece('wall', ...normalizeWall(gx, gy(s), gz, 2), mat, null);
        if (ix === 0) addPiece('wall', ...normalizeWall(gx, gy(s), gz, 3), mat, null);
        if (ix === w - 1) addPiece('wall', ...normalizeWall(gx, gy(s), gz, 1), mat, null);
      }
    }
    // doorway on the front wall of the ground floor
    if (s === 0) {
      const door = World.pieces.get(pieceKey('wall', ...normalizeWall(gx0 + ((w / 2) | 0), gy(0), gz0, 0)));
      if (door) removePiece(door, true);
    }
    // ramp up to the next storey
    if (s < storeys - 1) addPiece('ramp', gx0 + w - 1, gy(s), gz0 + d - 1, 0, mat, null);
  }
  // roof
  for (let ix = 0; ix < w; ix++)
    for (let iz = 0; iz < d; iz++)
      addPiece(storeys > 1 && ix === 0 && iz === 0 ? 'cone' : 'floor', gx0 + ix, gy(storeys), gz0 + iz, 0, mat, null);

  // furniture on the ground floor, off the ramp tile and the doorway tile
  const floorY = gy0 * LEV;
  const spots = [];
  for (let ix = 0; ix < w; ix++) for (let iz = 0; iz < d; iz++) {
    if (storeys > 1 && ix === w - 1 && iz === d - 1) continue;
    if (iz === 0 && ix === ((w / 2) | 0)) continue;
    spots.push([ix, iz]);
  }
  const kinds = pick([['bed', 'cabinet'], ['table', 'chair', 'chair'], ['couch', 'lamp', 'rug'], ['cabinet', 'chair', 'rug']]);
  for (let i = 0; i < kinds.length && spots.length; i++) {
    const [ix, iz] = spots.splice((Math.random() * spots.length) | 0, 1)[0];
    const [cx, cz] = tileCenter(gx0 + ix, gz0 + iz);
    addProp(kinds[i], cx + rnd(-0.8, 0.8), cz + rnd(-0.8, 0.8), { y: floorY, rot: pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]) });
  }
  const [cx, cz] = tileCenter(gx0 + ((w / 2) | 0), gz0 + ((d / 2) | 0));
  World.chests.push({ x: cx, y: floorY, z: cz, rot: rnd(0, Math.PI * 2), opened: false, t: Math.random() * 6 });
}

const POI_NAMES = {
  town: ['Tilted Town', 'Retail Row', 'Pleasant Park', 'Salty Springs', 'Greasy Grove', 'Lazy Lake'],
  farm: ['Fatal Fields', 'Frenzy Farm', 'Corny Complex', 'Anarchy Acres'],
  spacebase: ['Dusty Depot', 'The Launch Pad', 'Rocket Ridge'],
  graveyard: ['Haunted Hills', 'Wailing Woods'],
  camp: ['Lonely Lodge', 'Camp Cod', 'Misty Meadows'],
};
const POI_THEMES = ['town', 'town', 'farm', 'spacebase', 'graveyard', 'town', 'camp', 'farm', 'town', 'spacebase', 'graveyard', 'camp', 'farm'];

// Try a few random spots within `r` of (cx, cz) for a prop: not inside a house,
// not on a road (unless allowed), not on top of another prop.
function scatterProp(kind, cx, cz, r, opts) {
  const o = opts || {};
  for (let attempt = 0; attempt < 6; attempt++) {
    const a = rnd(0, Math.PI * 2), d = o.ring ? rnd(r * 0.7, r) : Math.sqrt(Math.random()) * r;
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    if (Math.abs(x) > HALF - 6 || Math.abs(z) > HALF - 6) continue;
    const gx = Math.floor(x / GRID), gz = Math.floor(z / GRID);
    if (tileHasPiece(gx, gz)) continue;
    if (!o.onRoad && nearRoad(x, z, o.roadGap || 5)) continue;
    const gap = o.gap || 1.5;
    if (queryBoxes(x - gap, -100, z - gap, x + gap, 300, z + gap, _q).length) continue;
    return addProp(kind, x, z, o);
  }
  return null;
}

function placeHouse(px, pz, gy0, mat, storeys) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const ox = px + rnd(-28, 28), oz = pz + rnd(-28, 28);
    const gx = Math.round(ox / GRID), gz = Math.round(oz / GRID);
    const w = 2 + ((Math.random() * 2) | 0), d = 2 + ((Math.random() * 2) | 0);
    if (!inMap(gx - 1, gz - 1) || !inMap(gx + w + 1, gz + d + 1)) continue;
    let clash = false;
    for (let ix = -1; ix <= w && !clash; ix++) for (let iz = -1; iz <= d; iz++) if (tileHasPiece(gx + ix, gz + iz)) { clash = true; break; }
    if (clash) continue;
    // keep houses off the road through the middle of the POI
    const [hx, hz] = tileCenter(gx + (w >> 1), gz + (d >> 1));
    if (nearRoad(hx, hz, 7)) continue;
    buildHouse(gx, gz, w, d, storeys, mat, gy0);
    return true;
  }
  return false;
}

function buildPOI(poi) {
  const px = poi.x, pz = poi.z, gy0 = Math.round(poi.y / LEV), th = poi.theme;
  const chests = n => { for (let c = 0; c < n; c++) { const x = px + rnd(-34, 34), z = pz + rnd(-34, 34); World.chests.push({ x, y: terrainHeight(x, z), z, rot: rnd(0, Math.PI * 2), opened: false, t: Math.random() * 6 }); } };
  const loot = n => { for (let l = 0; l < n; l++) { const x = px + rnd(-34, 34), z = pz + rnd(-34, 34); randomLootAt(x, terrainHeight(x, z) + 0.5, z); } };
  if (th === 'town') {
    const houses = 4 + ((Math.random() * 3) | 0);
    for (let h = 0; h < houses; h++) placeHouse(px, pz, gy0, Math.random() < 0.6 ? MAT_BRICK : MAT_WOOD, Math.random() < 0.5 ? 2 : 1);
    for (let c = 0; c < 5; c++) scatterProp('car', px, pz, 36, { onRoad: true, gap: 2.8 });
    for (let c = 0; c < 6; c++) scatterProp('streetlight', px, pz, 30, { ring: true, onRoad: true, gap: 1, rot: pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]) });
    for (let c = 0; c < 3; c++) scatterProp('bench', px, pz, 26, { onRoad: true, rot: pick([0, Math.PI / 2]) });
    for (let c = 0; c < 2; c++) scatterProp('dumpster', px, pz, 30, { onRoad: true, rot: pick([0, Math.PI / 2]) });
    for (let c = 0; c < 3; c++) scatterProp('hydrant', px, pz, 30, { onRoad: true, gap: 0.8 });
    for (let c = 0; c < 5; c++) scatterProp('trash', px, pz, 30, { onRoad: true, gap: 0.8 });
    for (let c = 0; c < 3; c++) scatterProp('box', px, pz, 32, { onRoad: true });
    for (let c = 0; c < 4; c++) scatterProp('cone', px, pz, 30, { onRoad: true, gap: 0.6 });
    for (let c = 0; c < 3; c++) scatterProp('barrier', px, pz, 30, { onRoad: true, gap: 1, rot: pick([0, Math.PI / 2]) });
    for (let c = 0; c < 2; c++) scatterProp('container_z', px, pz, 34, { gap: 3, rot: pick([0, Math.PI / 2]) });
    for (let c = 0; c < 3; c++) scatterProp('drum', px, pz, 30, { onRoad: true, gap: 0.8 });
    for (let c = 0; c < 2; c++) scatterProp('wheels', px, pz, 30, { onRoad: true, gap: 0.8 });
    scatterProp('pipes', px, pz, 30, { gap: 2 });
    scatterProp('couch_z', px, pz, 28, { onRoad: true, gap: 1.5, rot: rnd(0, 6.3) });
    scatterProp('townsign', px, pz, 30, { ring: true, onRoad: true, gap: 3, rot: pick([0, Math.PI / 2]) });
    if (Math.random() < 0.7) scatterProp('watertower', px, pz, 34, { ring: true, gap: 4 });
    for (let c = 0; c < 2; c++) scatterProp('trafficlight', px, pz, 14, { onRoad: true, gap: 1, rot: pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]) });
    chests(3); loot(8);
  } else if (th === 'farm') {
    for (let h = 0; h < 3; h++) placeHouse(px, pz, gy0, MAT_WOOD, Math.random() < 0.35 ? 2 : 1);
    for (let c = 0; c < 8; c++) scatterProp('fence', px, pz, 34, { rot: pick([0, Math.PI / 2]), gap: 1 });
    for (let c = 0; c < 5; c++) scatterProp('barrel', px, pz, 30, { gap: 1 });
    for (let c = 0; c < 5; c++) scatterProp('box', px, pz, 30, { gap: 1 });
    for (let c = 0; c < 3; c++) scatterProp('lumber', px, pz, 30, { rot: pick([0, Math.PI / 2]) });
    for (let c = 0; c < 2; c++) scatterProp('stone', px, pz, 30, {});
    for (let c = 0; c < 2; c++) scatterProp('wheelbarrow', px, pz, 30, { rot: rnd(0, 6.3) });
    for (let c = 0; c < 4; c++) scatterProp('sack', px, pz, 26, { gap: 0.8 });
    for (let c = 0; c < 2; c++) scatterProp('tent', px, pz, 32, { rot: rnd(0, 6.3), gap: 2.5 });
    for (let c = 0; c < 2; c++) scatterProp('log', px, pz, 32, {});
    for (let c = 0; c < 2; c++) scatterProp('car', px, pz, 34, { gap: 2.5 });
    for (let c = 0; c < 5; c++) scatterProp('tree', px, pz, 36, { ring: true, gap: 2 });
    chests(3); loot(7);
  } else if (th === 'spacebase') {
    for (let h = 0; h < 2; h++) placeHouse(px, pz, gy0, MAT_METAL, 1);
    scatterProp('landingpad', px, pz, 10, { onRoad: true, gap: 6 });
    scatterProp('ship', px, pz, 12, { onRoad: true, gap: 5, rot: rnd(0, 6.3) });
    scatterProp('dome', px, pz, 30, { gap: 5 });
    for (let c = 0; c < 3; c++) scatterProp('spacehouse', px, pz, 32, { rot: pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]), gap: 4 });
    for (let c = 0; c < 5; c++) scatterProp('container', px, pz, 34, { rot: pick([0, Math.PI / 2]), gap: 3 });
    for (let c = 0; c < 4; c++) scatterProp('cargo', px, pz, 32, { rot: pick([0, Math.PI / 2]), gap: 1.5 });
    for (let c = 0; c < 2; c++) scatterProp('turbine', px, pz, 38, { ring: true, gap: 2 });
    for (let c = 0; c < 5; c++) scatterProp('solar', px, pz, 34, { rot: pick([0, Math.PI / 2]), gap: 2 });
    for (let c = 0; c < 2; c++) scatterProp('radar', px, pz, 30, { gap: 1.5 });
    for (let c = 0; c < 3; c++) scatterProp('rover', px, pz, 32, { onRoad: true, gap: 3 });
    for (let c = 0; c < 2; c++) scatterProp('support', px, pz, 30, { rot: pick([0, Math.PI / 2]), gap: 1 });
    for (let c = 0; c < 5; c++) scatterProp('srock', px, pz, 38, { ring: true, gap: 3 });
    for (let c = 0; c < 7; c++) scatterProp('alien', px, pz, 36, { ring: true, gap: 2 });
    for (let c = 0; c < 4; c++) scatterProp('crate', px, pz, 30, { gap: 0.8 });
    chests(4); loot(8);
  } else if (th === 'graveyard') {
    placeHouse(px, pz, gy0, MAT_BRICK, 1);
    scatterProp('crypt', px, pz, 10, { onRoad: true, gap: 4, rot: pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]) });
    scatterProp('arch_gate', px, pz, 30, { ring: true, gap: 3, rot: pick([0, Math.PI / 2]) });
    for (let c = 0; c < 16; c++) scatterProp('grave', px, pz, 30, { rot: pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]), gap: 1 });
    for (let c = 0; c < 6; c++) scatterProp('tree_dead', px, pz, 36, { gap: 2 });
    for (let c = 0; c < 10; c++) scatterProp('fence_iron', px, pz, 34, { ring: true, rot: pick([0, Math.PI / 2]), gap: 1 });
    for (let c = 0; c < 5; c++) scatterProp('lantern', px, pz, 30, { gap: 0.8 });
    for (let c = 0; c < 5; c++) scatterProp('pumpkin', px, pz, 30, { gap: 0.6 });
    chests(4); loot(7);
  } else {   // camp
    placeHouse(px, pz, gy0, MAT_WOOD, 1);
    for (let c = 0; c < 4; c++) scatterProp('tent', px, pz, 26, { rot: rnd(0, 6.3), gap: 2.5 });
    for (let c = 0; c < 4; c++) scatterProp('log', px, pz, 30, {});
    for (let c = 0; c < 4; c++) scatterProp('box', px, pz, 30, { gap: 1 });
    for (let c = 0; c < 3; c++) scatterProp('barrel', px, pz, 30, { gap: 1 });
    for (let c = 0; c < 4; c++) scatterProp('lantern', px, pz, 26, { variant: 1, gap: 0.8 });
    for (let c = 0; c < 10; c++) scatterProp('tree', px, pz, 38, { ring: true, gap: 2 });
    for (let c = 0; c < 2; c++) scatterProp('car', px, pz, 34, { gap: 2.5 });
    chests(3); loot(7);
  }
}

function generateWorld() {
  World.reset();
  seedTerrain();

  // POIs first: each one stamps a flat plateau into the heightfield, at a height
  // that is a whole number of storeys so the build grid there is exactly level.
  const poiCount = 13;
  const used = {};
  for (let i = 0; i < poiCount; i++) {
    const a = (i / poiCount) * Math.PI * 2 + rnd(-0.25, 0.25);
    const rad = i === 0 ? 0 : rnd(90, HALF - 70);
    const px = Math.cos(a) * rad, pz = Math.sin(a) * rad;
    const py = Math.round(terrainHeight(px, pz) / LEV) * LEV;
    World.pads.push({ x: px, z: pz, r: 66, y: py });   // ~30m flat core, then a skirt
    const theme = POI_THEMES[i % POI_THEMES.length];
    used[theme] = (used[theme] || 0) + 1;
    const names = POI_NAMES[theme];
    World.pois.push({ x: px, z: pz, y: py, theme, name: names[(used[theme] - 1) % names.length], a });
  }
  _tbase.clear(); _tground.clear();   // pads change the field, so drop anything cached before them

  // roads: a ring through the outer POIs in angle order, plus spokes to the
  // centre; each road bends a little so it doesn't read as a ruler line
  const outer = World.pois.slice(1).sort((p, q) => p.a - q.a);
  const link = (p, q) => {
    const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
    const dx = q.x - p.x, dz = q.z - p.z, l = len2(dx, dz) || 1;
    const bend = rnd(-0.12, 0.12) * l;
    const bx = mx - dz / l * bend, bz = mz + dx / l * bend;
    World.roads.push([p.x, p.z, bx, bz], [bx, bz, q.x, q.z]);
  };
  for (let i = 0; i < outer.length; i++) link(outer[i], outer[(i + 1) % outer.length]);
  for (let i = 0; i < outer.length; i += 3) link(World.pois[0], outer[i]);

  for (const poi of World.pois) buildPOI(poi);

  // scatter: trees, rocks, bushes, logs — counts scale with the map area
  const farFromPOI = (x, z, r) => { for (const p of World.pois) if (dist2(x, z, p.x, p.z) < r * r) return false; return true; };
  for (let i = 0; i < 1500; i++) {
    const x = rnd(-HALF + 6, HALF - 6), z = rnd(-HALF + 6, HALF - 6);
    if (!farFromPOI(x, z, 34) || nearRoad(x, z, 6)) continue;
    addProp('tree', x, z, {});
  }
  for (let i = 0; i < 520; i++) {
    const x = rnd(-HALF + 6, HALF - 6), z = rnd(-HALF + 6, HALF - 6);
    if (nearRoad(x, z, 5)) continue;
    addProp('rock', x, z, { scale: rnd(0.7, 1.3) });
  }
  // ground cover: grass tufts and flowering plants, decoration only, drawn up close
  for (let i = 0; i < 2200; i++) {
    const x = rnd(-HALF + 6, HALF - 6), z = rnd(-HALF + 6, HALF - 6);
    if (nearRoad(x, z, 4)) continue;
    addProp('grass', x, z, { scale: rnd(0.8, 1.5) });
  }
  for (let i = 0; i < 700; i++) {
    const x = rnd(-HALF + 6, HALF - 6), z = rnd(-HALF + 6, HALF - 6);
    if (nearRoad(x, z, 4)) continue;
    addProp('bush', x, z, { scale: rnd(0.8, 1.4) });
  }
  for (let i = 0; i < 80; i++) {
    const x = rnd(-HALF + 6, HALF - 6), z = rnd(-HALF + 6, HALF - 6);
    if (!farFromPOI(x, z, 30) || nearRoad(x, z, 5)) continue;
    addProp('log', x, z, {});
  }
  for (let i = 0; i < 190; i++) {
    const x = rnd(-HALF + 10, HALF - 10), z = rnd(-HALF + 10, HALF - 10);
    randomLootAt(x, terrainHeight(x, z) + 0.5, z);
  }
  for (let i = 0; i < 55; i++) {
    const x = rnd(-HALF + 10, HALF - 10), z = rnd(-HALF + 10, HALF - 10);
    World.chests.push({ x, y: terrainHeight(x, z), z, rot: rnd(0, Math.PI * 2), opened: false, t: Math.random() * 6 });
  }

  return World.pois;
}

/* -------------------------------- collision -------------------------------- */

const ENT_R = 0.42, ENT_H = 1.85, EYE_H = 1.68;
const _q = [];

// Height of a ramp's slope surface at a world XZ point (or null if outside).
function rampHeightAt(p, x, z) {
  const [cx, cz] = tileCenter(p.gx, p.gz);
  const dx = x - cx, dz = z - cz;
  if (Math.abs(dx) > GRID / 2 || Math.abs(dz) > GRID / 2) return null;
  // rise direction for rot r: 0:-Z 1:-X 2:+Z 3:+X
  let proj;
  if (p.rot === 0) proj = -dz; else if (p.rot === 1) proj = -dx;
  else if (p.rot === 2) proj = dz; else proj = dx;
  const t = clamp((proj + GRID / 2) / GRID, 0, 1);
  return pieceY(p) + t * LEV;
}

// Push an entity out of anything it is already overlapping — a wall that was
// just built through it, a floor placed under its feet, a ramp or cone it ended
// up inside. This is Fortnite's "player push": you may build on a spot you are
// partly standing in, and the piece shoves you clear. The cheapest way out wins:
// a small lift onto the piece (a floor under you, the lip of a ramp) is always
// preferred; a wall pushes you to whichever side you are mostly on, and on a dead
// tie to the side behind you rather than through; a ramp or cone built on top of
// you lifts you onto it; dropping below a piece is only allowed when that still
// leaves you above the ground — never into the earth, which is what used to
// leave you buried under a cone and then wedged inside it.
function depenetrate(e) {
  const p = e.pos;
  const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
  for (let iter = 0; iter < 3; iter++) {
    queryBoxes(p[0] - ENT_R + 0.02, p[1] + 0.02, p[2] - ENT_R + 0.02, p[0] + ENT_R - 0.02, p[1] + ENT_H - 0.02, p[2] + ENT_R - 0.02, _q);
    const ground = terrainHeight(p[0], p[2]);
    let bestD = Infinity, bx = 0, by = 0, bz = 0, any = false;
    const consider = (d, dx, dy, dz) => { if (d < bestD) { bestD = d; bx = dx; by = dy; bz = dz; any = true; } };
    for (const c of _q) {
      if (c.noclip) continue;
      let up, under;
      if (c.slope) {
        const h = c.surf(c.ref, p[0], p[2]);
        if (h === null) continue;
        under = c.ref.type === 'cone' ? c.miny : h - c.deck;
        if (p[1] >= h - 0.01 || p[1] + ENT_H <= under + 0.01) continue;   // clear of the slab
        up = h - p[1];
      } else {
        up = c.maxy - p[1]; under = c.miny;
      }
      const down = (p[1] + ENT_H) - under;
      const px = c.maxx - (p[0] - ENT_R), nx = (p[0] + ENT_R) - c.minx;
      const pz = c.maxz - (p[2] - ENT_R), nz = (p[2] + ENT_R) - c.minz;
      // up onto it: a step is half price so a floor under your feet always lifts you
      consider(up <= (c.slope ? 1.3 : 1.0) ? up * 0.5 : up, 0, up, 0);
      // sideways, a near tie broken toward your back
      const TIE = 0.15;
      const tx = Math.abs(px - nx) < TIE, tz = Math.abs(pz - nz) < TIE;
      consider(px + (tx && fx > 0 ? TIE : 0), px, 0, 0);
      consider(nx + (tx && fx < 0 ? TIE : 0), -nx, 0, 0);
      consider(pz + (tz && fz > 0 ? TIE : 0), 0, 0, pz);
      consider(nz + (tz && fz < 0 ? TIE : 0), 0, 0, -nz);
      // down under it, only while that keeps you above the ground
      if (p[1] - down >= ground - 0.01) consider(down, 0, -down, 0);
    }
    if (!any) return iter > 0;
    p[0] += bx; p[1] += by; p[2] += bz;
    if (by > 0) { e.vel[1] = Math.max(0, e.vel[1]); e.grounded = true; }
    if (by < 0) e.vel[1] = Math.min(0, e.vel[1]);
  }
  return true;
}

// After a piece lands, anyone standing inside it is pushed clear (Fortnite's
// floor / cone push). Bots and the player alike.
function pushEntitiesOut(c) {
  for (const e of World.ents) {
    if (!e.alive) continue;
    const p = e.pos;
    if (p[0] + ENT_R <= c.minx || p[0] - ENT_R >= c.maxx || p[2] + ENT_R <= c.minz || p[2] - ENT_R >= c.maxz ||
      p[1] + ENT_H <= c.miny || p[1] >= c.maxy) continue;
    depenetrate(e);
  }
}

// Axis-separated AABB resolution with sub-stepping (no tunnelling however long
// the frame), a step-up for small ledges, walkable ramp / cone surfaces, solid
// ramp undersides, and a ground clamp. Mutates e.pos / e.vel.
function moveEntity(e, dt) {
  const p = e.pos, v = e.vel;
  const wasGrounded = !!e.grounded;
  depenetrate(e);
  const maxMove = Math.max(Math.abs(v[0] * dt), Math.abs(v[1] * dt), Math.abs(v[2] * dt));
  const steps = clamp(Math.ceil(maxMove / 0.3), 1, 10);
  const sdt = dt / steps;
  let landed = false;

  const stepAxis = (axis, delta) => {
    if (delta === 0) return;
    const before = p[axis];
    p[axis] += delta;
    queryBoxes(p[0] - ENT_R, p[1], p[2] - ENT_R, p[0] + ENT_R, p[1] + ENT_H, p[2] + ENT_R, _q);
    for (const c of _q) {
      if (c.noclip) continue;
      if (c.slope) {
        const h = c.surf(c.ref, p[0], p[2]);
        if (h === null) continue;
        const under = c.ref.type === 'cone' ? c.miny : h - c.deck;
        if (axis === 1) {
          // ramp deck / cone body from below: a solid ceiling
          if (delta > 0 && before + ENT_H <= under + 0.02 && p[1] + ENT_H > under) { p[1] = under - ENT_H; v[1] = 0; }
          continue;
        }
        // From the side or from underneath the slab is solid too: unless you can
        // step onto its surface here, or you fit under it, the move is refused.
        // This is what stops you walking under a ramp and popping up through the
        // deck where it comes down to head height.
        if (p[1] >= h - STEP_UP || p[1] + ENT_H <= under + 0.02) continue;
        p[axis] = before; v[axis] = 0;
        continue;
      }
      if (axis === 0 || axis === 2) {
        // a ledge no higher than a step: walk up onto it instead of stopping
        const lift = c.maxy - p[1];
        if (lift > 0 && lift <= STEP_UP && (wasGrounded || landed) && v[1] <= 0.5) {
          queryBoxes(p[0] - ENT_R, c.maxy + 0.01, p[2] - ENT_R, p[0] + ENT_R, c.maxy + ENT_H, p[2] + ENT_R, _q2);
          let blocked = false;
          for (const o of _q2) if (!o.slope && !o.noclip) { blocked = true; break; }
          if (!blocked) { p[1] = c.maxy; v[1] = 0; landed = true; continue; }
        }
        if (axis === 0) { if (delta > 0) p[0] = Math.min(p[0], c.minx - ENT_R); else p[0] = Math.max(p[0], c.maxx + ENT_R); v[0] = 0; }
        else { if (delta > 0) p[2] = Math.min(p[2], c.minz - ENT_R); else p[2] = Math.max(p[2], c.maxz + ENT_R); v[2] = 0; }
      } else {
        if (delta > 0) { p[1] = Math.min(p[1], c.miny - ENT_H); v[1] = Math.min(v[1], 0); }
        else { p[1] = Math.max(p[1], c.maxy); v[1] = 0; landed = true; }
      }
    }
  };
  e.grounded = false;
  for (let s = 0; s < steps; s++) {
    stepAxis(0, v[0] * sdt);
    stepAxis(2, v[2] * sdt);
    stepAxis(1, v[1] * sdt);
  }
  if (landed) e.grounded = true;

  // ramps and cones act as walkable ground rather than solid boxes
  queryBoxes(p[0] - ENT_R, p[1] - 1.2, p[2] - ENT_R, p[0] + ENT_R, p[1] + ENT_H, p[2] + ENT_R, _q);
  let best = -Infinity;
  for (const c of _q) {
    if (!c.slope) continue;
    const h = c.surf(c.ref, p[0], p[2]);
    if (h === null) continue;
    if (h <= p[1] + STEP_UP && h > best) best = h;
  }
  e.onRamp = false;
  if (best > -Infinity && v[1] <= 0.01 && p[1] <= best + STEP_UP) {
    p[1] = best; v[1] = 0; e.grounded = true; e.onRamp = true;
  }
  p[0] = clamp(p[0], -HALF + 1, HALF - 1);
  p[2] = clamp(p[2], -HALF + 1, HALF - 1);
  const g = terrainHeight(p[0], p[2]);
  if (p[1] <= g) { p[1] = g; v[1] = 0; e.grounded = true; }
}
const _q2 = [];

/* -------------------------------- raycasting ------------------------------- */

function rayAABB(ox, oy, oz, dx, dy, dz, c, maxT) {
  let t0 = 0, t1 = maxT;
  const lo = [c.minx, c.miny, c.minz], hi = [c.maxx, c.maxy, c.maxz];
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) { if (o[i] < lo[i] || o[i] > hi[i]) return -1; continue; }
    const inv = 1 / d[i];
    let a = (lo[i] - o[i]) * inv, b = (hi[i] - o[i]) * inv;
    if (a > b) { const tmp = a; a = b; b = tmp; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  return t0;
}

// Walk the XZ hash cells the ray passes through (2D DDA).
function forEachRayCell(ox, oz, dx, dz, maxT, cb) {
  let cx = Math.floor(ox / CELL), cz = Math.floor(oz / CELL);
  const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const dtX = Math.abs(dx) > 1e-8 ? Math.abs(CELL / dx) : Infinity;
  const dtZ = Math.abs(dz) > 1e-8 ? Math.abs(CELL / dz) : Infinity;
  let tX = Math.abs(dx) > 1e-8 ? ((dx > 0 ? (cx + 1) * CELL - ox : ox - cx * CELL) / Math.abs(dx)) : Infinity;
  let tZ = Math.abs(dz) > 1e-8 ? ((dz > 0 ? (cz + 1) * CELL - oz : oz - cz * CELL) / Math.abs(dz)) : Infinity;
  let t = 0, guard = 0;
  while (t <= maxT && guard++ < 400) {
    cb(cx, cz);
    if (tX < tZ) { t = tX; cx += stepX; tX += dtX; } else { t = tZ; cz += stepZ; tZ += dtZ; }
  }
}

// Nearest static hit along a ray. Ramps and cones get sampled along their
// surface so you can shoot over a ramp and under its deck.
function rayWorld(ox, oy, oz, dx, dy, dz, maxT) {
  let bestT = maxT, bestC = null;
  _stamp++;
  forEachRayCell(ox, oz, dx, dz, maxT, (cx, cz) => {
    const arr = World.hash.get(hashKey(cx, cz));
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      if (c.dead || c.stamp === _stamp) continue;
      c.stamp = _stamp;
      let t = rayAABB(ox, oy, oz, dx, dy, dz, c, bestT);
      if (t < 0) continue;
      if (c.slope) {
        // A ramp is a thin deck, a cone a solid pyramid: march the ray through
        // the tile and only hit inside the solid band, or where it crosses the
        // surface between two samples. Passing under a ramp misses it entirely.
        let hit = -1, prevAbove = null;
        const under0 = c.ref.type === 'cone' ? c.miny : -Infinity;
        for (let s = 0; s < 26; s++) {
          const tt = t + s * (GRID / 16);
          if (tt > bestT) break;
          const px = ox + dx * tt, py = oy + dy * tt, pz = oz + dz * tt;
          if (px < c.minx || px > c.maxx || pz < c.minz || pz > c.maxz) break;
          const h = c.surf(c.ref, px, pz);
          if (h === null) break;
          const above = py > h;
          if (!above && py >= Math.max(h - c.deck, under0)) { hit = tt; break; }
          if (prevAbove !== null && above !== prevAbove) { hit = tt; break; }
          prevAbove = above;
        }
        if (hit < 0) continue;
        t = hit;
      }
      if (t < bestT) { bestT = t; bestC = c; }
    }
  });
  // hills block bullets and sight lines too
  const tg = rayTerrain(ox, oy, oz, dx, dy, dz, bestT);
  if (tg >= 0 && tg < bestT) { bestT = tg; bestC = TERRAIN_COL; }
  return bestC ? { t: bestT, col: bestC } : null;
}

function losClear(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = len3(dx, dy, dz);
  if (len < 0.001) return true;
  const h = rayWorld(ax, ay, az, dx / len, dy / len, dz / len, len - 0.2);
  return !h;
}
