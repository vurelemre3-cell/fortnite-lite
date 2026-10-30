'use strict';
/* =============================================================================
   fortnite-lite / textures.js
   Procedural material textures, painted once at boot on 2D canvases and
   uploaded through Renderer.texture(). Nothing is downloaded: wood, brick and
   metal for build pieces, grass / rock / dirt for the terrain, a tileable
   noise map for clouds and macro variation, and a few item skins.
   ============================================================================= */

function _canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

// Tileable value noise: a lattice of `n` cells across the texture, hashed so
// the same (seed, n) always paints the same picture, bilinear + smoothstep.
function vnoise(x, y, n, size, seed) {
  const cs = size / n;
  const fx = x / cs, fy = y / cs;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const h = (a, b) => hash2(((a % n) + n) % n + seed * 131, ((b % n) + n) % n + seed * 71);
  const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}
function fbm(x, y, size, seed, octaves, base) {
  let s = 0, a = 0.5, n = base || 4, sum = 0;
  for (let i = 0; i < octaves; i++) { s += vnoise(x, y, n, size, seed + i * 7) * a; sum += a; a *= 0.5; n *= 2; }
  return s / sum;
}

// Per-pixel painter: fn(x, y) -> [r, g, b] in 0..1.
function paint(size, fn) {
  const c = _canvas(size), ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = fn(x, y), i = (y * size + x) * 4;
      d[i] = clamp(p[0], 0, 1) * 255; d[i + 1] = clamp(p[1], 0, 1) * 255; d[i + 2] = clamp(p[2], 0, 1) * 255;
      d[i + 3] = p.length > 3 ? clamp(p[3], 0, 1) * 255 : 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function texWood(size) {
  const plank = size / 4;
  return paint(size, (x, y) => {
    const row = Math.floor(y / plank), yy = y % plank;
    // planks are staggered: every other row is shifted half a plank length
    const shift = (row & 1) ? size / 2 : 0;
    const xx = (x + shift) % size;
    const seg = Math.floor(xx / (size / 2));
    const id = row * 7 + seg * 3;
    const tone = 0.90 + hash2(id, 3) * 0.20;
    const grain = fbm(x * 0.9, y * 6.0 + id * 37, size, 11 + id, 3, 8);
    let k = tone * (0.86 + grain * 0.28);
    let r = 0.80 * k, g = 0.60 * k, b = 0.37 * k;
    // dark seams between planks and at the plank ends
    const edge = Math.min(yy, plank - 1 - yy);
    const endEdge = Math.min(xx % (size / 2), size / 2 - 1 - (xx % (size / 2)));
    if (edge < 2 || endEdge < 2) { r *= 0.45; g *= 0.42; b *= 0.40; }
    else if (edge < 4) { r *= 0.8; g *= 0.78; b *= 0.76; }
    // a nail head near each plank end
    const nx = xx % (size / 2), ny = yy;
    if ((nx - 9) ** 2 + (ny - plank / 2) ** 2 < 6 || (nx - (size / 2 - 10)) ** 2 + (ny - plank / 2) ** 2 < 6) { r = 0.42; g = 0.42; b = 0.44; }
    return [r, g, b];
  });
}

function texBrick(size) {
  const bw = size / 4, bh = size / 8, mortar = 4;
  return paint(size, (x, y) => {
    const row = Math.floor(y / bh);
    const shift = (row & 1) ? bw / 2 : 0;
    const xx = (x + shift) % size, yy = y % bh;
    const col = Math.floor(xx / bw);
    const inMortar = yy < mortar || (xx % bw) < mortar;
    const n = fbm(x, y, size, 5, 3, 16);
    if (inMortar) { const m = 0.74 + n * 0.16; return [m, m * 0.98, m * 0.94]; }
    const id = row * 13 + col;
    const tone = 0.84 + hash2(id, 9) * 0.32;
    const speck = 0.9 + n * 0.2;
    return [0.70 * tone * speck, 0.36 * tone * speck, 0.30 * tone * speck];
  });
}

function texMetal(size) {
  const panel = size / 2;
  return paint(size, (x, y) => {
    const px = x % panel, py = y % panel;
    const brush = fbm(x * 0.5, y * 9, size, 21, 2, 32);
    let k = 0.92 + brush * 0.16;
    let r = 0.60 * k, g = 0.65 * k, b = 0.72 * k;
    const edge = Math.min(px, panel - 1 - px, py, panel - 1 - py);
    if (edge < 2) { r *= 0.55; g *= 0.55; b *= 0.58; }
    else if (edge < 4) { r *= 1.12; g *= 1.12; b *= 1.1; }
    // rivets inset from each corner
    for (const cx of [11, panel - 12]) for (const cy of [11, panel - 12]) {
      const d2 = (px - cx) ** 2 + (py - cy) ** 2;
      if (d2 < 9) { const hi = (px - cx) + (cy - py) < 0 ? 1.25 : 0.7; r = 0.55 * hi; g = 0.58 * hi; b = 0.62 * hi; }
      else if (d2 < 16) { r *= 0.6; g *= 0.6; b *= 0.62; }
    }
    return [r, g, b];
  });
}

function texGrass(size) {
  return paint(size, (x, y) => {
    const n = fbm(x, y, size, 33, 3, 6);
    const fine = fbm(x, y, size, 34, 2, 64);
    const blade = hash2(x, y) > 0.965 ? 0.16 : 0;
    const k = 0.80 + n * 0.32 + (fine - 0.5) * 0.22 + blade;
    return [0.34 * k, 0.56 * k, 0.24 * k];
  });
}

function texRock(size) {
  return paint(size, (x, y) => {
    const n = fbm(x, y, size, 41, 4, 6);
    const crack = Math.abs(fbm(x, y, size, 42, 3, 5) - 0.5) < 0.018 ? 0.55 : 1;
    const k = (0.72 + n * 0.5) * crack;
    return [0.56 * k, 0.53 * k, 0.49 * k];
  });
}

function texDirt(size) {
  return paint(size, (x, y) => {
    const n = fbm(x, y, size, 51, 4, 6);
    const fine = fbm(x, y, size, 52, 2, 40);
    const k = 0.84 + n * 0.26 + (fine - 0.5) * 0.14;
    return [0.47 * k, 0.37 * k, 0.26 * k];
  });
}

// Three independent smooth noise channels — r for clouds and terrain hue,
// g for the rock break-up, b for spare.
function texNoise(size) {
  return paint(size, (x, y) => [fbm(x, y, size, 61, 4, 4), fbm(x, y, size, 62, 4, 6), fbm(x, y, size, 63, 4, 8)]);
}

function texMedkit(size) {
  return paint(size, (x, y) => {
    const cx = x - size / 2, cy = y - size / 2;
    const arm = size * 0.14, len = size * 0.34;
    const cross = (Math.abs(cx) < arm && Math.abs(cy) < len) || (Math.abs(cy) < arm && Math.abs(cx) < len);
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y) < 4;
    if (edge) return [0.62, 0.64, 0.66];
    return cross ? [0.92, 0.16, 0.16] : [0.96, 0.96, 0.95];
  });
}

function texAmmo(size) {
  return paint(size, (x, y) => {
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
    const n = fbm(x, y, size, 71, 2, 8);
    if (edge < 5) return [0.24, 0.26, 0.20];
    const stripe = ((x + y) % 40) < 8 && y > size * 0.62;
    const k = 0.9 + n * 0.2;
    return stripe ? [0.85 * k, 0.72 * k, 0.25 * k] : [0.38 * k, 0.42 * k, 0.28 * k];
  });
}

function texBus(size) {
  return paint(size, (x, y) => {
    const win = y > size * 0.30 && y < size * 0.58;
    const frame = win && ((x % 48) < 5 || y < size * 0.30 + 4 || y > size * 0.58 - 4);
    if (win && !frame) return [0.22, 0.30, 0.40];
    if (frame) return [0.14, 0.18, 0.28];
    const stripe = y > size * 0.70 && y < size * 0.78;
    if (stripe) return [0.95, 0.95, 0.98];
    const n = fbm(x, y, size, 81, 2, 8);
    const k = 0.94 + n * 0.1;
    return [0.20 * k, 0.48 * k, 0.88 * k];
  });
}

const Textures = {
  build(R) {
    const t = {};
    t.wood = R.texture(texWood(256));
    t.brick = R.texture(texBrick(256));
    t.metal = R.texture(texMetal(256));
    // Higher-resolution terrain detail is most visible while sprinting over hills.
    t.grass = R.texture(texGrass(512));
    t.rock = R.texture(texRock(512));
    t.dirt = R.texture(texDirt(512));
    t.noise = R.texture(texNoise(256), { aniso: false });
    t.medkit = R.texture(texMedkit(128));
    t.ammo = R.texture(texAmmo(128));
    t.bus = R.texture(texBus(256));
    R.setTerrainTextures({ grass: t.grass, rock: t.rock, dirt: t.dirt, noise: t.noise });
    return t;
  },
};
