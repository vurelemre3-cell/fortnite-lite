// strip.js <in.glb> <out.glb>
// Keep only the animations the game plays, drop the pack's melee weapons/shields
// (meshes parented under handslot.*), and rebuild the BIN with just the
// bufferViews that are still referenced. Turns a 3.6 MB character into ~0.5 MB.
const fs = require('fs');
const KEEP = new Set(['Idle', 'Walking_A', 'Walking_Backwards', 'Running_A', 'Running_Strafe_Left', 'Running_Strafe_Right',
  'Jump_Start', 'Jump_Idle', 'Jump_Land', 'Death_A', 'Hit_A', '1H_Ranged_Aiming', '1H_Ranged_Shoot', '1H_Ranged_Reload',
  '2H_Ranged_Aiming', '2H_Ranged_Shoot', '2H_Ranged_Reload', '1H_Melee_Attack_Chop', 'Interact', 'PickUp', 'Cheer',
  'Use_Item', 'Unarmed_Idle', 'Throw']);

const [, , src, dst] = process.argv;
const ab = fs.readFileSync(src);
const dv = new DataView(ab.buffer, ab.byteOffset, ab.byteLength);
const jl = dv.getUint32(12, true);
const g = JSON.parse(ab.slice(20, 20 + jl).toString());
const binOff = 20 + jl + 8;
const bin = ab.slice(binOff, binOff + dv.getUint32(20 + jl, true));

// 1. drop meshes hanging off the hand slots (swords, shields, wands …)
const under = new Set();
const walk = (i) => { under.add(i); for (const c of g.nodes[i].children || []) walk(c); };
g.nodes.forEach((n, i) => { if (/^handslot\./.test(n.name)) for (const c of n.children || []) walk(c); });
for (const i of under) delete g.nodes[i].mesh;

// 2. keep only the animations we use
g.animations = (g.animations || []).filter(a => KEEP.has(a.name));

// 3. collect referenced meshes / accessors / bufferViews
const meshUsed = new Set(g.nodes.filter(n => n.mesh !== undefined).map(n => n.mesh));
const accUsed = new Set();
g.meshes.forEach((m, mi) => { if (!meshUsed.has(mi)) return; for (const p of m.primitives) { for (const k in p.attributes) accUsed.add(p.attributes[k]); if (p.indices !== undefined) accUsed.add(p.indices); } });
for (const s of g.skins || []) if (s.inverseBindMatrices !== undefined) accUsed.add(s.inverseBindMatrices);
for (const a of g.animations) for (const s of a.samplers) { accUsed.add(s.input); accUsed.add(s.output); }
const bvUsed = new Set();
for (const ai of accUsed) { const a = g.accessors[ai]; if (a.bufferView !== undefined) bvUsed.add(a.bufferView); }
for (const im of g.images || []) if (im.bufferView !== undefined) bvUsed.add(im.bufferView);

// 4. rebuild the BIN from the used bufferViews, remapping every index
const bvMap = new Map(); const chunks = []; let total = 0; const newBV = [];
for (const bi of [...bvUsed].sort((a, b) => a - b)) {
  const bv = g.bufferViews[bi];
  const bytes = bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  const pad = (4 - (total % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); total += pad; }
  bvMap.set(bi, newBV.length);
  const nb = { buffer: 0, byteOffset: total, byteLength: bv.byteLength }; if (bv.byteStride) nb.byteStride = bv.byteStride; if (bv.target) nb.target = bv.target;
  newBV.push(nb); chunks.push(bytes); total += bytes.length;
}
const accMap = new Map(); const newAcc = [];
for (const ai of [...accUsed].sort((a, b) => a - b)) {
  const a = Object.assign({}, g.accessors[ai]);
  if (a.bufferView !== undefined) a.bufferView = bvMap.get(a.bufferView);
  accMap.set(ai, newAcc.length); newAcc.push(a);
}
const meshMap = new Map(); const newMeshes = [];
g.meshes.forEach((m, mi) => {
  if (!meshUsed.has(mi)) return;
  const nm = { name: m.name, primitives: m.primitives.map(p => { const q = Object.assign({}, p); q.attributes = {}; for (const k in p.attributes) q.attributes[k] = accMap.get(p.attributes[k]); if (p.indices !== undefined) q.indices = accMap.get(p.indices); return q; }) };
  meshMap.set(mi, newMeshes.length); newMeshes.push(nm);
});
for (const n of g.nodes) if (n.mesh !== undefined) n.mesh = meshMap.get(n.mesh);
for (const s of g.skins || []) if (s.inverseBindMatrices !== undefined) s.inverseBindMatrices = accMap.get(s.inverseBindMatrices);
for (const a of g.animations) for (const s of a.samplers) { s.input = accMap.get(s.input); s.output = accMap.get(s.output); }
for (const im of g.images || []) if (im.bufferView !== undefined) im.bufferView = bvMap.get(im.bufferView);
g.bufferViews = newBV; g.accessors = newAcc; g.meshes = newMeshes;
g.buffers = [{ byteLength: total }];
delete g.extras;

const binBuf = Buffer.concat(chunks, total);
const binPad = Buffer.concat([binBuf, Buffer.alloc((4 - (binBuf.length % 4)) % 4)]);
const j = Buffer.from(JSON.stringify(g), 'utf8');
const jPad = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
const size = 12 + 8 + jPad.length + 8 + binPad.length;
const out = Buffer.alloc(size);
out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(size, 8);
out.writeUInt32LE(jPad.length, 12); out.writeUInt32LE(0x4e4f534a, 16); jPad.copy(out, 20);
let o = 20 + jPad.length;
out.writeUInt32LE(binPad.length, o); out.writeUInt32LE(0x004e4942, o + 4); binPad.copy(out, o + 8);
fs.writeFileSync(dst, out);
console.log(dst.replace(/.*[\\/]/, '').padEnd(24) + String(ab.length).padStart(9) + ' -> ' + String(out.length).padStart(8) + ' bytes, anims ' + g.animations.length + ', meshes ' + newMeshes.length);
