'use strict';
/* =============================================================================
   fortnite-lite / models.js
   glTF 2.0 + GLB loader. Turns a downloaded .glb/.gltf into flat CPU buffers
   (position, normal, uv, indices, base colour, one image per material) that
   Renderer.addModel() uploads. Nothing here touches WebGL — the split is
   deliberate: this file owns the file format, engine.js owns the GPU.

   What it handles: GLB and .gltf + .bin + external images, the full node
   hierarchy (baked down into the vertices, so there is no scene graph at
   runtime), byteStride'd accessors, normalized integer attributes, missing
   normals (recomputed flat), and primitives merged by material so a 12-part prop
   costs one draw call per material rather than twelve.

   What it does not handle: Draco / meshopt / basisu compression (detected and
   reported — re-export uncompressed), sparse accessors, skinning. Static props
   only for now; skinned characters need a joint palette the renderer has no room
   for yet.

   Kenney, Quaternius, KayKit and Poly Pizza all export within this subset.
   ============================================================================= */

const GLB_MAGIC = 0x46546c67;   // 'glTF'
const CHUNK_JSON = 0x4e4f534a;  // 'JSON'
const CHUNK_BIN = 0x004e4942;   // 'BIN\0'

// componentType -> DataView getter + byte size + the divisor that maps an integer
// attribute onto [0,1] (or [-1,1]) when the accessor is `normalized`.
const COMPONENT = {
  5120: { get: 'getInt8', size: 1, norm: 127 },
  5121: { get: 'getUint8', size: 1, norm: 255 },
  5122: { get: 'getInt16', size: 2, norm: 32767 },
  5123: { get: 'getUint16', size: 2, norm: 65535 },
  5125: { get: 'getUint32', size: 4, norm: 4294967295 },
  5126: { get: 'getFloat32', size: 4, norm: 1 },
};
const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

const VERT_FLOATS = 8;   // pos3 + nrm3 + uv2 — must match Renderer.addModel()

/* ------------------------------ node maths --------------------------------- */

// Column-major TRS, same layout as engine.js mat4() and as glTF's own `matrix`.
function m4FromTRS(o, t, q, s) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = s[0], sy = s[1], sz = s[2];
  o[0] = (1 - (yy + zz)) * sx; o[1] = (xy + wz) * sx; o[2] = (xz - wy) * sx; o[3] = 0;
  o[4] = (xy - wz) * sy; o[5] = (1 - (xx + zz)) * sy; o[6] = (yz + wx) * sy; o[7] = 0;
  o[8] = (xz + wy) * sz; o[9] = (yz - wx) * sz; o[10] = (1 - (xx + yy)) * sz; o[11] = 0;
  o[12] = t[0]; o[13] = t[1]; o[14] = t[2]; o[15] = 1;
  return o;
}

function nodeMatrix(node) {
  const o = mat4();
  if (node.matrix) { o.set(node.matrix); return o; }
  return m4FromTRS(o, node.translation || [0, 0, 0], node.rotation || [0, 0, 0, 1], node.scale || [1, 1, 1]);
}

/* ------------------------------- accessors --------------------------------- */

// Read accessor `ai` into a Float32Array of count * numComponents. Integer types
// are widened to float here; index buffers get narrowed back on the way out.
// Every read goes through a DataView, so a bufferView with an odd byteOffset or
// an interleaved byteStride costs nothing extra to support.
function readAccessor(g, buffers, ai) {
  const acc = g.accessors[ai];
  const n = NUM_COMPONENTS[acc.type];
  const out = new Float32Array(acc.count * n);
  if (acc.bufferView === undefined) return out;    // spec says: treat as all zeros
  if (acc.sparse) throw new Error('sparse accessors are not supported');

  const bv = g.bufferViews[acc.bufferView];
  const C = COMPONENT[acc.componentType];
  if (!C) throw new Error('unknown componentType ' + acc.componentType);
  const dv = new DataView(buffers[bv.buffer || 0]);
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || n * C.size;
  const div = acc.normalized ? C.norm : 1;

  for (let i = 0; i < acc.count; i++) {
    const at = base + i * stride;
    for (let c = 0; c < n; c++) {
      const v = dv[C.get](at + c * C.size, true);
      out[i * n + c] = div === 1 ? v : Math.max(v / div, -1);
    }
  }
  return out;
}

/* -------------------------------- images ----------------------------------- */

async function decodeImage(g, buffers, index, baseUrl) {
  const img = (g.images || [])[index];
  if (!img) return null;
  let blob;
  if (img.uri !== undefined) {
    const url = /^data:/.test(img.uri) ? img.uri : new URL(img.uri, baseUrl).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error('image ' + img.uri + ' -> HTTP ' + res.status);
    blob = await res.blob();
  } else {
    const bv = g.bufferViews[img.bufferView];
    const bytes = new Uint8Array(buffers[bv.buffer || 0], bv.byteOffset || 0, bv.byteLength);
    blob = new Blob([bytes], { type: img.mimeType || 'image/png' });
  }
  return createImageBitmap(blob);
}

// A stable key for an image the renderer can share between models: the resolved
// URL of an external file (a bark texture used by five trees is uploaded once),
// nothing for an image embedded in the file.
function imageKey(g, index, baseUrl) {
  const img = (g.images || [])[index];
  if (!img || img.uri === undefined || /^data:/.test(img.uri)) return null;
  return new URL(img.uri, baseUrl).href;
}

/* ------------------------------ the loader --------------------------------- */

function parseGLB(ab) {
  const dv = new DataView(ab);
  if (dv.byteLength < 12 || dv.getUint32(0, true) !== GLB_MAGIC) return null;   // plain .gltf
  const total = Math.min(dv.getUint32(8, true), ab.byteLength);
  let off = 12, json = null, bin = null;
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true), start = off + 8;
    if (start + len > total) break;
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, start, len)));
    else if (type === CHUNK_BIN) bin = ab.slice(start, start + len);
    off = start + len + ((4 - (len % 4)) % 4);   // chunks are 4-byte aligned
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

// Resolve every buffer the document references into an ArrayBuffer. GLB's buffer
// 0 is the BIN chunk and has no uri; a .gltf's buffers are data: URIs or .bin
// files sitting next to it.
async function loadBuffers(g, glbBin, baseUrl) {
  const out = [];
  for (let i = 0; i < (g.buffers || []).length; i++) {
    const b = g.buffers[i];
    if (b.uri === undefined) {
      if (!glbBin) throw new Error('buffer ' + i + ' has no uri and there is no BIN chunk');
      out.push(glbBin);
    } else {
      const url = /^data:/.test(b.uri) ? b.uri : new URL(b.uri, baseUrl).href;
      const res = await fetch(url);
      if (!res.ok) throw new Error('buffer ' + b.uri + ' -> HTTP ' + res.status);
      out.push(await res.arrayBuffer());
    }
  }
  return out;
}

// Walk the scene, multiplying each node's local matrix into its parent's, and
// collect a flat (mesh, worldMatrix) list. Baking here means the runtime never
// sees a hierarchy — a prop is just triangles in model space.
function flattenScene(g) {
  const scene = (g.scenes || [])[g.scene === undefined ? 0 : g.scene];
  const roots = scene ? (scene.nodes || []) : (g.nodes || []).map((_, i) => i);
  const found = [];
  const open = new Set();                          // guards a malformed cyclic graph
  const walk = (ni, parent) => {
    const node = (g.nodes || [])[ni];
    if (!node || open.has(ni)) return;
    open.add(ni);
    const world = mat4();
    m4Mul(world, parent, nodeMatrix(node));
    if (node.mesh !== undefined) found.push({ mesh: node.mesh, m: world });
    for (const c of node.children || []) walk(c, world);
    open.delete(ni);
  };
  const id = mat4(); id[0] = id[5] = id[10] = id[15] = 1;
  for (const r of roots) walk(r, id);
  return found;
}

// Material names that mean "foliage": lit with a softened, upward-leaning normal
// so a tree canopy of criss-crossing leaf cards reads as one bright volume rather
// than a jumble of dark and lit facets.
const FOLIAGE_RE = /leaves|leaf|foliage|bush|grass|flower|petal|needle/i;

// glTF base colour for a material, plus the image index it samples (if any), the
// alpha mode (MASK / BLEND parts are drawn — and shadowed — as cutouts), the
// emissive colour and whether it is foliage.
function materialOf(g, mi) {
  const m = (g.materials || [])[mi] || {};
  const pbr = m.pbrMetallicRoughness || {};
  const out = {
    color: pbr.baseColorFactor ? pbr.baseColorFactor.slice() : [1, 1, 1, 1], image: null, sampler: undefined,
    cutout: m.alphaMode === 'MASK' || m.alphaMode === 'BLEND',
    emissive: m.emissiveFactor ? m.emissiveFactor.slice(0, 3) : null,
    foliage: FOLIAGE_RE.test(m.name || ''),
  };
  if (pbr.baseColorTexture) {
    const tex = (g.textures || [])[pbr.baseColorTexture.index];
    if (tex) { if (tex.source !== undefined) out.image = tex.source; out.sampler = tex.sampler; }
  }
  // KHR_materials_emissive_strength scales the factor; a black factor stays black
  const es = m.extensions && m.extensions.KHR_materials_emissive_strength;
  if (out.emissive && es && es.emissiveStrength) out.emissive = out.emissive.map(v => v * es.emissiveStrength);
  if (out.emissive && !out.emissive.some(v => v > 0)) out.emissive = null;
  return out;
}

// Decode a part's image (once per distinct image per file) and attach the
// material's flags to the part record the renderer uploads.
async function finishPart(json, buffers, baseUrl, imageCache, mat, verts, idx) {
  let image = null, key = null;
  if (mat.image !== null && mat.image !== undefined) {
    if (!imageCache.has(mat.image)) imageCache.set(mat.image, decodeImage(json, buffers, mat.image, baseUrl));
    image = await imageCache.get(mat.image);
    key = imageKey(json, mat.image, baseUrl);
  }
  const sampler = mat.sampler !== undefined ? (json.samplers || [])[mat.sampler] : null;
  return {
    verts, idx, color: mat.color, image, imageKey: key,
    wrapS: sampler && sampler.wrapS, wrapT: sampler && sampler.wrapT,
    cutout: mat.cutout && !!image, emissive: mat.emissive, foliage: mat.foliage,
  };
}

/* Parse an already-fetched glTF/GLB into CPU parts.
   Returns { parts: [{ verts, idx, color, image, wrapS, wrapT }], min, max }. */
async function parseGLTF(ab, baseUrl, opts) {
  let json, glbBin = null;
  const glb = parseGLB(ab);
  if (glb) { json = glb.json; glbBin = glb.bin; }
  else json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab)));

  const unsupported = (json.extensionsRequired || []).filter(e => /draco|meshopt|basisu/i.test(e));
  if (unsupported.length) {
    throw new Error('needs ' + unsupported.join(', ') + ' — re-export from Blender with compression off');
  }

  const buffers = await loadBuffers(json, glbBin, baseUrl);
  // A file with a skin is a character: keep its hierarchy and clips (see below)
  // instead of baking everything into one static mesh.
  if ((json.skins || []).length) return parseSkinned(json, buffers, baseUrl, opts || {});
  const nodes = flattenScene(json);

  // One bucket per material: primitives that share a material merge into a single
  // draw call, which is the difference between a KayKit prop costing 1 call and 12.
  const groups = new Map();
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];

  for (const entry of nodes) {
    const m = entry.m;
    for (const prim of ((json.meshes || [])[entry.mesh] || {}).primitives || []) {
      if (prim.mode !== undefined && prim.mode !== 4) continue;   // TRIANGLES only
      const a = prim.attributes || {};
      if (a.POSITION === undefined) continue;

      const pos = readAccessor(json, buffers, a.POSITION);
      const vcount = pos.length / 3;
      const nrm = a.NORMAL !== undefined ? readAccessor(json, buffers, a.NORMAL) : null;
      const uv = a.TEXCOORD_0 !== undefined ? readAccessor(json, buffers, a.TEXCOORD_0) : null;
      const rawIdx = prim.indices !== undefined ? readAccessor(json, buffers, prim.indices) : null;

      const key = prim.material === undefined ? -1 : prim.material;
      let grp = groups.get(key);
      if (!grp) { grp = { verts: [], idx: [] }; groups.set(key, grp); }
      const first = grp.verts.length / VERT_FLOATS;

      // Bake the node matrix straight into the vertices. Normals use the upper
      // 3x3 and are renormalised in the shader, which is exact for the uniform
      // scales every one of these asset packs ships.
      for (let i = 0; i < vcount; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        if (wx < min[0]) min[0] = wx; if (wx > max[0]) max[0] = wx;
        if (wy < min[1]) min[1] = wy; if (wy > max[1]) max[1] = wy;
        if (wz < min[2]) min[2] = wz; if (wz > max[2]) max[2] = wz;
        let nx = 0, ny = 1, nz = 0;
        if (nrm) {
          const ax = nrm[i * 3], ay = nrm[i * 3 + 1], az = nrm[i * 3 + 2];
          nx = m[0] * ax + m[4] * ay + m[8] * az;
          ny = m[1] * ax + m[5] * ay + m[9] * az;
          nz = m[2] * ax + m[6] * ay + m[10] * az;
        }
        grp.verts.push(wx, wy, wz, nx, ny, nz, uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0);
      }

      const idxFrom = grp.idx.length;
      if (rawIdx) for (let i = 0; i < rawIdx.length; i++) grp.idx.push(first + rawIdx[i]);
      else for (let i = 0; i < vcount; i++) grp.idx.push(first + i);
      if (!nrm) computeFlatNormals(grp.verts, grp.idx, idxFrom);
    }
  }

  if (!groups.size) throw new Error('no triangle geometry found');

  // Decode each distinct image once, even when several materials share an atlas.
  const imageCache = new Map();
  const parts = [];
  for (const pair of groups) {
    const grp = pair[1];
    parts.push(await finishPart(json, buffers, baseUrl, imageCache, materialOf(json, pair[0]), new Float32Array(grp.verts), new Uint32Array(grp.idx)));
  }
  return { parts, min, max };
}

// Fill in flat normals for a primitive that shipped without any, over the index
// range starting at `from`. Vertices are unique per primitive at this point, so a
// face normal can be written straight onto its three corners.
function computeFlatNormals(verts, idx, from, stride) {
  const S = stride || VERT_FLOATS;
  for (let i = from; i + 2 < idx.length; i += 3) {
    const a = idx[i] * S, b = idx[i + 1] * S, c = idx[i + 2] * S;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    verts[a + 3] = nx; verts[a + 4] = ny; verts[a + 5] = nz;
    verts[b + 3] = nx; verts[b + 4] = ny; verts[b + 5] = nz;
    verts[c + 3] = nx; verts[c + 4] = ny; verts[c + 5] = nz;
  }
}

/* --------------------------- skinned characters ---------------------------- */

const SKIN_FLOATS = 16;   // pos3 nrm3 uv2 joints4 weights4 — must match Renderer.addSkinned()
const IDENTITY16 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// TRS from a glTF node `matrix` (rare — Blender exports TRS — but cheap to allow).
function decomposeTRS(m) {
  const sx = len3(m[0], m[1], m[2]), sy = len3(m[4], m[5], m[6]), sz = len3(m[8], m[9], m[10]);
  const r00 = m[0] / sx, r01 = m[4] / sy, r02 = m[8] / sz;
  const r10 = m[1] / sx, r11 = m[5] / sy, r12 = m[9] / sz;
  const r20 = m[2] / sx, r21 = m[6] / sy, r22 = m[10] / sz;
  const tr = r00 + r11 + r22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, 0.25 * s]; }
  else if (r00 > r11 && r00 > r22) { const s = Math.sqrt(1 + r00 - r11 - r22) * 2; q = [0.25 * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s]; }
  else if (r11 > r22) { const s = Math.sqrt(1 + r11 - r00 - r22) * 2; q = [(r01 + r10) / s, 0.25 * s, (r12 + r21) / s, (r02 - r20) / s]; }
  else { const s = Math.sqrt(1 + r22 - r00 - r11) * 2; q = [(r02 + r20) / s, (r12 + r21) / s, 0.25 * s, (r10 - r01) / s]; }
  return { t: [m[12], m[13], m[14]], r: q, s: [sx, sy, sz] };
}

/* A character keeps its node hierarchy. Every vertex is bound to palette slots —
   the skin's joints, plus one slot per *rigid* mesh node (a helmet parented to
   the head, a cape on the chest) so a single skinned draw covers the whole
   figure. The shader applies the animated palette; anim.js builds it each frame.
   opts.skipNodes is a regex of node names whose subtrees are left out (the
   asset pack's own swords and shields, which the game replaces with guns). */
async function parseSkinned(json, buffers, baseUrl, opts) {
  const N = json.nodes.length;
  const nodes = json.nodes.map((n, i) => ({ name: n.name || ('node' + i), children: (n.children || []).slice(), mesh: n.mesh, skin: n.skin }));
  const parents = new Int32Array(N).fill(-1);
  nodes.forEach((n, i) => { for (const c of n.children) parents[c] = i; });
  const names = Object.create(null);
  nodes.forEach((n, i) => { if (names[n.name] === undefined) names[n.name] = i; });

  const rest = { t: new Float32Array(N * 3), r: new Float32Array(N * 4), s: new Float32Array(N * 3) };
  for (let i = 0; i < N; i++) {
    const n = json.nodes[i];
    let t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
    if (n.matrix) { const d = decomposeTRS(n.matrix); t = d.t; r = d.r; s = d.s; }
    rest.t.set(t, i * 3); rest.r.set(r, i * 4); rest.s.set(s, i * 3);
  }

  // parent-first traversal order from the scene roots (orphans appended)
  const scene = (json.scenes || [])[json.scene === undefined ? 0 : json.scene];
  const roots = scene ? (scene.nodes || []) : nodes.map((_, i) => i).filter(i => parents[i] < 0);
  const order = [], seen = new Uint8Array(N);
  const walk = i => { if (seen[i]) return; seen[i] = 1; order.push(i); for (const c of nodes[i].children) walk(c); };
  for (const r of roots) walk(r);
  for (let i = 0; i < N; i++) if (!seen[i]) walk(i);

  // rest-pose world matrices, for the bounding box below
  const world = new Float32Array(N * 16), tmp = mat4();
  for (const i of order) {
    const p = parents[i], o3 = i * 3, o4 = i * 4;
    m4FromTRS(tmp, [rest.t[o3], rest.t[o3 + 1], rest.t[o3 + 2]], [rest.r[o4], rest.r[o4 + 1], rest.r[o4 + 2], rest.r[o4 + 3]], [rest.s[o3], rest.s[o3 + 1], rest.s[o3 + 2]]);
    const w = world.subarray(i * 16, i * 16 + 16);
    if (p < 0) w.set(tmp); else m4Mul(w, world.subarray(p * 16, p * 16 + 16), tmp);
  }

  // palette = skin joints, then any rigid mesh nodes we come across
  const skin = json.skins[0];
  const palette = skin.joints.slice();
  const ibmSrc = skin.inverseBindMatrices !== undefined ? readAccessor(json, buffers, skin.inverseBindMatrices) : null;
  const ibmList = [], ibmIdentity = [];
  for (let j = 0; j < palette.length; j++) { ibmList.push(ibmSrc ? ibmSrc.slice(j * 16, j * 16 + 16) : IDENTITY16); ibmIdentity.push(!ibmSrc); }
  const slotOf = new Map();
  palette.forEach((n, j) => { if (!slotOf.has(n)) slotOf.set(n, j); });
  const rigidSlot = ni => {
    if (!slotOf.has(ni)) { slotOf.set(ni, palette.length); palette.push(ni); ibmList.push(IDENTITY16); ibmIdentity.push(true); }
    return slotOf.get(ni);
  };
  const skipped = new Uint8Array(N);
  if (opts.skipNodes) {
    const re = new RegExp(opts.skipNodes);
    const mark = i => { skipped[i] = 1; for (const c of nodes[i].children) mark(c); };
    nodes.forEach((n, i) => { if (re.test(n.name)) mark(i); });
  }
  // rest-pose joint matrices (world * ibm) so the bounds reflect the bind pose
  const jm = [];
  const jmOf = j => {
    if (!jm[j]) { const n = palette[j]; const m = mat4(); if (ibmIdentity[j]) m.set(world.subarray(n * 16, n * 16 + 16)); else m4Mul(m, world.subarray(n * 16, n * 16 + 16), ibmList[j]); jm[j] = m; }
    return jm[j];
  };

  const groups = new Map();
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let ni = 0; ni < N; ni++) {
    if (nodes[ni].mesh === undefined || skipped[ni]) continue;
    const mesh = json.meshes[nodes[ni].mesh];
    const isSkinned = nodes[ni].skin !== undefined;
    const rigid = isSkinned ? -1 : rigidSlot(ni);
    for (const prim of mesh.primitives || []) {
      if (prim.mode !== undefined && prim.mode !== 4) continue;
      const a = prim.attributes || {};
      if (a.POSITION === undefined) continue;
      const pos = readAccessor(json, buffers, a.POSITION);
      const vcount = pos.length / 3;
      const nrm = a.NORMAL !== undefined ? readAccessor(json, buffers, a.NORMAL) : null;
      const uv = a.TEXCOORD_0 !== undefined ? readAccessor(json, buffers, a.TEXCOORD_0) : null;
      const jn = isSkinned && a.JOINTS_0 !== undefined ? readAccessor(json, buffers, a.JOINTS_0) : null;
      const wt = isSkinned && a.WEIGHTS_0 !== undefined ? readAccessor(json, buffers, a.WEIGHTS_0) : null;
      const rawIdx = prim.indices !== undefined ? readAccessor(json, buffers, prim.indices) : null;
      const key = prim.material === undefined ? -1 : prim.material;
      let grp = groups.get(key);
      if (!grp) { grp = { verts: [], idx: [] }; groups.set(key, grp); }
      const first = grp.verts.length / SKIN_FLOATS;
      for (let i = 0; i < vcount; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        let j0 = rigid, j1 = 0, j2 = 0, j3 = 0, w0 = 1, w1 = 0, w2 = 0, w3 = 0;
        if (jn && wt) {
          j0 = jn[i * 4]; j1 = jn[i * 4 + 1]; j2 = jn[i * 4 + 2]; j3 = jn[i * 4 + 3];
          w0 = wt[i * 4]; w1 = wt[i * 4 + 1]; w2 = wt[i * 4 + 2]; w3 = wt[i * 4 + 3];
          const ws = (w0 + w1 + w2 + w3) || 1; w0 /= ws; w1 /= ws; w2 /= ws; w3 /= ws;
        }
        grp.verts.push(x, y, z, nrm ? nrm[i * 3] : 0, nrm ? nrm[i * 3 + 1] : 1, nrm ? nrm[i * 3 + 2] : 0,
          uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0, j0, j1, j2, j3, w0, w1, w2, w3);
        // bind-pose position for the bounds
        let wx = 0, wy = 0, wz = 0;
        const js = [j0, j1, j2, j3], ws = [w0, w1, w2, w3];
        for (let k = 0; k < 4; k++) {
          if (ws[k] <= 0) continue;
          const m = jmOf(js[k]);
          wx += ws[k] * (m[0] * x + m[4] * y + m[8] * z + m[12]);
          wy += ws[k] * (m[1] * x + m[5] * y + m[9] * z + m[13]);
          wz += ws[k] * (m[2] * x + m[6] * y + m[10] * z + m[14]);
        }
        if (wx < min[0]) min[0] = wx; if (wx > max[0]) max[0] = wx;
        if (wy < min[1]) min[1] = wy; if (wy > max[1]) max[1] = wy;
        if (wz < min[2]) min[2] = wz; if (wz > max[2]) max[2] = wz;
      }
      const idxFrom = grp.idx.length;
      if (rawIdx) for (let i = 0; i < rawIdx.length; i++) grp.idx.push(first + rawIdx[i]);
      else for (let i = 0; i < vcount; i++) grp.idx.push(first + i);
      if (!nrm) computeFlatNormals(grp.verts, grp.idx, idxFrom, SKIN_FLOATS);
    }
  }
  if (!groups.size) throw new Error('no triangle geometry found');

  const imageCache = new Map();
  const parts = [];
  for (const pair of groups) {
    const grp = pair[1];
    parts.push(await finishPart(json, buffers, baseUrl, imageCache, materialOf(json, pair[0]), new Float32Array(grp.verts), new Uint32Array(grp.idx)));
  }

  // animation clips: node + path + keyframe times/values, LINEAR (STEP treated
  // as linear, CUBICSPLINE reduced to its in-between values)
  const clips = Object.create(null);
  for (const an of json.animations || []) {
    const ch = [];
    let dur = 0;
    for (const c of an.channels) {
      const s = an.samplers[c.sampler], path = c.target.path;
      const pathId = path === 'translation' ? 0 : path === 'rotation' ? 1 : path === 'scale' ? 2 : -1;
      if (pathId < 0 || c.target.node === undefined) continue;
      const times = readAccessor(json, buffers, s.input);
      let vals = readAccessor(json, buffers, s.output);
      const nc = pathId === 1 ? 4 : 3;
      if (s.interpolation === 'CUBICSPLINE') {
        const n = times.length, v2 = new Float32Array(n * nc);
        for (let k = 0; k < n; k++) for (let q = 0; q < nc; q++) v2[k * nc + q] = vals[(k * 3 + 1) * nc + q];
        vals = v2;
      }
      if (times.length) dur = Math.max(dur, times[times.length - 1]);
      ch.push({ node: c.target.node, path: pathId, times, vals, nc });
    }
    clips[an.name || ('anim' + Object.keys(clips).length)] = { name: an.name, dur, ch };
  }

  const ibm = new Float32Array(palette.length * 16);
  ibmList.forEach((m, j) => ibm.set(m, j * 16));
  return {
    parts, min, max, skinned: true,
    rig: { nodes, order: Int32Array.from(order), parents, rest, names, palette, ibm, ibmIdentity, clips },
  };
}

/* ------------------------------- registry ---------------------------------- */

/* Assets.get(name) returns null until the file has landed, and null forever if it
   failed — every draw site keeps its procedural fallback, so a missing or broken
   .glb costs you the nicer prop and nothing else. Nothing here blocks a match
   starting; models simply appear when they arrive. */
const Assets = {
  R: null,
  models: Object.create(null),
  pending: 0,
  errors: [],

  init(renderer) { this.R = renderer; },

  // load('tree', 'assets/tree.glb') -> Promise<model|null>. Never rejects.
  // opts (characters only): { skipNodes: regex } — see parseSkinned.
  async load(name, url, opts) {
    this.pending++;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const cpu = await parseGLTF(await res.arrayBuffer(), new URL(url, location.href).href, opts);
      const model = this.R.addModel(cpu);
      model.name = name;
      this.models[name] = model;
      return model;
    } catch (err) {
      const msg = name + ' (' + url + '): ' + err.message;
      this.errors.push(msg);
      console.warn('[assets] ' + msg + ' — falling back to built-in geometry');
      return null;
    } finally {
      this.pending--;
    }
  },

  // Kick off a whole manifest at once: { tree: 'assets/tree.glb', ... } — a
  // value may also be { url, skipNodes } for a character.
  loadAll(manifest) {
    return Promise.all(Object.keys(manifest).map(k => {
      const v = manifest[k];
      return typeof v === 'string' ? this.load(k, v) : this.load(k, v.url, v);
    }));
  },

  get(name) { return this.models[name] || null; },
  has(name) { return !!this.models[name]; },

  // Console helper: FN.assets() shows what loaded, what didn't, and how heavy it is.
  report() {
    return {
      loaded: Object.keys(this.models).map(n => {
        const m = this.models[n];
        return { name: n, parts: m.parts.length, tris: m.tris, height: +m.h.toFixed(2), textured: m.parts.some(p => !!p.tex) };
      }),
      failed: this.errors.slice(),
      pending: this.pending,
    };
  },
};
