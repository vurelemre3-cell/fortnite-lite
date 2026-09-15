// Pack a .gltf + its external .bin + its external images into one self-contained
// .glb, so assets/ stays one file per prop.
const fs = require('fs'), path = require('path');

const src = process.argv[2], dst = process.argv[3];
const dir = path.dirname(src);
const g = JSON.parse(fs.readFileSync(src, 'utf8'));

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
const bufBase = (g.buffers || []).map(b => {
  if (b.uri === undefined) throw new Error('already a GLB');
  if (/^data:/.test(b.uri)) return append(Buffer.from(b.uri.split(',')[1], 'base64'));
  return append(fs.readFileSync(path.join(dir, decodeURIComponent(b.uri))));
});
for (const bv of g.bufferViews || []) {
  bv.byteOffset = (bv.byteOffset || 0) + bufBase[bv.buffer || 0];
  bv.buffer = 0;
}

// 2. external images move into new bufferViews
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
for (const img of g.images || []) {
  if (img.uri === undefined) continue;
  const file = path.join(dir, decodeURIComponent(img.uri));
  const bytes = fs.readFileSync(file);
  const off = append(bytes);
  img.mimeType = img.mimeType || MIME[path.extname(file).toLowerCase()] || 'image/png';
  img.bufferView = g.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: bytes.length }) - 1;
  delete img.uri;
}

const bin = Buffer.concat(chunks, total);
g.buffers = [{ byteLength: bin.length }];

const j = Buffer.from(JSON.stringify(g), 'utf8');
const jPad = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
const size = 12 + 8 + jPad.length + 8 + bin.length;
const out = Buffer.alloc(size);
out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(size, 8);
out.writeUInt32LE(jPad.length, 12); out.writeUInt32LE(0x4e4f534a, 16); jPad.copy(out, 20);
let o = 20 + jPad.length;
out.writeUInt32LE(bin.length, o); out.writeUInt32LE(0x004e4942, o + 4); bin.copy(out, o + 8);
fs.writeFileSync(dst, out);
console.log(path.basename(dst).padEnd(12) + String(out.length).padStart(8) + ' bytes');
