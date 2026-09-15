#!/usr/bin/env node
// Zero-dependency static server so the game can be played over http://
// (opening index.html straight off the filesystem also works in Chrome).
//
// It also live-reloads: index.html is rewritten on the way out so every <script>
// carries the newest source mtime as a cache-buster, and a small poller watches
// /__rev. Save a file, and the tab you are playing in picks it up — no hard
// refresh, no stale engine.js served out of the browser cache.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3500;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};
const SOURCES = ['index.html', 'engine.js', 'models.js', 'world.js', 'game.js'];

// newest mtime across the sources — changes the moment any of them is saved
function rev() {
  let t = 0;
  for (const f of SOURCES) {
    try { t = Math.max(t, fs.statSync(path.join(ROOT, f)).mtimeMs); } catch (e) { /* gone is fine */ }
  }
  return String(Math.round(t));
}

// Reload as soon as the build changes — but never yank the page out from under
// someone mid-match: with the mouse captured we wait for them to press Esc.
const RELOAD = r => `
<script>
(() => {
  let rev = ${JSON.stringify(r)}, pending = false;
  const go = () => { if (document.pointerLockElement) { pending = true; return; } location.reload(); };
  document.addEventListener('pointerlockchange', () => { if (pending && !document.pointerLockElement) location.reload(); });
  setInterval(async () => {
    try {
      const r = await (await fetch('/__rev', { cache: 'no-store' })).text();
      if (r !== rev) { rev = r; go(); }
    } catch (e) { /* server restarting */ }
  }, 700);
})();
</script>
`;

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const nocache = { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' };

  if (url === '/__rev') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain' }, nocache)).end(rev());
    return;
  }

  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    if (type === 'text/html') {
      const r = rev();
      data = Buffer.from(String(data)
        .replace(/(<script\s+src=")([^"?]+)(")/g, `$1$2?v=${r}$3`)
        .replace('</body>', RELOAD(r) + '</body>'));
    }
    res.writeHead(200, Object.assign({ 'Content-Type': type }, nocache));
    res.end(data);
  });
}).listen(PORT, () => console.log('fortnite-lite → http://localhost:' + PORT + '  (live reload on)'));
