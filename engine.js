'use strict';
/* =============================================================================
   fortnite-lite / engine.js
   Zero-dependency engine: mat4 math, WebGL2 renderer, input, audio.

   Rendering in one paragraph: everything is either an *instanced procedural
   mesh* (cube, ramp, pyramid, cylinder, sphere, tube — optionally wearing a
   tiled material texture), an *instanced glTF prop*, a *skinned glTF character*
   or the *terrain*. Every opaque thing is drawn twice a frame: once into a
   directional shadow map, once to the screen under a sky dome. See CONTEXT.md.
   ============================================================================= */

/* ------------------------------- math -------------------------------------- */

function mat4() { return new Float32Array(16); }

function m4Perspective(o, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  o.fill(0);
  o[0] = f / aspect; o[5] = f; o[10] = (far + near) * nf; o[11] = -1; o[14] = 2 * far * near * nf;
  return o;
}

function m4Ortho(o, l, r, b, t, n, f) {
  o.fill(0);
  o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = -2 / (f - n);
  o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = -(f + n) / (f - n); o[15] = 1;
  return o;
}

// View matrix for a camera at (px,py,pz) with yaw (Y) then pitch (X).
function m4View(o, px, py, pz, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const a00 = cy, a01 = 0, a02 = -sy;
  const a10 = sp * sy, a11 = cp, a12 = sp * cy;
  const a20 = cp * sy, a21 = -sp, a22 = cp * cy;
  o[0] = a00; o[1] = a10; o[2] = a20; o[3] = 0;
  o[4] = a01; o[5] = a11; o[6] = a21; o[7] = 0;
  o[8] = a02; o[9] = a12; o[10] = a22; o[11] = 0;
  o[12] = -(a00 * px + a01 * py + a02 * pz);
  o[13] = -(a10 * px + a11 * py + a12 * pz);
  o[14] = -(a20 * px + a21 * py + a22 * pz);
  o[15] = 1;
  return o;
}

// Look-at view matrix (used for the shadow-casting light).
function m4LookAt(o, ex, ey, ez, tx, ty, tz, ux, uy, uz) {
  let zx = ex - tx, zy = ey - ty, zz = ez - tz;
  let l = len3(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  l = len3(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
  o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
  o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
  o[12] = -(xx * ex + xy * ey + xz * ez);
  o[13] = -(yx * ex + yy * ey + yz * ez);
  o[14] = -(zx * ex + zy * ey + zz * ez);
  o[15] = 1;
  return o;
}

function m4Mul(o, a, b) { // o = a * b
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    o[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return o;
}

// o = translate(x,y,z) * rotY(yaw) * scale(s)   — the placement matrix for a
// character or any other rigid object.
function m4Place(o, x, y, z, yaw, s) {
  const c = Math.cos(yaw), si = Math.sin(yaw);
  o[0] = c * s; o[1] = 0; o[2] = -si * s; o[3] = 0;
  o[4] = 0; o[5] = s; o[6] = 0; o[7] = 0;
  o[8] = si * s; o[9] = 0; o[10] = c * s; o[11] = 0;
  o[12] = x; o[13] = y; o[14] = z; o[15] = 1;
  return o;
}

// Camera/world forward vector for a yaw/pitch pair.
function dirFrom(yaw, pitch, out) {
  const cp = Math.cos(pitch);
  out[0] = -Math.sin(yaw) * cp; out[1] = Math.sin(pitch); out[2] = -Math.cos(yaw) * cp;
  return out;
}

// Project a world point to screen pixels. Returns false if behind the camera.
function projectPoint(vp, x, y, z, W, H, out) {
  const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
  if (w <= 0.001) return false;
  const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
  const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
  out[0] = (cx / w * 0.5 + 0.5) * W;
  out[1] = (1 - (cy / w * 0.5 + 0.5)) * H;
  return true;
}

// Math.hypot guards against intermediate overflow, which costs several times a
// plain sqrt and buys nothing at world scale. These are the hot-path versions.
function len2(x, y) { return Math.sqrt(x * x + y * y); }
function len3(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

const TAU = Math.PI * 2;

// Shortest signed angle from `a` to `b`, always in (-PI, PI].
//
// JS `%` keeps the sign of the dividend, so the usual one-liner
// `((b - a + 3*PI) % TAU) - PI` is only correct while `b - a` stays above -3*PI.
// A yaw that is free to accumulate breaks that: turning left raises yaw without
// bound, and past about one and a half turns the wrap silently returns a value up
// to a full circle wrong — in one direction only. Do it with an explicit fold so
// the sign of the inputs cannot matter.
function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return d;
}

// Fold an angle into (-PI, PI]. Applied to yaw every frame so it can never drift
// far enough for precision — or the wrap above — to become a problem.
function wrapAngle(a) {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  else if (x < -Math.PI) x += TAU;
  return x;
}
function rnd(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
// Seedable RNG (mulberry32). Math.random is swapped for it while a match world
// is generated, so every client in a lobby builds the identical map from one seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function withSeed(seed, fn) {
  const saved = Math.random;
  Math.random = mulberry32(seed);
  try { return fn(); } finally { Math.random = saved; }
}

// Deterministic hash noise in [0,1) — for anything that has to look random but
// stay put from frame to frame (grass tufts, prop jitter).
function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* ------------------------------ geometry ----------------------------------- */
// Each mesh is a flat list of [px,py,pz, nx,ny,nz]. Culling is off, so winding
// never matters — only normals do.

function pushTri(v, ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz) {
  v.push(ax, ay, az, nx, ny, nz, bx, by, bz, nx, ny, nz, cx, cy, cz, nx, ny, nz);
}
function pushQuad(v, a, b, c, d, n) {
  pushTri(v, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], n[0], n[1], n[2]);
  pushTri(v, a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], n[0], n[1], n[2]);
}

function makeCube() {
  const v = [], h = 0.5;
  const P = (x, y, z) => [x * h, y * h, z * h];
  pushQuad(v, P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), [1, 0, 0]);
  pushQuad(v, P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), [-1, 0, 0]);
  pushQuad(v, P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1), [0, 1, 0]);
  pushQuad(v, P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), [0, -1, 0]);
  pushQuad(v, P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), [0, 0, 1]);
  pushQuad(v, P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), [0, 0, -1]);
  return v;
}

// Deck thickness of a ramp, as a fraction of the unit cube. world.js needs it to
// know how thin the slab is when a ray crosses it.
const RAMP_DECK = 0.18;

// A stair *deck*, not a solid wedge: a thin slab hugging the slope plane y = -z,
// high edge at z=-0.5, low at z=+0.5. The cross-section is a 4-point sliver in
// (z,y) extruded along X, so it stays strictly inside the unit cube and its top
// face lies exactly on the surface rampHeightAt() walks on. You can see, walk and
// shoot underneath it.
function makeRamp() {
  const v = [], h = 0.5, ty = RAMP_DECK;
  //            top-high   top-low    under-low       under-high
  const P = [[-h, h], [h, -h], [h - ty, -h], [-h, h - ty]];   // [z, y]
  const at = (x, i) => [x, P[i][1], P[i][0]];
  const s = 0.7071;
  pushQuad(v, at(-h, 0), at(h, 0), at(h, 1), at(-h, 1), [0, s, s]);      // walk surface
  pushQuad(v, at(-h, 3), at(h, 3), at(h, 2), at(-h, 2), [0, -s, -s]);    // underside
  pushQuad(v, at(-h, 1), at(h, 1), at(h, 2), at(-h, 2), [0, -1, 0]);     // lip at the low end
  pushQuad(v, at(-h, 3), at(h, 3), at(h, 0), at(-h, 0), [0, 0, -1]);     // lip at the high end
  pushQuad(v, at(-h, 0), at(-h, 1), at(-h, 2), at(-h, 3), [-1, 0, 0]);   // stringer, -X side
  pushQuad(v, at(h, 0), at(h, 1), at(h, 2), at(h, 3), [1, 0, 0]);        // stringer, +X side
  return v;
}

function makePyramid() {
  const v = [], h = 0.5;
  const a = [-h, -h, -h], b = [h, -h, -h], c = [h, -h, h], d = [-h, -h, h], t = [0, h, 0];
  pushQuad(v, a, b, c, d, [0, -1, 0]);
  const s = 0.7071;
  pushTri(v, a[0], a[1], a[2], b[0], b[1], b[2], t[0], t[1], t[2], 0, s, -s);
  pushTri(v, b[0], b[1], b[2], c[0], c[1], c[2], t[0], t[1], t[2], s, s, 0);
  pushTri(v, c[0], c[1], c[2], d[0], d[1], d[2], t[0], t[1], t[2], 0, s, s);
  pushTri(v, d[0], d[1], d[2], a[0], a[1], a[2], t[0], t[1], t[2], -s, s, 0);
  return v;
}

// Open cylinder, radius 1, y in [0,1] — used for the storm wall.
function makeCylinder(seg) {
  const v = [];
  for (let i = 0; i < seg; i++) {
    const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
    const x0 = Math.cos(a0), z0 = Math.sin(a0), x1 = Math.cos(a1), z1 = Math.sin(a1);
    pushTri(v, x0, 0, z0, x1, 0, z1, x1, 1, z1, x0, 0, z0);
    pushTri(v, x0, 0, z0, x1, 1, z1, x0, 1, z0, x0, 0, z0);
  }
  return v;
}

// Smooth-shaded unit-diameter sphere centred on the origin — balloons, potions,
// helmets, bullet impacts.
function makeSphere(seg, rings) {
  const v = [], r = 0.5;
  const P = (i, j) => {
    const th = j / rings * Math.PI, ph = i / seg * Math.PI * 2;
    const nx = Math.sin(th) * Math.cos(ph), ny = Math.cos(th), nz = Math.sin(th) * Math.sin(ph);
    return [nx * r, ny * r, nz * r, nx, ny, nz];
  };
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      v.push(a[0], a[1], a[2], a[3], a[4], a[5], b[0], b[1], b[2], b[3], b[4], b[5], c[0], c[1], c[2], c[3], c[4], c[5]);
      v.push(a[0], a[1], a[2], a[3], a[4], a[5], c[0], c[1], c[2], c[3], c[4], c[5], d[0], d[1], d[2], d[3], d[4], d[5]);
    }
  }
  return v;
}

// Capped cylinder along Z, diameter 1, z in [-0.5, 0.5] — barrels, scopes,
// magazines, lamp posts, bottle necks.
function makeTube(seg) {
  const v = [], r = 0.5, h = 0.5;
  for (let i = 0; i < seg; i++) {
    const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
    const x0 = Math.cos(a0), y0 = Math.sin(a0), x1 = Math.cos(a1), y1 = Math.sin(a1);
    // side, smooth normals
    v.push(x0 * r, y0 * r, -h, x0, y0, 0, x1 * r, y1 * r, -h, x1, y1, 0, x1 * r, y1 * r, h, x1, y1, 0);
    v.push(x0 * r, y0 * r, -h, x0, y0, 0, x1 * r, y1 * r, h, x1, y1, 0, x0 * r, y0 * r, h, x0, y0, 0);
    // caps
    pushTri(v, 0, 0, h, x0 * r, y0 * r, h, x1 * r, y1 * r, h, 0, 0, 1);
    pushTri(v, 0, 0, -h, x1 * r, y1 * r, -h, x0 * r, y0 * r, -h, 0, 0, -1);
  }
  return v;
}

/* ------------------------------ renderer ----------------------------------- */

const MESH_CUBE = 0, MESH_RAMP = 1, MESH_CONE = 2, MESH_CYL = 3, MESH_SPHERE = 4, MESH_TUBE = 5, MESH_COUNT = 6;
const INST_STRIDE = 20; // mat4 (16) + rgba (4)
const MAX_JOINTS = 64;
const FOLIAGE_MIX = 0.55;      // how far a leaf card's normal leans toward "up" (see FS_MAIN)
const ZERO3 = new Float32Array(3);
const SHADOW_SIZE = 2048;
const SHADOW_HALF = 62;        // metres each side of the shadow box centre

/* ------------------------------- shaders ----------------------------------- */
// One vertex layout for every instanced mesh: aPos/aNrm (+aUV for glTF props),
// a per-instance mat4 and rgba. The skinned program swaps the instance matrix
// for uModel * joint palette. All colour programs share FS_LIT below.

const VS_INST = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in mat4 aModel;
layout(location=6) in vec4 aColor;
#ifdef USE_UV
layout(location=7) in vec2 aUV;
#endif
uniform mat4 uVP;
out vec3 vN; out vec3 vWP; out vec4 vC; out vec2 vUV;
void main(){
  vec4 wp = aModel * vec4(aPos, 1.0);
  vN = mat3(aModel) * aNrm;
  vC = aColor; vWP = wp.xyz;
#ifdef USE_UV
  vUV = aUV;
#else
  vUV = vec2(0.0);
#endif
  gl_Position = uVP * wp;
}`;

const VS_SKIN = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=7) in vec2 aUV;
layout(location=8) in vec4 aJoints;
layout(location=9) in vec4 aWeights;
uniform mat4 uVP; uniform mat4 uModel; uniform vec4 uTint;
uniform mat4 uJoints[${MAX_JOINTS}];
out vec3 vN; out vec3 vWP; out vec4 vC; out vec2 vUV;
void main(){
  mat4 sk = aWeights.x * uJoints[int(aJoints.x)] + aWeights.y * uJoints[int(aJoints.y)]
          + aWeights.z * uJoints[int(aJoints.z)] + aWeights.w * uJoints[int(aJoints.w)];
  mat4 m = uModel * sk;
  vec4 wp = m * vec4(aPos, 1.0);
  vN = mat3(m) * aNrm; vC = uTint; vUV = aUV; vWP = wp.xyz;
  gl_Position = uVP * wp;
}`;

// Shared lighting: one warm sun with a PCF shadow map, hemispheric ambient
// (sky above, bounce below), a small Blinn highlight, and distance fog toward
// the horizon colour. Alpha < 1 renders unlit — storm wall, build ghost, beams.
const FS_LIT_HEAD = `
precision highp float;
precision highp sampler2DShadow;
in vec3 vN; in vec3 vWP; in vec4 vC; in vec2 vUV;
uniform vec3 uCam; uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uSkyCol; uniform vec3 uGndCol;
uniform vec3 uFogCol; uniform vec2 uFogP;
uniform mat4 uShadowVP; uniform sampler2DShadow uShadow; uniform float uShadowTexel; uniform float uShadowOn;
uniform float uSpec;
out vec4 outColor;

float shadowAt(vec3 wp, vec3 n, float ndl) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 sc = uShadowVP * vec4(wp + n * (0.06 + 0.12 * (1.0 - ndl)), 1.0);
  vec3 p = sc.xyz * 0.5 + 0.5;
  float edge = min(min(p.x, 1.0 - p.x), min(p.y, 1.0 - p.y));
  if (edge < 0.0 || p.z > 0.999) return 1.0;
  float s = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++)
    s += texture(uShadow, vec3(p.xy + vec2(float(x), float(y)) * uShadowTexel, p.z - 0.0009));
  return mix(1.0, s / 9.0, smoothstep(0.0, 0.05, edge));
}

vec3 shade(vec3 albedo, vec3 n, float spec) {
  float ndl = max(dot(n, uSunDir), 0.0);
  float sh = shadowAt(vWP, n, ndl);
  vec3 amb = mix(uGndCol, uSkyCol, n.y * 0.5 + 0.5);
  vec3 V = normalize(uCam - vWP);
  vec3 H = normalize(uSunDir + V);
  float sp = pow(max(dot(n, H), 0.0), 36.0) * spec * sh * ndl;
  return albedo * (amb + uSunCol * ndl * sh) + uSunCol * sp;
}

vec3 fogged(vec3 col) {
  float d = length(vWP - uCam);
  float f = clamp((d - uFogP.x) * uFogP.y, 0.0, 1.0);
  f = f * f * (3.0 - 2.0 * f);
  return mix(col, uFogCol, f * 0.93);
}`;

// uTexMode 1 = a glTF part: UV-mapped, alpha-tested at uCutoff (leaf cards),
// lit on both sides (the normal is flipped on back faces), uFoliage softens the
// normal toward "up" so a canopy reads as one volume, uEmis adds unlit light
// (brake lights, lanterns). Mode 2 = triplanar material, 0 = flat colour.
const FS_MAIN = FS_LIT_HEAD + `
uniform sampler2D uTex; uniform float uTexMode; uniform float uTexScale; uniform vec4 uBase; uniform float uCutoff;
uniform vec3 uEmis; uniform float uFoliage;

vec3 triplanar(vec3 wp, vec3 n) {
  vec3 an = abs(n);
  vec2 uv = (an.y >= an.x && an.y >= an.z) ? wp.xz : (an.x > an.z ? wp.zy : wp.xy);
  return texture(uTex, uv * uTexScale).rgb;
}

void main(){
  vec3 n = normalize(vN);
  vec4 albedo = vC * uBase;
  if (uTexMode > 1.5) albedo.rgb *= triplanar(vWP, n);
  else if (uTexMode > 0.5) {
    vec4 t = texture(uTex, vUV); if (t.a < uCutoff) discard; albedo *= t;
    if (!gl_FrontFacing) n = -n;
    if (uFoliage > 0.0) n = normalize(mix(n, vec3(0.0, 1.0, 0.0), uFoliage));
  }
  vec3 col = (albedo.a < 0.999) ? albedo.rgb * 1.15 : shade(albedo.rgb, n, uSpec) + uEmis;
  outColor = vec4(fogged(col), albedo.a);
}`;

// Terrain: grass with two-scale tiling and macro hue variation, dirt/road from
// a per-match splat map, rock on anything steep, and a height tint so valleys
// read darker and richer than ridges.
const FS_TERRAIN = FS_LIT_HEAD + `
uniform sampler2D uGrass; uniform sampler2D uRock; uniform sampler2D uDirt; uniform sampler2D uNoise; uniform sampler2D uSplat;
uniform float uHalf; uniform vec2 uHeightRange;
void main(){
  vec3 n = normalize(vN);
  vec2 uv = vWP.xz * 0.21;
  vec3 macro = texture(uNoise, vWP.xz * 0.0085).rgb;
  vec3 grass = mix(texture(uGrass, uv).rgb, texture(uGrass, vWP.xz * 0.047 + 3.7).rgb, 0.4);
  grass *= mix(vec3(0.84, 0.96, 0.66), vec3(1.06, 1.0, 0.94), macro.r);
  float hk = clamp((vWP.y - uHeightRange.x) / max(uHeightRange.y - uHeightRange.x, 1.0), 0.0, 1.0);
  grass *= mix(vec3(0.74, 0.86, 0.74), vec3(1.10, 1.06, 0.84), hk);
  vec3 rock = texture(uRock, uv * 0.7).rgb * mix(0.85, 1.1, macro.b);
  vec3 dirt = texture(uDirt, uv * 1.3).rgb;
  vec4 sp = texture(uSplat, (vWP.xz + uHalf) / (2.0 * uHalf));
  vec3 col = mix(grass, dirt, sp.r);
  float slope = 1.0 - n.y;
  float rk = smoothstep(0.17, 0.36, slope + (macro.g - 0.5) * 0.14);
  col = mix(col, rock, rk);
  outColor = vec4(fogged(shade(col, n, 0.04)), 1.0);
}`;

// Sky dome drawn as one full-screen triangle behind everything: a horizon →
// zenith gradient, a sun disc with glow, and two layers of drifting fbm clouds.
const VS_SKY = `
out vec2 vNdc;
void main(){
  vec2 v[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  vNdc = v[gl_VertexID];
  gl_Position = vec4(vNdc, 0.99999, 1.0);
}`;
const FS_SKY = `
precision highp float;
in vec2 vNdc;
uniform vec3 uCamF; uniform vec3 uCamR; uniform vec3 uCamU; uniform float uTanH; uniform float uAspect;
uniform vec3 uSunDir; uniform float uTime; uniform sampler2D uNoise;
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uFogCol;
out vec4 outColor;
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += texture(uNoise, p).r * a; p = p * 2.03 + 17.1; a *= 0.5; } return s; }
void main(){
  vec3 ray = normalize(uCamF + uCamR * vNdc.x * uTanH * uAspect + uCamU * vNdc.y * uTanH);
  float t = ray.y;
  vec3 col = t > 0.0 ? mix(uHorizon, uZenith, pow(t, 0.6)) : mix(uHorizon, uGround, clamp(-t * 5.0, 0.0, 1.0));
  float sd = max(dot(ray, uSunDir), 0.0);
  col += vec3(1.0, 0.93, 0.80) * (pow(sd, 1400.0) * 1.4 + pow(sd, 10.0) * 0.16 + pow(sd, 2.0) * 0.05);
  if (t > 0.01) {
    vec2 p = ray.xz / (t + 0.10);
    float n1 = fbm(p * 0.012 + uTime * 0.0022);
    float n2 = fbm(p * 0.030 + 5.0 - uTime * 0.0031);
    float c = smoothstep(0.47, 0.66, n1) * 0.95 + smoothstep(0.56, 0.76, n2) * 0.45;
    float fade = smoothstep(0.01, 0.22, t);
    vec3 cloud = mix(vec3(0.86, 0.88, 0.94), vec3(1.0), smoothstep(0.55, 0.9, n1));
    col = mix(col, cloud, clamp(c, 0.0, 1.0) * fade);
  }
  // haze toward the fog colour at the horizon so terrain fades into the sky
  col = mix(uFogCol, col, smoothstep(-0.02, 0.10, t));
  outColor = vec4(col, 1.0);
}`;

// The cutout variant (USE_UV) carries the UV through so leaf cards cast leaf-shaped
// shadows instead of quad-shaped ones.
const VS_DEPTH_INST = `
layout(location=0) in vec3 aPos;
layout(location=2) in mat4 aModel;
#ifdef USE_UV
layout(location=7) in vec2 aUV;
out vec2 vUV;
#endif
uniform mat4 uVP;
void main(){
#ifdef USE_UV
  vUV = aUV;
#endif
  gl_Position = uVP * aModel * vec4(aPos, 1.0);
}`;
const FS_DEPTH_CUT = `precision mediump float; in vec2 vUV; uniform sampler2D uTex; void main(){ if (texture(uTex, vUV).a < 0.5) discard; }`;
const VS_DEPTH_SKIN = `
layout(location=0) in vec3 aPos;
layout(location=8) in vec4 aJoints;
layout(location=9) in vec4 aWeights;
uniform mat4 uVP; uniform mat4 uModel;
uniform mat4 uJoints[${MAX_JOINTS}];
void main(){
  mat4 sk = aWeights.x * uJoints[int(aJoints.x)] + aWeights.y * uJoints[int(aJoints.y)]
          + aWeights.z * uJoints[int(aJoints.z)] + aWeights.w * uJoints[int(aJoints.w)];
  gl_Position = uVP * uModel * sk * vec4(aPos, 1.0);
}`;
const FS_DEPTH = `precision mediump float; void main(){}`;

function growable(n) { return { a: new Float32Array(n * INST_STRIDE), n: 0 }; }
function growNeed(b) {
  if (b.n + INST_STRIDE > b.a.length) {
    const na = new Float32Array(b.a.length * 2);
    na.set(b.a); b.a = na;
  }
}

class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is required (try Chrome / Firefox / Safari 15+).');
    this.gl = gl; this.canvas = canvas;

    // programs — {p, u:{name: location}}; samplers are pinned to fixed units once
    this.progFlat = this._program(VS_INST, FS_MAIN, '');
    this.progTex = this._program(VS_INST, FS_MAIN, '#define USE_UV\n');
    this.progSkin = this._program(VS_SKIN, FS_MAIN, '');
    this.progTerrain = this._program(VS_INST, FS_TERRAIN, '');
    this.progSky = this._program(VS_SKY, FS_SKY, '');
    this.progDepth = this._program(VS_DEPTH_INST, FS_DEPTH, '');
    this.progDepthCut = this._program(VS_DEPTH_INST, FS_DEPTH_CUT, '#define USE_UV\n');
    this.progDepthSkin = this._program(VS_DEPTH_SKIN, FS_DEPTH, '');
    const units = { uTex: 0, uShadow: 1, uGrass: 2, uRock: 3, uDirt: 4, uNoise: 5, uSplat: 6 };
    for (const P of [this.progFlat, this.progTex, this.progSkin, this.progTerrain, this.progSky, this.progDepthCut]) {
      gl.useProgram(P.p);
      for (const k in units) if (P.u[k] !== undefined) gl.uniform1i(P.u[k], units[k]);
    }
    gl.useProgram(null);

    // A 1x1 white texture keeps every sampler unit pointing at something complete.
    this.whiteTex = this.texture(new Uint8Array([255, 255, 255, 255]), { size: 1, repeat: false, mips: false });
    this.tex = { grass: this.whiteTex, rock: this.whiteTex, dirt: this.whiteTex, noise: this.whiteTex, splat: this.whiteTex };

    this.meshes = [];
    this.opaque = []; this.blend = [];
    // Models live outside `meshes` on purpose: setTerrain() truncates that array
    // back to the procedural meshes every match, which would take loaded props
    // with it.
    this.models = [];
    this.skinQueue = []; this.skinCount = 0;
    this._inst = new Float32Array(INST_STRIDE);
    const geo = [makeCube(), makeRamp(), makePyramid(), makeCylinder(48), makeSphere(18, 12), makeTube(16)];
    for (const g of geo) this._addMesh(g);
    this.terrainList = [];                 // terrain mesh entries, kept apart from `meshes`
    this.vp = mat4(); this.proj = mat4(); this.view = mat4();
    this.lightVP = mat4(); this._lv = mat4(); this._lp = mat4();

    // lighting + atmosphere — tuned for a bright, saturated midday look
    this.sun = new Float32Array([0.40, 0.76, 0.51]);
    this._normalize(this.sun);
    this.sunCol = [1.02, 0.96, 0.86];
    this.skyCol = [0.50, 0.58, 0.72];
    this.gndCol = [0.30, 0.29, 0.25];
    this.fog = [0.70, 0.79, 0.90];
    this.fogStart = 170; this.fogRange = 520;
    this.zenith = [0.22, 0.46, 0.86]; this.horizon = [0.74, 0.84, 0.95]; this.ground = [0.55, 0.62, 0.70];
    this.shadowsOn = true; this.time = 0;

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this.camPos = new Float32Array(3);
    this._camF = new Float32Array(3); this._camR = new Float32Array(3); this._camU = new Float32Array(3);
    this._cfx = 0; this._cfz = -1; this._crx = 1; this._crz = 0;
    this._tanH = 2; this._secH = 2.5; this._tanV = 1; this._aspect = 1.78;
    this.drawCalls = 0; this.instances = 0;

    this._initShadow();
    this.skyVao = gl.createVertexArray();
  }

  _normalize(v) { const l = len3(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; }

  _program(vs, fs, defines) {
    const gl = this.gl;
    const c = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').slice(0, 6).join('\n'));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, c(gl.VERTEX_SHADER, '#version 300 es\n' + defines + vs));
    gl.attachShader(p, c(gl.FRAGMENT_SHADER, '#version 300 es\n' + defines + fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  /* ----------------------------- textures --------------------------------- */

  // Upload a canvas / ImageBitmap / Uint8Array as a texture. Repeat + mipmaps by
  // default, which is what tiled materials want.
  texture(src, opts) {
    const gl = this.gl, o = opts || {};
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (src instanceof Uint8Array) {
      const s = o.size || Math.sqrt(src.length / 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, s, s, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }
    const mips = o.mips !== false;
    if (mips) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, o.nearest ? gl.NEAREST : gl.LINEAR);
    const wrap = o.repeat === false ? gl.CLAMP_TO_EDGE : gl.REPEAT;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, o.wrapS || wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, o.wrapT || wrap);
    if (mips && o.aniso !== false) {
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (src && src.close) src.close();
    return t;
  }

  // Textures are uploaded verbatim, no sRGB decode: the rest of the game authors
  // colour as final output, and decoding only these would leave props darker than
  // everything they stand next to.
  // `key` (the image's URL, from models.js) shares one GPU texture between every
  // part that samples the same external file — a bark texture used by five tree
  // models is uploaded once.
  _texture(image, wrapS, wrapT, key) {
    if (!image) return null;
    const k = key ? key + '|' + (wrapS || 0) + '|' + (wrapT || 0) : null;
    const cache = this._texCache || (this._texCache = new Map());
    if (k && cache.has(k)) { if (image.close) image.close(); return cache.get(k); }
    const t = this.texture(image, { wrapS: wrapS || undefined, wrapT: wrapT || undefined });
    if (k) cache.set(k, t);
    return t;
  }

  setTerrainTextures(t) { Object.assign(this.tex, t); }
  // Per-match splat map (RGBA8, size×size): R = dirt/road weight.
  setSplat(data, size) {
    if (this.tex.splat && this.tex.splat !== this.whiteTex) this.gl.deleteTexture(this.tex.splat);
    this.tex.splat = this.texture(data, { size, repeat: false, mips: false });
  }
  setHeightRange(lo, hi) { this._hlo = lo; this._hhi = hi; }

  /* ------------------------------ shadows --------------------------------- */

  _initShadow() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, t, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.shadowTex = t; this.shadowFbo = fbo;
    if (!ok) { console.warn('[render] shadow framebuffer incomplete — shadows off'); this.shadowsOn = false; }
  }

  // Orthographic light box around the camera, ahead of it, snapped to shadow
  // texels so the shadow edges don't crawl as the camera moves.
  _updateLight() {
    const s = this.sun;
    // light-space basis
    let rx = s[2], ry = 0, rz = -s[0];                     // cross(up, sun)
    let l = len3(rx, ry, rz) || 1; rx /= l; rz /= l;
    const ux = s[1] * rz - s[2] * ry, uy = s[2] * rx - s[0] * rz, uz = s[0] * ry - s[1] * rx;   // cross(sun, right)
    let cx = this.camPos[0] + this._cfx * 34, cy = this.camPos[1], cz = this.camPos[2] + this._cfz * 34;
    const texel = (2 * SHADOW_HALF) / SHADOW_SIZE;
    const a = cx * rx + cy * ry + cz * rz, b = cx * ux + cy * uy + cz * uz;
    const da = Math.round(a / texel) * texel - a, db = Math.round(b / texel) * texel - b;
    cx += rx * da + ux * db; cy += ry * da + uy * db; cz += rz * da + uz * db;
    m4LookAt(this._lv, cx + s[0] * 230, cy + s[1] * 230, cz + s[2] * 230, cx, cy, cz, 0, 1, 0);
    m4Ortho(this._lp, -SHADOW_HALF, SHADOW_HALF, -SHADOW_HALF, SHADOW_HALF, 1, 520);
    m4Mul(this.lightVP, this._lp, this._lv);
  }

  /* ------------------------------- meshes --------------------------------- */

  _addMesh(verts) {
    const m = this._mesh(verts);
    this.meshes.push(m);
    this.opaque.push(growable(256));
    this.blend.push(growable(64));
    return this.meshes.length - 1;
  }

  // Another mesh id that shares a base mesh's geometry but wears a tiled
  // material texture (triplanar, world-space UVs) — how wood, brick and metal
  // build pieces get their look without any UV plumbing.
  addTextured(baseId, tex, texScale, spec) {
    const gl = this.gl, base = this.meshes[baseId];
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, base.vbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const ibo = this._instanceAttribs();
    gl.bindVertexArray(null);
    this.meshes.push({ vao, vbo: null, ibo, cap: 0, count: base.count, tex, texScale: texScale || 0.5, spec: spec || 0 });
    this.opaque.push(growable(256));
    this.blend.push(growable(32));
    return this.meshes.length - 1;
  }

  _instanceAttribs() {
    const gl = this.gl;
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ibo);
    const bytes = INST_STRIDE * 4;
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(2 + i);
      gl.vertexAttribPointer(2 + i, 4, gl.FLOAT, false, bytes, i * 16);
      gl.vertexAttribDivisor(2 + i, 1);
    }
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 4, gl.FLOAT, false, bytes, 64);
    gl.vertexAttribDivisor(6, 1);
    return ibo;
  }

  _mesh(verts) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts instanceof Float32Array ? verts : new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const ibo = this._instanceAttribs();
    gl.bindVertexArray(null);
    return { vao, vbo, ibo, cap: 0, count: verts.length / 6, tex: null, texScale: 1, spec: 0 };
  }

  // Replace the terrain. `bands` is a list of {verts} meshes (one is enough now
  // that the terrain shader does its own colouring); each becomes an entry drawn
  // as a single identity instance through the terrain program. They live in
  // their own list so a match reset can never take a material mesh with it.
  setTerrain(bands) {
    const gl = this.gl;
    for (const m of this.terrainList) { gl.deleteVertexArray(m.vao); gl.deleteBuffer(m.ibo); gl.deleteBuffer(m.vbo); }
    this.terrainList = [];
    for (const b of bands) {
      if (!b.verts.length) continue;
      const m = this._mesh(b.verts);
      m.bucket = growable(1); m.oc = 0;
      this.terrainList.push(m);
    }
  }

  drawTerrain() {
    for (const m of this.terrainList) {
      const b = m.bucket, o = b.n;
      b.a.fill(0, o, o + INST_STRIDE);
      b.a[o] = 1; b.a[o + 5] = 1; b.a[o + 10] = 1; b.a[o + 15] = 1;
      b.a[o + 16] = 1; b.a[o + 17] = 1; b.a[o + 18] = 1; b.a[o + 19] = 1;
      b.n = o + INST_STRIDE;
    }
  }

  /* ---------------------------- loaded models ------------------------------ */

  // Upload one parsed glTF (see models.js) and return a handle for pushModel().
  // Each material becomes one part = one VAO = one draw call per frame. A model
  // that carries a skin goes through addSkinned() instead.
  addModel(cpu) {
    if (cpu.skinned) return this.addSkinned(cpu);
    const gl = this.gl;
    const parts = [];
    let tris = 0;
    for (const p of cpu.parts) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, p.verts, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
      gl.enableVertexAttribArray(7); gl.vertexAttribPointer(7, 2, gl.FLOAT, false, 32, 24);
      const ebo = gl.createBuffer();                       // index binding is VAO state
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, p.idx, gl.STATIC_DRAW);
      const ibo = this._instanceAttribs();
      gl.bindVertexArray(null);
      tris += p.idx.length / 3;
      parts.push({
        vao, vbo, ibo, ebo, cap: 0, count: p.idx.length,
        tex: this._texture(p.image, p.wrapS, p.wrapT, p.imageKey),
        base: new Float32Array(p.color),
        cutout: !!p.cutout, emis: p.emissive || null, foliage: p.foliage ? FOLIAGE_MIX : 0,
        opaque: growable(64), blend: growable(16),
      });
    }
    const min = cpu.min, max = cpu.max;
    const model = {
      parts, tris, skinned: false,
      h: Math.max(max[1] - min[1], 1e-4),
      cx: (min[0] + max[0]) / 2, cz: (min[2] + max[2]) / 2, by: min[1],
      w: max[0] - min[0], d: max[2] - min[2],
      r: Math.max(max[0] - min[0], max[2] - min[2]) / 2,
    };
    this.models.push(model);
    return model;
  }

  // Skinned character: vertex = pos3 nrm3 uv2 joints4 weights4 (16 floats), one
  // non-instanced draw per part per character, joints as a uniform palette.
  addSkinned(cpu) {
    const gl = this.gl;
    const parts = [];
    let tris = 0;
    for (const p of cpu.parts) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, p.verts, gl.STATIC_DRAW);
      const S = 64;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, S, 12);
      gl.enableVertexAttribArray(7); gl.vertexAttribPointer(7, 2, gl.FLOAT, false, S, 24);
      gl.enableVertexAttribArray(8); gl.vertexAttribPointer(8, 4, gl.FLOAT, false, S, 32);
      gl.enableVertexAttribArray(9); gl.vertexAttribPointer(9, 4, gl.FLOAT, false, S, 48);
      const ebo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, p.idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      tris += p.idx.length / 3;
      parts.push({ vao, vbo, ebo, count: p.idx.length, tex: this._texture(p.image, p.wrapS, p.wrapT, p.imageKey), base: new Float32Array(p.color), cutout: !!p.cutout, emis: p.emissive || null, foliage: p.foliage ? FOLIAGE_MIX : 0 });
    }
    const min = cpu.min, max = cpu.max;
    const model = {
      parts, tris, skinned: true, rig: cpu.rig,
      h: Math.max(max[1] - min[1], 1e-4),
      cx: (min[0] + max[0]) / 2, cz: (min[2] + max[2]) / 2, by: min[1],
      w: max[0] - min[0], d: max[2] - min[2],
      r: Math.max(max[0] - min[0], max[2] - min[2]) / 2,
    };
    this.models.push(model);
    return model;
  }

  // Place a model with its base at y and its footprint centred on (x, z), scaled
  // so it stands `height` metres tall. r,g,b,a tint it (1,1,1,1 = as authored).
  pushModel(model, x, y, z, rotY, height, r, g, b, a) {
    if (!model || model.skinned) return;
    const s = height / model.h;
    const ca = Math.cos(rotY || 0), sa = Math.sin(rotY || 0);
    const m = this._inst;
    m[0] = ca * s; m[1] = 0; m[2] = -sa * s; m[3] = 0;
    m[4] = 0; m[5] = s; m[6] = 0; m[7] = 0;
    m[8] = sa * s; m[9] = 0; m[10] = ca * s; m[11] = 0;
    // Translation cancels the rotated, scaled offset of the model's own origin.
    m[12] = x - (ca * model.cx + sa * model.cz) * s;
    m[13] = y - model.by * s;
    m[14] = z - (ca * model.cz - sa * model.cx) * s;
    m[15] = 1;
    this._pushModelInst(model, m, r, g, b, a);
  }

  // Same, but with an arbitrary model matrix (the model's own origin is *not*
  // re-centred — build the matrix around model.cx/by/cz if that matters).
  pushModelXf(model, xf, r, g, b, a) {
    if (!model || model.skinned) return;
    const m = this._inst;
    for (let i = 0; i < 16; i++) m[i] = xf[i];
    this._pushModelInst(model, m, r, g, b, a);
  }

  _pushModelInst(model, m, r, g, b, a) {
    m[16] = r === undefined ? 1 : r; m[17] = g === undefined ? 1 : g;
    m[18] = b === undefined ? 1 : b; m[19] = a === undefined ? 1 : a;
    const toBlend = a !== undefined && a < 0.999;
    for (const p of model.parts) {
      const bucket = toBlend ? p.blend : p.opaque;
      growNeed(bucket);
      bucket.a.set(m, bucket.n);
      bucket.n += INST_STRIDE;
    }
  }

  // Queue a skinned character: `xf` places it, `joints` is the rig's palette
  // (MAX_JOINTS*16 floats at most) for this frame, r,g,b tints the texture.
  pushSkinned(model, xf, joints, r, g, b, a) {
    if (!model || !model.skinned) return;
    let q = this.skinQueue[this.skinCount];
    if (!q) { q = { model: null, xf: new Float32Array(16), joints: null, tint: new Float32Array(4) }; this.skinQueue[this.skinCount] = q; }
    q.model = model; q.xf.set(xf); q.joints = joints;
    q.tint[0] = r === undefined ? 1 : r; q.tint[1] = g === undefined ? 1 : g;
    q.tint[2] = b === undefined ? 1 : b; q.tint[3] = a === undefined ? 1 : a;
    this.skinCount++;
  }

  /* ------------------------------- frame ---------------------------------- */

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.floor(window.innerWidth * dpr), h = Math.floor(window.innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  begin(camX, camY, camZ, yaw, pitch, fov) {
    this.resize();
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this._aspect = this.canvas.width / this.canvas.height;
    m4Perspective(this.proj, fov, this._aspect, 0.08, 1400);
    m4View(this.view, camX, camY, camZ, yaw, pitch);
    m4Mul(this.vp, this.proj, this.view);
    this.camPos[0] = camX; this.camPos[1] = camY; this.camPos[2] = camZ;

    // camera basis for the sky shader
    dirFrom(yaw, pitch, this._camF);
    this._camR[0] = Math.cos(yaw); this._camR[1] = 0; this._camR[2] = -Math.sin(yaw);
    const F = this._camF, Rr = this._camR, U = this._camU;
    U[0] = Rr[1] * F[2] - Rr[2] * F[1]; U[1] = Rr[2] * F[0] - Rr[0] * F[2]; U[2] = Rr[0] * F[1] - Rr[1] * F[0];
    this._tanV = Math.tan(fov / 2);

    // Frustum for inView(): a vertical wedge around the camera's forward axis.
    // Pitch is deliberately ignored — culling on it would pop the ground and the
    // tops of builds in and out as you look up, and the horizontal test already
    // removes most of what is off screen.
    this._cfx = -Math.sin(yaw); this._cfz = -Math.cos(yaw);
    this._crx = Math.cos(yaw); this._crz = -Math.sin(yaw);
    // half-width of the view at unit depth, plus a margin so nothing pops at the edge
    this._tanH = Math.tan(fov / 2) * this._aspect * 1.15;
    this._secH = Math.sqrt(1 + this._tanH * this._tanH);   // 1/cos(halfFov)

    for (let i = 0; i < this.meshes.length; i++) { this.opaque[i].n = 0; this.blend[i].n = 0; }
    for (const m of this.terrainList) m.bucket.n = 0;
    for (const model of this.models) if (!model.skinned) for (const p of model.parts) { p.opaque.n = 0; p.blend.n = 0; }
    this.skinCount = 0;
    this.drawCalls = 0; this.instances = 0;
    this._updateLight();
  }

  // Is a ball of radius `r` at (x, ·, z) inside the horizontal view wedge, and
  // within `far` of the camera? One sqrt and a handful of multiplies — cheaper by
  // far than the instance it saves pushing, uploading and rasterising.
  inView(x, z, r, far) {
    const dx = x - this.camPos[0], dz = z - this.camPos[2];
    const d2 = dx * dx + dz * dz;
    if (far !== undefined && d2 > (far + r) * (far + r)) return false;
    const along = dx * this._cfx + dz * this._cfz;
    if (along < -r) return false;                       // fully behind
    if (d2 < r * r * 4) return true;                    // on top of the camera
    const side = Math.abs(dx * this._crx + dz * this._crz);
    return side <= along * this._tanH + r * this._secH;
  }

  // Push one instance. rotY/rotX are radians; sx/sy/sz are full sizes.
  push(mesh, x, y, z, rotY, rotX, sx, sy, sz, r, g, b, a) {
    const bucket = (a === undefined || a >= 0.999) ? this.opaque[mesh] : this.blend[mesh];
    growNeed(bucket);
    const m = bucket.a, o = bucket.n;
    // Most of a frame is axis-aligned — walls, floors, terrain, loot beacons — and
    // for those the rotation is the identity. Skipping the four trig calls there
    // takes them out of the hottest loop in the renderer entirely.
    if (rotY === 0 && rotX === 0) {
      m[o] = sx; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = sz; m[o + 11] = 0;
    } else {
      const ca = Math.cos(rotY), sa = Math.sin(rotY), cb = Math.cos(rotX), sb = Math.sin(rotX);
      m[o] = ca * sx; m[o + 1] = 0; m[o + 2] = -sa * sx; m[o + 3] = 0;
      m[o + 4] = sa * sb * sy; m[o + 5] = cb * sy; m[o + 6] = ca * sb * sy; m[o + 7] = 0;
      m[o + 8] = sa * cb * sz; m[o + 9] = -sb * sz; m[o + 10] = ca * cb * sz; m[o + 11] = 0;
    }
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    m[o + 16] = r; m[o + 17] = g; m[o + 18] = b; m[o + 19] = a === undefined ? 1 : a;
    bucket.n += INST_STRIDE;
  }

  // Push one instance with a full 4x4 model matrix (column-major).
  pushXf(mesh, xf, r, g, b, a) {
    const bucket = (a === undefined || a >= 0.999) ? this.opaque[mesh] : this.blend[mesh];
    growNeed(bucket);
    const m = bucket.a, o = bucket.n;
    for (let i = 0; i < 16; i++) m[o + i] = xf[i];
    m[o + 16] = r; m[o + 17] = g; m[o + 18] = b; m[o + 19] = a === undefined ? 1 : a;
    bucket.n += INST_STRIDE;
  }

  // Box helper: centre + full size.
  box(x, y, z, sx, sy, sz, col, rotY, a) {
    this.push(MESH_CUBE, x, y, z, rotY || 0, 0, sx, sy, sz, col[0], col[1], col[2], a);
  }

  // Thin box stretched from a to b (tracers, beams).
  line(ax, ay, az, bx, by, bz, w, col, a) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = len3(dx, dy, dz) || 0.0001;
    const pitch = Math.asin(clamp(dy / len, -1, 1));
    const yaw = Math.atan2(-dx, -dz);
    this.push(MESH_CUBE, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, yaw, pitch, w, w, len,
      col[0], col[1], col[2], a);
  }

  // Per-frame uniforms shared by every lit program.
  _common(P, vp) {
    const gl = this.gl, u = P.u;
    gl.useProgram(P.p);
    gl.uniformMatrix4fv(u.uVP, false, vp);
    if (u.uCam) gl.uniform3fv(u.uCam, this.camPos);
    if (u.uSunDir) gl.uniform3fv(u.uSunDir, this.sun);
    if (u.uSunCol) gl.uniform3fv(u.uSunCol, this.sunCol);
    if (u.uSkyCol) gl.uniform3fv(u.uSkyCol, this.skyCol);
    if (u.uGndCol) gl.uniform3fv(u.uGndCol, this.gndCol);
    if (u.uFogCol) gl.uniform3fv(u.uFogCol, this.fog);
    if (u.uFogP) gl.uniform2f(u.uFogP, this.fogStart, 1 / this.fogRange);
    if (u.uShadowVP) gl.uniformMatrix4fv(u.uShadowVP, false, this.lightVP);
    if (u.uShadowTexel) gl.uniform1f(u.uShadowTexel, 1 / SHADOW_SIZE);
    if (u.uShadowOn) gl.uniform1f(u.uShadowOn, this.shadowsOn ? 1 : 0);
    if (u.uSpec) gl.uniform1f(u.uSpec, 0.12);
  }

  _upload(entry, buf) {
    if (buf.n === 0) return 0;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.ibo);
    // Orphaning the whole buffer every frame (bufferData with a fresh view) makes
    // the driver reallocate storage on each of these, several times a frame. Size
    // it once, grow it only when a frame genuinely needs more, and upload just the
    // bytes in use — no reallocation, and no subarray view allocated per flush.
    if (buf.n > entry.cap) {
      entry.cap = Math.max(buf.n, entry.cap * 2, 64 * INST_STRIDE);
      gl.bufferData(gl.ARRAY_BUFFER, entry.cap * 4, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf.a, 0, buf.n);
    return buf.n / INST_STRIDE;
  }

  _drawMesh(entry, count) {
    const gl = this.gl;
    gl.bindVertexArray(entry.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, entry.count, count);
    this.drawCalls++; this.instances += count;
  }

  _drawPart(p, count) {
    const gl = this.gl;
    gl.bindVertexArray(p.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0, count);
    this.drawCalls++; this.instances += count;
  }

  _drawSkinned(P) {
    const gl = this.gl, u = P.u;
    for (let i = 0; i < this.skinCount; i++) {
      const q = this.skinQueue[i];
      gl.uniformMatrix4fv(u.uModel, false, q.xf);
      gl.uniformMatrix4fv(u.uJoints, false, q.joints);
      if (u.uTint) gl.uniform4fv(u.uTint, q.tint);
      for (const p of q.model.parts) {
        if (u.uBase) {
          gl.uniform4fv(u.uBase, p.base);
          gl.uniform1f(u.uTexMode, p.tex ? 1 : 0);
          gl.uniform1f(u.uFoliage, p.foliage || 0);
          gl.uniform3fv(u.uEmis, p.emis || ZERO3);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, p.tex || this.whiteTex);
        }
        gl.bindVertexArray(p.vao);
        gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0);
        this.drawCalls++; this.instances++;
      }
    }
  }

  end() {
    const gl = this.gl;
    // 1. upload every opaque bucket once; both passes below draw from them
    const counts = this._counts || (this._counts = []);
    for (let i = 0; i < this.meshes.length; i++) counts[i] = this._upload(this.meshes[i], this.opaque[i]);
    for (const m of this.terrainList) m.oc = this._upload(m, m.bucket);
    for (const model of this.models) if (!model.skinned) for (const p of model.parts) p.oc = this._upload(p, p.opaque);

    // 2. shadow map
    if (this.shadowsOn) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
      gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.6, 4.0);
      gl.useProgram(this.progDepth.p);
      gl.uniformMatrix4fv(this.progDepth.u.uVP, false, this.lightVP);
      for (let i = 0; i < this.meshes.length; i++) if (counts[i]) this._drawMesh(this.meshes[i], counts[i]);
      for (const m of this.terrainList) if (m.oc) this._drawMesh(m, m.oc);
      let cut = 0;
      for (const model of this.models) if (!model.skinned) for (const p of model.parts) if (p.oc) { if (p.cutout) cut++; else this._drawPart(p, p.oc); }
      if (cut) {   // alpha-tested parts (leaves) go through the sampling depth program
        gl.useProgram(this.progDepthCut.p);
        gl.uniformMatrix4fv(this.progDepthCut.u.uVP, false, this.lightVP);
        gl.activeTexture(gl.TEXTURE0);
        for (const model of this.models) if (!model.skinned) for (const p of model.parts) if (p.oc && p.cutout) { gl.bindTexture(gl.TEXTURE_2D, p.tex); this._drawPart(p, p.oc); }
      }
      if (this.skinCount) {
        gl.useProgram(this.progDepthSkin.p);
        gl.uniformMatrix4fv(this.progDepthSkin.u.uVP, false, this.lightVP);
        this._drawSkinned(this.progDepthSkin);
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    // 3. sky
    gl.clearColor(this.fog[0], this.fog[1], this.fog[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.depthMask(false); gl.disable(gl.DEPTH_TEST);
    {
      const P = this.progSky, u = P.u;
      gl.useProgram(P.p);
      gl.uniform3fv(u.uCamF, this._camF); gl.uniform3fv(u.uCamR, this._camR); gl.uniform3fv(u.uCamU, this._camU);
      gl.uniform1f(u.uTanH, this._tanV); gl.uniform1f(u.uAspect, this._aspect);
      gl.uniform3fv(u.uSunDir, this.sun); gl.uniform1f(u.uTime, this.time);
      gl.uniform3fv(u.uZenith, this.zenith); gl.uniform3fv(u.uHorizon, this.horizon);
      gl.uniform3fv(u.uGround, this.ground); gl.uniform3fv(u.uFogCol, this.fog);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.tex.noise);
      gl.bindVertexArray(this.skyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.drawCalls++;
    }
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);

    // 4. opaque pass
    gl.disable(gl.BLEND);
    this._common(this.progFlat, this.vp);
    this._drawMeshes(this.progFlat, counts, false);
    if (this.terrainList.length) {
      const P = this.progTerrain, u = P.u;
      this._common(P, this.vp);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.tex.grass);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.tex.rock);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.tex.dirt);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.tex.noise);
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, this.tex.splat);
      gl.uniform1f(u.uHalf, this._half || 340);
      gl.uniform2f(u.uHeightRange, this._hlo === undefined ? -22 : this._hlo, this._hhi === undefined ? 22 : this._hhi);
      for (const m of this.terrainList) if (m.oc) this._drawMesh(m, m.oc);
    }
    if (this.models.length) this._drawModels(false);
    if (this.skinCount) {
      const P = this.progSkin;
      this._common(P, this.vp);
      gl.uniform1f(P.u.uCutoff, 0.5);
      this._drawSkinned(P);
    }

    // 5. transparent pass — unlit, no depth writes, drawn back after everything solid
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    for (let i = 0; i < this.meshes.length; i++) counts[i] = this._upload(this.meshes[i], this.blend[i]);
    this._common(this.progFlat, this.vp);
    this._drawMeshes(this.progFlat, counts, true);
    if (this.models.length) {
      for (const model of this.models) if (!model.skinned) for (const p of model.parts) p.oc = this._upload(p, p.blend);
      this._drawModels(true);
    }
    gl.depthMask(true); gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  _drawMeshes(P, counts, blendPass) {
    const gl = this.gl, u = P.u;
    gl.uniform4f(u.uBase, 1, 1, 1, 1);
    gl.uniform1f(u.uCutoff, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (let i = 0; i < this.meshes.length; i++) {
      const e = this.meshes[i];
      if (!counts[i]) continue;
      gl.uniform1f(u.uTexMode, e.tex && !blendPass ? 2 : 0);
      gl.uniform1f(u.uTexScale, e.texScale);
      gl.uniform1f(u.uSpec, e.spec || 0.12);
      gl.bindTexture(gl.TEXTURE_2D, e.tex || this.whiteTex);
      this._drawMesh(e, counts[i]);
    }
  }

  _drawModels(blendPass) {
    const gl = this.gl, P = this.progTex, u = P.u;
    let bound = false, cutoff = -1, foliage = -1, emis = null;
    for (const model of this.models) {
      if (model.skinned) continue;
      for (const p of model.parts) {
        if (!p.oc) continue;
        if (!bound) {
          this._common(P, this.vp);
          gl.uniform1f(u.uTexMode, 1);
          gl.activeTexture(gl.TEXTURE0);
          bound = true;
        }
        // per-part material state, only re-sent when it changes
        const c = blendPass ? 0 : (p.cutout ? 0.5 : 0);
        if (c !== cutoff) { gl.uniform1f(u.uCutoff, c); cutoff = c; }
        if (p.foliage !== foliage) { gl.uniform1f(u.uFoliage, p.foliage); foliage = p.foliage; }
        if (p.emis !== emis) { gl.uniform3fv(u.uEmis, p.emis || ZERO3); emis = p.emis; }
        gl.uniform4fv(u.uBase, p.base);
        gl.bindTexture(gl.TEXTURE_2D, p.tex || this.whiteTex);
        this._drawPart(p, p.oc);
      }
    }
  }
}

/* -------------------------------- input ------------------------------------ */

/* Gamepad buttons that mean the same thing in every mode get folded straight
   into the keyboard map, so the game logic never has to know a pad is attached.
   Indices are the W3C "standard mapping" (Xbox naming; PlayStation in brackets). */
const PAD = {
  A: 0, B: 1, X: 2, Y: 3,          // ✕ ○ □ △
  LB: 4, RB: 5, LT: 6, RT: 7,      // L1 R1 L2 R2
  BACK: 8, START: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};
const PAD_KEYS = {
  [PAD.A]: 'Space',          // jump
  [PAD.L3]: 'ShiftLeft',     // sprint
  [PAD.R3]: 'KeyP',          // first / third person
  [PAD.LEFT]: 'KeyT',        // cycle building material
  [PAD.RIGHT]: 'KeyG',       // drop held item
};

const MOUSE_SPIKE = 400;          // px in one mousemove — above this it is a glitch, not a flick

const Input = {
  keys: Object.create(null),
  pressed: Object.create(null),   // edge-triggered, cleared each frame
  mouse: [false, false, false],
  mouseRaw: [false, false, false],
  clicked: [false, false, false],
  dx: 0, dy: 0, wheel: 0,
  locked: false,
  sens: 0.0022,

  // gamepad
  pad: null,
  padActive: false,               // sticky once a pad has actually been touched
  padBtn: [], padPrev: [],
  padKeys: Object.create(null), padPressed: Object.create(null),
  moveX: 0, moveZ: 0,             // analog stick, -1..1
  lookX: 0, lookY: 0,             // rad/sec at the current deflection
  padLook: 3.15,                  // look speed, rad/sec at full deflection
  padDead: 0.16,

  attach(canvas) {
    addEventListener('keydown', e => {
      if (e.repeat) return;
      const k = e.code;
      this.keys[k] = true; this.pressed[k] = true;
      if (['Space', 'Tab', 'F1', 'F2', 'F3', 'F4'].includes(k)) e.preventDefault();
    });
    addEventListener('keyup', e => { this.keys[e.code] = false; });
    addEventListener('blur', () => {
      this.keys = Object.create(null);
      this.mouse = [false, false, false]; this.mouseRaw = [false, false, false];
    });
    canvas.addEventListener('mousedown', e => {
      if (!this.locked && !this.padActive) { canvas.requestPointerLock(); return; }
      this.mouseRaw[e.button] = true;
      this.mouse[e.button] = true; this.clicked[e.button] = true;
    });
    addEventListener('mouseup', e => { this.mouseRaw[e.button] = false; this.mouse[e.button] = false; });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    addEventListener('mousemove', e => {
      if (!this.locked) return;
      // Pointer lock occasionally delivers one absurd movementX (a re-lock, an OS
      // pointer warp, an alt-tab). Unclamped it reads as the view being kicked
      // sideways for no reason, so cap a single event at a hard flick.
      const mx = clamp(e.movementX, -MOUSE_SPIKE, MOUSE_SPIKE);
      const my = clamp(e.movementY, -MOUSE_SPIKE, MOUSE_SPIKE);
      this.dx += mx * this.sens; this.dy += my * this.sens;
    });
    addEventListener('wheel', e => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this.mouse = [false, false, false]; this.mouseRaw = [false, false, false]; }
    });
    addEventListener('gamepadconnected', () => this.pollPad());
  },
  down(k) { return !!this.keys[k] || !!this.padKeys[k]; },
  hit(k) { return !!this.pressed[k] || !!this.padPressed[k]; },

  // Radial deadzone + optional squared response. Returns the pair rescaled so
  // that 92% deflection already reads as full tilt.
  // A worn stick that rests off-centre reads as a constant push in one direction —
  // the classic "my view keeps drifting right" even though nothing is touching it.
  // Subtract the resting value sampled the first time the pad was seen, but only
  // when it is small enough to be drift rather than someone holding the stick at
  // load time.
  _centre(prof, ax) {
    const r = prof.rest[ax];
    return (r === undefined || Math.abs(r) > 0.3) ? 0 : r;
  },

  _stick(x, y, expo) {
    const m = len2(x, y);
    if (m < this.padDead) return [0, 0];
    const n = Math.min(1, (m - this.padDead) / (0.92 - this.padDead));
    const s = (expo ? n * n : n) / m;
    return [x * s, y * s];
  },

  // Most pads report the W3C "standard mapping", so the PAD indices above just work
  // (Xbox, DualShock/DualSense, Switch Pro, 8BitDo in X-input mode, …). Generic or
  // DirectInput pads report mapping:'' and hand over the triggers and D-pad as axes
  // instead of buttons, on the classic layout 0,1 = left stick · 2 = LT · 3,4 =
  // right stick · 5 = RT · 6,7 = D-pad. Detect that once per pad and normalise it
  // into the standard button slots, so nothing downstream cares what's plugged in.
  _profile(g) {
    if (this._prof && this._prof.id === g.id) return this._prof;
    const std = g.mapping === 'standard';
    const generic = !std && g.buttons.length <= 11 && g.axes.length >= 6;
    this._prof = {
      id: g.id, standard: std, generic,
      axLook: generic ? [3, 4] : [2, 3],
      axTrig: generic ? [2, 5] : null,
      axDpad: (!std && g.buttons.length < 16 && g.axes.length >= 8) ? [6, 7] : null,
      rest: Array.prototype.slice.call(g.axes),   // resting values, sampled on first sight
    };
    return this._prof;
  },

  // Called once per frame, before update(). Rebuilds pad state and its edges, so
  // padHit() is naturally one-frame without any endFrame bookkeeping.
  pollPad() {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    let g = null;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p && p.connected && p.axes && p.axes.length >= 4 && p.buttons && p.buttons.length >= 8) { g = p; break; }
    }
    this.padPrev = this.padBtn;
    this.padBtn = [];
    this.padKeys = Object.create(null);
    this.padPressed = Object.create(null);
    this.pad = g;
    if (!g) {
      this.moveX = this.moveZ = this.lookX = this.lookY = 0;
      for (let i = 0; i < 3; i++) this.mouse[i] = this.mouseRaw[i];
      return;
    }
    const prof = this._profile(g);
    let touched = false;
    for (let i = 0; i < g.buttons.length; i++) {
      const b = g.buttons[i];
      const v = typeof b === 'number' ? b : (b.value !== undefined ? b.value : 0);
      this.padBtn[i] = (typeof b !== 'number' && b.pressed) || v > 0.35;
      if (this.padBtn[i]) touched = true;
    }
    // fill the trigger / D-pad slots this pad reports as axes rather than buttons
    if (prof.axTrig) {
      const trig = (ax, slot) => {
        const rest = prof.rest[ax] === undefined ? 0 : prof.rest[ax];
        this.padBtn[slot] = Math.abs(g.axes[ax] - rest) > 0.5;
        if (this.padBtn[slot]) touched = true;
      };
      trig(prof.axTrig[0], PAD.LT); trig(prof.axTrig[1], PAD.RT);
    }
    if (prof.axDpad) {
      const hx = g.axes[prof.axDpad[0]], hy = g.axes[prof.axDpad[1]];
      this.padBtn[PAD.LEFT] = hx < -0.5; this.padBtn[PAD.RIGHT] = hx > 0.5;
      this.padBtn[PAD.UP] = hy < -0.5; this.padBtn[PAD.DOWN] = hy > 0.5;
      if (Math.abs(hx) > 0.5 || Math.abs(hy) > 0.5) touched = true;
    }
    const mx = (g.axes[0] || 0) - this._centre(prof, 0);
    const my = (g.axes[1] || 0) - this._centre(prof, 1);
    const mv = this._stick(mx, my, false);
    this.moveX = mv[0]; this.moveZ = -mv[1];
    const lx = (g.axes[prof.axLook[0]] || 0) - this._centre(prof, prof.axLook[0]);
    const ly = (g.axes[prof.axLook[1]] || 0) - this._centre(prof, prof.axLook[1]);
    const lk = this._stick(lx, ly, true);
    this.lookX = lk[0] * this.padLook;
    this.lookY = lk[1] * this.padLook * 0.78;   // vertical a touch slower, as consoles do
    if (Math.hypot(mx, my, lx, ly) > 0.45) touched = true;
    if (touched) this.padActive = true;
    for (const i in PAD_KEYS) {
      if (!this.padBtn[i]) continue;
      this.padKeys[PAD_KEYS[i]] = true;
      if (!this.padPrev[i]) this.padPressed[PAD_KEYS[i]] = true;
    }
    for (let i = 0; i < 3; i++) this.mouse[i] = this.mouseRaw[i];
  },
  padDown(i) { return !!this.padBtn[i]; },
  padHit(i) { return !!this.padBtn[i] && !this.padPrev[i]; },

  endFrame() {
    this.pressed = Object.create(null);
    this.clicked = [false, false, false];
    this.dx = 0; this.dy = 0; this.wheel = 0;
  }
};

/* -------------------------------- audio ------------------------------------ */
// Tiny synth — no assets, everything is oscillators and one noise buffer.

const Sfx = {
  ctx: null, noiseBuf: null, master: null, muted: false,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    const n = this.ctx.sampleRate * 0.5;
    this.noiseBuf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  },
  tone(freq, dur, type, gain, slide) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type || 'square'; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  },
  noise(dur, gain, freq, q) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass';
    f.frequency.value = freq; f.Q.value = q || 1;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master); s.start(t); s.stop(t + dur);
  },
  shoot(kind) {
    if (kind === 'shotgun') { this.noise(0.28, 0.5, 700, 0.7); this.tone(120, 0.18, 'sawtooth', 0.25, 40); }
    else if (kind === 'sniper') { this.noise(0.35, 0.45, 1200, 0.8); this.tone(200, 0.25, 'square', 0.2, 50); }
    else { this.noise(0.09, 0.3, 1600, 1.2); this.tone(320, 0.06, 'square', 0.12, 120); }
  },
  hit() { this.tone(1500, 0.05, 'square', 0.16, 900); },
  hurt() { this.noise(0.18, 0.3, 300, 0.6); },
  build() { this.tone(240, 0.09, 'triangle', 0.2, 420); },
  pickup() { this.tone(660, 0.07, 'triangle', 0.18); setTimeout(() => this.tone(990, 0.09, 'triangle', 0.16), 60); },
  swing() { this.noise(0.13, 0.18, 900, 1.5); },
  elim() { this.tone(180, 0.5, 'sawtooth', 0.2, 60); },
  win() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.32, 'triangle', 0.2), i * 130)); }
};
