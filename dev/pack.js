// pack.js <src.gltf|src.glb> <dst.glb> [options]
// Pack a .gltf (+ external .bin + images, or data: URIs) into one self-contained
// .glb, so assets/ stays one file per prop. Options:
//   --tex Material=file.png   give a material that ships without a texture one
//                             (Quaternius packs name the texture after the material)
//   --texdir <dir>            same, automatically: <dir>/<MaterialName>.png|jpg
//   --extern <rel/>           keep images *outside* the GLB as URIs relative to it
//                             (shared textures load once; see models.js imageKey)
//   --scale <k>               bake a uniform scale into the root nodes
// A PNG with an alpha channel makes its material alphaMode MASK, which the
// renderer draws and shadows as a cutout (leaf cards).
const fs = require('fs'), path = require('path');

const args = process.argv.slice(2);
const src = args[0], dst = args[1];
const opt = { tex: {}, texdir: null, extern: null, scale: 1 };
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--tex') { const [m, f] = args[++i].split('='); opt.tex[m] = f; }
  else if (args[i] === '--texdir') opt.texdir = args[++i];
  else if (args[i] === '--extern') opt.extern = args[++i];
  else if (args[i] === '--scale') opt.scale = parseFloat(args[++i]);
}
const dir = path.dirname(src);

// read a .gltf, or a .glb (JSON chunk + BIN chunk become buffer 0)
let g, glbBin = null;
{
  const raw = fs.readFileSync(src);
  if (raw.length > 12 && raw.readUInt32LE(0) === 0x46546c67) {
    const jl = raw.readUInt32LE(12);
    g = JSON.parse(raw.slice(20, 20 + jl).toString('utf8'));
    const bo = 20 + jl + 8;
    glbBin = raw.slice(bo, bo + raw.readUInt32LE(20 + jl));
  } else g = JSON.parse(raw.toString('utf8'));
}

const chunks = [];
let total = 0;
const append = (buf) => {                       // 4-byte aligned, glTF requires it
  const off = total;
  chunks.push(buf);
  total += buf.length;
  const pad = (4 - (total % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); total += pad; }
  return off;
};

// 1. every buffer becomes a slice of the single BIN chunk
const bufBase = (g.buffers || []).map((b, i) => {
  if (b.uri === undefined) { if (!glbBin || i !== 0) throw new Error('buffer ' + i + ' has no uri'); return append(glbBin); }
  if (/^data:/.test(b.uri)) return append(Buffer.from(b.uri.split(',')[1], 'base64'));
  return append(fs.readFileSync(path.join(dir, decodeURIComponent(b.uri))));
});
for (const bv of g.bufferViews || []) {
  bv.byteOffset = (bv.byteOffset || 0) + bufBase[bv.buffer || 0];
  bv.buffer = 0;
}

// 2. materials that ship without a base colour texture get one by name
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
g.images = g.images || []; g.textures = g.textures || []; g.samplers = g.samplers || [];
const findTex = name => {
  if (opt.tex[name]) return path.resolve(dir, opt.tex[name]);
  if (opt.texdir) for (const ext of ['.png', '.jpg', '.jpeg']) { const f = path.join(opt.texdir, name + ext); if (fs.existsSync(f)) return f; }
  return null;
};
const imageIndex = new Map();
for (const m of g.materials || []) {
  const pbr = m.pbrMetallicRoughness || (m.pbrMetallicRoughness = {});
  if (pbr.baseColorTexture) continue;
  const f = findTex(m.name);
  if (!f) continue;
  if (!imageIndex.has(f)) {
    imageIndex.set(f, g.images.push({ uri: path.relative(dir, f).split(path.sep).join('/'), mimeType: MIME[path.extname(f).toLowerCase()] || 'image/png' }) - 1);
  }
  const ti = g.textures.push({ source: imageIndex.get(f), sampler: 0 }) - 1;
  if (!g.samplers.length) g.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
  pbr.baseColorTexture = { index: ti };
  delete pbr.baseColorFactor;
  if (pngHasAlpha(fs.readFileSync(f))) m.alphaMode = 'MASK';
}

// 3. images: embed into new bufferViews, or point at a shared external copy
for (const img of g.images) {
  if (img.uri === undefined) continue;
  let bytes, name;
  if (/^data:/.test(img.uri)) { bytes = Buffer.from(img.uri.split(',')[1], 'base64'); name = 'image' + g.images.indexOf(img) + '.png'; }
  else { const file = path.join(dir, decodeURIComponent(img.uri)); bytes = fs.readFileSync(file); name = path.basename(file); }
  img.mimeType = img.mimeType || MIME[path.extname(name).toLowerCase()] || 'image/png';
  if (opt.extern) { img.uri = opt.extern + name; continue; }
  const off = append(bytes);
  img.bufferView = g.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: bytes.length }) - 1;
  delete img.uri;
}

// 4. optional uniform scale on the scene roots
if (opt.scale !== 1) {
  const scene = (g.scenes || [])[g.scene || 0];
  const roots = scene ? scene.nodes : (g.nodes || []).map((_, i) => i);
  for (const ni of roots) {
    const n = g.nodes[ni];
    if (n.matrix) { for (let i = 0; i < 12; i++) n.matrix[i] *= opt.scale; }
    else { n.scale = (n.scale || [1, 1, 1]).map(v => v * opt.scale); n.translation = (n.translation || [0, 0, 0]).map(v => v * opt.scale); }
  }
}

const bin = Buffer.concat(chunks, total);
g.buffers = [{ byteLength: bin.length }];
delete g.extras;

const j = Buffer.from(JSON.stringify(g), 'utf8');
const jPad = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
const size = 12 + 8 + jPad.length + 8 + bin.length;
const out = Buffer.alloc(size);
out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(size, 8);
out.writeUInt32LE(jPad.length, 12); out.writeUInt32LE(0x4e4f534a, 16); jPad.copy(out, 20);
let o = 20 + jPad.length;
out.writeUInt32LE(bin.length, o); out.writeUInt32LE(0x004e4942, o + 4); bin.copy(out, o + 8);
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, out);
console.log(path.basename(dst).padEnd(24) + String(out.length).padStart(8) + ' bytes');

// PNG colour type 4 / 6 carries alpha; a paletted PNG (3) does when it has a tRNS chunk.
function pngHasAlpha(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return false;
  const ct = buf[25];
  if (ct === 4 || ct === 6) return true;
  if (ct === 3) return buf.indexOf('tRNS', 8, 'latin1') > 0;
  return false;
}
