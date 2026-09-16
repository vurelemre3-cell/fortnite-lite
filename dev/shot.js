#!/usr/bin/env node
'use strict';
/* Screenshot + probe tool for the ?auto= screenshot mode, driven over the
   DevTools protocol so it can also run JavaScript in the page (end screen,
   frame-time probes, settings) — things `chrome --screenshot` cannot do.

     node dev/shot.js out.png "http://localhost:3500/?auto=1&poi=0" [jsAfterReady]

   Waits for document.title === 'READY' (auto mode sets it once its frame is
   drawn), runs the optional JS (a promise is awaited; its value is printed as
   JSON), then re-renders through `__shot()` if the page defines it and saves a
   PNG. Env: CHROME=path to chrome.exe, W / H window size (default 1280x720). */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const W = +process.env.W || 1280, H = +process.env.H || 720;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

async function main() {
  const [out, url, js] = process.argv.slice(2);
  if (!out || !url) { console.error('usage: node dev/shot.js out.png url [js]'); process.exit(2); }
  const port = 9400 + Math.floor(Math.random() * 500);
  const tag = 'shot-' + port + '-' + Date.now();
  const p = spawn(CHROME, ['--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--window-size=' + W + ',' + H, '--hide-scrollbars', '--remote-debugging-port=' + port,
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '\\fl-' + tag, '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60 && !targets; i++) { await sleep(500); try { targets = (await getJson('http://localhost:' + port + '/json')).filter(t => t.type === 'page'); if (!targets.length) targets = null; } catch (e) { /* not up */ } }
  if (!targets) { p.kill(); throw new Error('chrome did not come up'); }
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text));
    return r.result.result.value;
  };
  try {
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await send('Page.enable');
    await send('Page.navigate', { url });
    let ready = false;
    for (let i = 0; i < 240 && !ready; i++) { await sleep(250); try { ready = await ev('document.title === "READY"'); } catch (e) { /* navigating */ } }
    if (!ready) console.error('warning: page never reported READY');
    if (js) {
      const v = await ev(js);
      if (v !== undefined) console.log(JSON.stringify(v));
      // auto mode exposes __shot() to redraw one frame after the probe changed things
      await ev('typeof __shot === "function" ? __shot() : null');
      await sleep(150);
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    const status = await ev('window.__READY ? JSON.stringify(window.__READY) : ""');
    if (status) console.log(status);
  } finally { ws.close(); p.kill(); }
}
main().catch(e => { console.error(e.message); process.exit(1); });
