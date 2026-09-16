'use strict';
/* =============================================================================
   fortnite-lite / net.js
   Lobbies and the multiplayer sync layer.

   The server (server.js) is only a relay: it hands out lobby codes, keeps the
   player list and forwards messages. The lobby HOST's browser runs the match —
   bots, storm, loot, structural collapse and everyone's health — exactly the
   way solo play does, and broadcasts what it decides. Every player simulates
   their own movement, aiming, shooting and building locally so their controls
   feel instant, and sends their pose 20 times a second; other players are drawn
   from those poses, interpolated a little behind real time. Hits, pickups,
   drops, chests and heals go to the host as requests; the host applies them
   and the result comes back to everyone in its snapshots and events.
   ============================================================================= */

const NET_LAG = 120;          // ms remote players are drawn behind the newest pose
const NET_STATE_HZ = 20;      // own pose
const NET_SNAP_HZ = 12;       // host snapshot (health, storm, bots)

const r1 = x => Math.round(x * 10) / 10;
const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;

const Net = {
  ws: null,
  id: 0, code: '', hostId: 0, players: [],
  active: false,              // in a lobby
  inMatch: false,             // playing a lobby match (as host or client)
  endTitle: '',               // end-screen headline once the host ends the match
  pendingTake: new Map(),     // loot id -> { swap, t } while the host decides
  stT: 0, snapT: 0,
  ui: null,

  get hosting() { return this.inMatch && this.id === this.hostId; },
  get client() { return this.inMatch && this.id !== this.hostId; },

  /* ------------------------------ transport ------------------------------- */

  url() {
    const q = new URLSearchParams(location.search).get('server');
    let base = q || window.NET_SERVER || '';
    if (!base) {
      if (!location.host) throw new Error('Multiplayer needs the game served over http — run node server.js');
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    }
    base = base.replace(/^http/, 'ws').replace(/\/+$/, '');
    if (!/^wss?:\/\//.test(base)) base = 'wss://' + base;
    return base + '/ws';
  },

  connect() {
    if (this.ws && this.ws.readyState === 1) return Promise.resolve();
    return new Promise((res, rej) => {
      let ws, opened = false;
      try { ws = new WebSocket(this.url()); } catch (err) { rej(err); return; }
      const fail = () => rej(new Error("Can't reach the game server — multiplayer needs the Node server (see README)"));
      ws.onopen = () => { opened = true; this.ws = ws; res(); };
      ws.onerror = () => { if (!opened) fail(); };
      ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.onClose(); } if (!opened) fail(); };
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (err) { return; } this.onMessage(m); };
    });
  },
  raw(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); },
  to(to, d) { this.raw({ t: 'to', to, d }); },
  bcast(d) { this.to('all', d); },
  toHost(d) { this.to('host', d); },

  /* -------------------------------- lobby --------------------------------- */

  async create(name, skin) { await this.connect(); this.raw({ t: 'create', name, skin }); },
  async join(code, name, skin) { await this.connect(); this.raw({ t: 'join', code, name, skin }); },
  leave() {
    if (this.active) this.raw({ t: 'leave' });
    this.resetLobby();
  },
  resetLobby() {
    this.active = false; this.inMatch = false; this.endTitle = '';
    this.id = 0; this.code = ''; this.hostId = 0; this.players = [];
    this.pendingTake.clear();
    if (this.ui) this.ui.show('join');
  },
  onClose() {
    const was = this.active, playing = this.inMatch;
    this.resetLobby();
    if (was && this.ui) this.ui.err('Disconnected from the game server');
    if (playing) this.onEnd(null, 'DISCONNECTED');
  },

  onMessage(m) {
    switch (m.t) {
      case 'joined':
        this.active = true; this.id = m.id; this.code = m.code; this.hostId = m.hostId; this.players = m.players;
        if (this.ui) { this.ui.show('room'); this.ui.render(); }
        break;
      case 'players': {
        const before = this.players;
        this.hostId = m.hostId; this.players = m.players;
        if (this.ui) this.ui.render();
        if (this.hosting) this.playersLeft(before);
        break;
      }
      case 'hostLeft':
        this.hostId = m.hostId;
        // The match lived in the host's tab, so it is over. Leaving inMatch set
        // used to make whoever inherited the lobby "host" a dead match at once:
        // snapshots of a world it never had authority over, hit and loot requests
        // answered from stale state.
        if (this.inMatch) { this.onEnd(null, 'HOST LEFT'); this.inMatch = false; this.pendingTake.clear(); }
        if (this.ui) this.ui.render();
        break;
      case 'err': if (this.ui) this.ui.err(m.msg); break;
      case 'from': this.onGame(m.id, m.d); break;
    }
  },

  // Humans who dropped out of the lobby mid-match are out of the match too.
  playersLeft(before) {
    for (const p of before) {
      if (this.players.some(q => q.id === p.id)) continue;
      const e = entById(p.id);
      if (e && e.alive && e !== G.player) eliminate(e, null, true);
    }
  },

  /* ------------------------------- match ---------------------------------- */

  // Host: describe the match and start it everywhere at once.
  startMatch() {
    if (!this.active || this.id !== this.hostId) return;
    const d = {
      t: 'start',
      seed: (Math.random() * 4294967296) >>> 0,
      humans: this.players.map(p => ({ id: p.id, name: p.name, skin: p.skin })),
      bots: this.ui ? this.ui.bots() : true,
    };
    this.raw({ t: 'lock', on: true });
    this.bcast(d);
    this.applyStart(d);
  },
  applyStart(d) {
    this.inMatch = true; this.endTitle = ''; this.pendingTake.clear();
    this.stT = 0; this.snapT = 0;
    startGame({ seed: d.seed, humans: d.humans, bots: !!d.bots, myId: this.id, authority: this.id === this.hostId });
  },

  // The match is over for me: the winner is named, or the host went away.
  onEnd(winnerId, title) {
    const w = winnerId ? entById(winnerId) : null;
    if (w && w === G.player && G.player.alive) {
      if (G.state !== 'win') {
        G.state = 'win'; G.placement = 1; Sfx.win();
        if (G.player.anim) G.player.anim.play('Cheer', 0.2, true);
        if (document.pointerLockElement) document.exitPointerLock();
      }
      return;
    }
    this.endTitle = title || (w ? w.name.toUpperCase() + ' WINS' : 'MATCH OVER');
    G.spec = null;
    if (G.player.alive) G.placement = Math.max(1, G.alive);
    G.state = 'dead';
    if (document.pointerLockElement) document.exitPointerLock();
  },

  // Leave the match screen for the lobby panel. If I am the host, the match is
  // the thing running in my tab, so it ends for everyone.
  backToLobby() {
    if (this.inMatch) {
      if (this.hosting) {
        if (!this.endTitle && G.state !== 'win') this.bcast({ t: 'end', w: null });
        this.raw({ t: 'lock', on: false });
      } else this.toHost({ t: 'quit' });
    }
    this.inMatch = false; this.endTitle = ''; this.pendingTake.clear();
    showMenu();
    if (this.ui) { this.ui.show(this.active ? 'room' : 'join'); this.ui.render(); }
  },

  /* ------------------------------ game traffic ---------------------------- */

  onGame(from, d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'start') { if (from === this.hostId && this.active) this.applyStart(d); return; }
    if (!this.inMatch) return;
    const e = entById(from);
    const fromHost = from === this.hostId;
    switch (d.t) {
      // ---- everyone
      case 'st': if (e && e.remote) this.pushState(e, d); break;
      case 'tr':
        pushTracer(d.a[0], d.a[1], d.a[2], d.b[0], d.b[1], d.b[2], d.h ? [1.0, 0.95, 0.6] : [1.0, 0.55, 0.25]);
        if (dist2(G.player.pos[0], G.player.pos[2], d.a[0], d.a[2]) < 90 * 90) Sfx.shoot(d.w);
        break;

      // ---- requests to the host
      case 'hit': if (this.hosting && e) { const t = entById(d.e); if (t) applyDamage(t, +d.d || 0, e, !!d.h, false); } break;
      case 'dp': if (this.hosting) { const p = World.pieces.get(d.k); if (p) damagePiece(p, +d.d || 0, !!d.hv); } break;
      case 'dr': if (this.hosting) { const p = World.propById.get(d.i); if (p) damageProp(p, +d.d || 0); } break;
      case 'build':
        if (this.hosting && e) {
          if (!canPlace(d.ty, d.gx, d.gy, d.gz, d.rot)) break;
          const p = addPiece(d.ty, d.gx, d.gy, d.gz, d.rot, d.mat, e);
          if (!p) break;
          p.born = G.t;
          this.bcast({ t: 'piece', ty: p.type, gx: p.gx, gy: p.gy, gz: p.gz, rot: p.rot, mat: p.mat, o: e.id });
          this.pieceFx(p);
        }
        break;
      case 'take': if (this.hosting) { const l = lootById(d.l); if (l && l.cool <= 0) removeLoot(l, from); } break;
      case 'drop':
        if (this.hosting && d.l && d.l.kind) { const l = d.l; tossLoot(spawnLoot(l.kind, +l.x, +l.y, +l.z, l.data || {}), +l.vx || 0, +l.vy || 0, +l.vz || 0, +l.cool || 0); }
        break;
      case 'chest': if (this.hosting) { const ch = World.chests[d.i]; if (ch && !ch.opened) openChest(ch, e); } break;
      case 'heal':
        if (this.hosting && e && e.alive) {
          if (d.k === 'shield') e.shield = Math.min(100, e.shield + 50); else e.hp = Math.min(100, e.hp + 100);
        }
        break;
      case 'quit': if (this.hosting && e && e.alive) eliminate(e, null, true); break;

      // ---- the host's word
      case 'snap': if (fromHost) this.applySnap(d); break;
      case 'piece':
        if (fromHost) {
          const key = pieceKey(d.ty, d.gx, d.gy, d.gz, d.rot);
          let p = World.pieces.get(key);
          if (p && p.mat === d.mat) { p.owner = entById(d.o) || p.owner; break; }
          if (p) removePiece(p, true);
          p = addPiece(d.ty, d.gx, d.gy, d.gz, d.rot, d.mat, entById(d.o));
          if (p) { p.born = G.t; this.pieceFx(p); }
        }
        break;
      case 'pgone': if (fromHost) { const p = World.pieces.get(d.k); if (p) { removePiece(p, true); const [cx, cz] = tileCenter(p.gx, p.gz); materialChips(MAT_COLOR[p.mat], cx, p.gy * LEV + 1.5, cz, 6); } } break;
      case 'collapse': if (fromHost) for (const k of d.ks) { const p = World.pieces.get(k); if (p) collapsePiece(p); } break;
      case 'prgone': if (fromHost) { const p = World.propById.get(d.i); if (p) destroyProp(p); } break;
      case 'lspawn':
        if (fromHost && d.l) {
          const s = d.l;
          if (lootById(s.id)) break;
          const l = spawnLoot(s.kind, s.x, s.y, s.z, s.data || {});
          l.id = s.id; World.nextLootId = Math.max(World.nextLootId, s.id + 1);
          tossLoot(l, s.vx, s.vy, s.vz, s.cool);
        }
        break;
      case 'lgone':
        if (fromHost) {
          const l = lootById(d.i);
          const pend = this.pendingTake.get(d.i);
          this.pendingTake.delete(d.i);
          if (!l) break;
          if (d.by === this.id) { if (!takeLoot(G.player, l, pend ? pend.swap : false)) removeLoot(l); }
          else removeLoot(l);
        }
        break;
      case 'chestOpen':
        if (fromHost) { const ch = World.chests[d.i]; if (ch && !ch.opened) { ch.opened = true; ch.openT = 0; chestBurst(ch, null); if (dist2(G.player.pos[0], G.player.pos[2], ch.x, ch.z) < 45 * 45) Sfx.pickup(); } }
        break;
      case 'elim': if (fromHost) { const t = entById(d.e); if (t) eliminate(t, d.by ? entById(d.by) : null, !!d.s, d.pl); } break;
      case 'end': if (fromHost) this.onEnd(d.w); break;
    }
  },

  pieceFx(p) {
    const [cx, cz] = tileCenter(p.gx, p.gz);
    materialChips(MAT_COLOR[p.mat], cx, p.gy * LEV + 0.5, cz, 6);
    if (dist2(cx, cz, G.player.pos[0], G.player.pos[2]) < 60 * 60) Sfx.build();
  },

  /* ---------------------------- poses / snapshots -------------------------- */

  packInv(e) { return e.inv.map(it => it ? [it.id, it.rar, it.mag] : 0); },
  pose(e) {
    return {
      p: [r2(e.pos[0]), r2(e.pos[1]), r2(e.pos[2])], v: [r1(e.vel[0]), r1(e.vel[1]), r1(e.vel[2])],
      y: r3(e.yaw), pt: r3(e.pitch), g: e.grounded ? 1 : 0, gl: e.glide ? 1 : 0,
      sl: e.slot, inv: this.packInv(e), m: e.mats, bm: e.buildMode ? 1 : 0, ads: e.ads ? 1 : 0,
      up: e.upSeq ? [e.upSeq, e.upName, e.upDur] : 0, mz: e.muzzleT > 0 ? 1 : 0,
    };
  },

  sendState() {
    const e = G.player;
    if (!e.alive) return;
    this.bcast(Object.assign({ t: 'st' }, this.pose(e)));
  },
  sendSnap() {
    const s = G.storm;
    const d = {
      t: 'snap', al: G.alive,
      sm: { cx: r2(s.cx), cz: r2(s.cz), r: r2(s.r), tcx: r2(s.tcx), tcz: r2(s.tcz), tr: r2(s.tr), ph: s.phase, tm: r2(s.timer),
        sk: s.shrinking ? 1 : 0, dps: s.dps, fr: r2(s.fromR), fx: r2(s.fromX), fz: r2(s.fromZ), sd: s.shrinkDur },
      es: [],
    };
    for (const e of G.ents) {
      const es = { i: e.id, hp: r1(e.hp), sh: r1(e.shield), k: e.kills, al: e.alive ? 1 : 0, hu: e.hurtT > 0 ? 1 : 0 };
      if (e.hurtT > 0 && e.lastHitBy) es.hb = e.lastHitBy;   // who hit them, for the damage direction arc
      if (e.isBot && e.alive) Object.assign(es, this.pose(e));
      d.es.push(es);
    }
    this.bcast(d);
  },

  tick(dt) {
    this.stT += dt;
    if (this.stT >= 1 / NET_STATE_HZ) { this.stT = 0; this.sendState(); }
    if (this.hosting) {
      this.snapT += dt;
      if (this.snapT >= 1 / NET_SNAP_HZ) { this.snapT = 0; this.sendSnap(); }
    }
    if (this.pendingTake.size) {   // a request the host never answered (item already gone)
      const now = performance.now();
      for (const [id, p] of this.pendingTake) if (now - p.t > 1500) this.pendingTake.delete(id);
    }
  },

  applySnap(d) {
    if (!this.client) return;
    G.alive = d.al;
    const s = G.storm, ss = d.sm;
    if (ss.sk && !s.shrinking) say('THE STORM IS CLOSING');
    s.cx = ss.cx; s.cz = ss.cz; s.r = ss.r; s.tcx = ss.tcx; s.tcz = ss.tcz; s.tr = ss.tr;
    s.phase = ss.ph; s.timer = ss.tm; s.shrinking = !!ss.sk; s.dps = ss.dps;
    s.fromR = ss.fr; s.fromX = ss.fx; s.fromZ = ss.fz; s.shrinkDur = ss.sd;
    for (const es of d.es) {
      const e = entById(es.i);
      if (!e) continue;
      const had = e.hp + e.shield;
      e.hp = es.hp; e.shield = es.sh; e.kills = es.k;
      if (e === G.player) {
        if (e.alive && e.hp + e.shield < had - 0.01) {
          G.hurtFlash = 0.35; Sfx.hurt(); e.hurtT = 0.25; playUpper(e, 'Hit_A', 0.45);
          const by = es.hb ? entById(es.hb) : null;
          if (by && by !== e) hurtFrom(by.pos[0], by.pos[2]);
        }
      } else if (es.hu && !(e.hurtT > 0)) {
        e.hurtT = 0.25;
        if (e.human) playUpper(e, 'Hit_A', 0.45);
      }
      if (!es.al && e.alive) eliminate(e, null, true);   // in case the elim event was missed
      if (e.isBot && es.p && e.remote) this.pushState(e, es);
    }
  },

  // A remote pose arrives: queue it for interpolation, apply the discrete bits now.
  pushState(e, d) {
    if (!e.nb) e.nb = [];
    e.nb.push({ rt: performance.now(), p: d.p, v: d.v, yaw: d.y, pitch: d.pt, g: !!d.g, gl: !!d.gl });
    if (e.nb.length > 16) e.nb.shift();
    if (d.inv) e.inv = d.inv.map(it => it ? { id: it[0], rar: it[1], mag: it[2] } : null);
    if (d.m) e.mats = d.m;
    e.slot = d.sl | 0;
    e.buildMode = !!d.bm; e.ads = !!d.ads;
    if (d.up && d.up[0] !== e.upSeen) { e.upSeen = d.up[0]; playUpper(e, d.up[1], d.up[2]); }
    if (d.mz) { e.muzzleT = 0.06; e.gunKick = 1; }   // muzzle flash + the third-person jolt
  },

  // Place a remote entity a little behind real time, between the two poses that
  // bracket that moment; past the newest pose, coast on its velocity briefly.
  interp(e, now) {
    const buf = e.nb;
    if (!buf || !buf.length) return;
    const rt = now - NET_LAG;
    let i = buf.length - 1;
    while (i >= 0 && buf[i].rt > rt) i--;
    let px, py, pz, yaw, pitch, s;
    if (i < 0) { s = buf[0]; px = s.p[0]; py = s.p[1]; pz = s.p[2]; yaw = s.yaw; pitch = s.pitch; }
    else if (i < buf.length - 1) {
      const a = buf[i], b = buf[i + 1]; s = a;
      const k = clamp((rt - a.rt) / Math.max(1, b.rt - a.rt), 0, 1);
      px = lerp(a.p[0], b.p[0], k); py = lerp(a.p[1], b.p[1], k); pz = lerp(a.p[2], b.p[2], k);
      yaw = a.yaw + angleDelta(a.yaw, b.yaw) * k; pitch = lerp(a.pitch, b.pitch, k);
    } else {
      s = buf[i];
      const ex = Math.min(0.25, (rt - s.rt) / 1000);
      px = s.p[0] + s.v[0] * ex; py = s.p[1] + (s.g ? 0 : s.v[1] * ex); pz = s.p[2] + s.v[2] * ex;
      yaw = s.yaw; pitch = s.pitch;
    }
    while (buf.length > 2 && buf[1].rt < rt) buf.shift();
    e.pos[0] = px; e.pos[1] = py; e.pos[2] = pz;
    e.yaw = yaw; e.pitch = pitch;
    e.vel[0] = s.v[0]; e.vel[1] = s.v[1]; e.vel[2] = s.v[2];
    e.grounded = s.g; e.glide = s.gl;
  },

  /* ------------------------------ senders --------------------------------- */

  hit(target, dmg, head) { this.toHost({ t: 'hit', e: target.id, d: r1(dmg), h: head ? 1 : 0 }); },
  dmgPiece(key, dmg, harvest) { this.toHost({ t: 'dp', k: key, d: r1(dmg), hv: harvest ? 1 : 0 }); },
  dmgProp(id, dmg) { this.toHost({ t: 'dr', i: id, d: r1(dmg) }); },
  piecePlaced(p, e) {
    const m = { t: 'piece', ty: p.type, gx: p.gx, gy: p.gy, gz: p.gz, rot: p.rot, mat: p.mat, o: e.id };
    if (this.hosting) this.bcast(m); else { m.t = 'build'; this.toHost(m); }
  },
  take(l, swap) {
    if (this.pendingTake.has(l.id)) return true;
    this.pendingTake.set(l.id, { swap, t: performance.now() });
    this.toHost({ t: 'take', l: l.id });
    return true;
  },
  drop(l) { this.toHost({ t: 'drop', l }); },
  chest(i) { this.toHost({ t: 'chest', i }); },
  heal(k) { this.toHost({ t: 'heal', k }); },
  tracer(e, ax, ay, az, bx, by, bz) {
    if (e.remote) return;
    const it = curItem(e);
    this.bcast({ t: 'tr', a: [r1(ax), r1(ay), r1(az)], b: [r1(bx), r1(by), r1(bz)], w: it ? it.id : 'ar', h: e.human ? 1 : 0 });
  },
  packLoot(l) { return { id: l.id, kind: l.kind, x: r2(l.x), y: r2(l.y), z: r2(l.z), data: l.data, vx: r2(l.vx), vy: r2(l.vy), vz: r2(l.vz), cool: l.cool }; },
  lootGone(l, by) { this.bcast({ t: 'lgone', i: l.id, by }); },
  chestOpened(i) { this.bcast({ t: 'chestOpen', i }); },
  elim(e, attacker, byStorm, placement) { this.bcast({ t: 'elim', e: e.id, by: attacker ? attacker.id : null, s: byStorm ? 1 : 0, pl: placement }); },
  end(w) { this.bcast({ t: 'end', w: w ? w.id : null }); this.onEnd(w ? w.id : null); },

  /* --------------------------------- UI ----------------------------------- */

  init() {
    World.onPieceGone = p => { if (Net.hosting) Net.bcast({ t: 'pgone', k: p.key }); };
    World.onCollapse = keys => { if (Net.hosting) Net.bcast({ t: 'collapse', ks: keys }); };
    World.onPropGone = p => { if (Net.hosting) Net.bcast({ t: 'prgone', i: p.id }); };
    World.onLootToss = l => { if (Net.hosting) Net.bcast({ t: 'lspawn', l: Net.packLoot(l) }); };
    if (typeof document === 'undefined' || !document.getElementById('lobby')) return;   // headless harness
    this.ui = lobbyUI(this);
  },
};

function lobbyUI(net) {
  const $ = id => document.getElementById(id);
  const nameIn = $('nameIn'), skinSel = $('skinSel'), codeIn = $('codeIn'), err = $('lobbyErr');
  const joinBox = $('lobbyJoin'), roomBox = $('lobbyRoom');
  const SKIN_NAMES = { char_knight: 'Knight', char_barbarian: 'Barbarian', char_mage: 'Mage', char_rogue: 'Rogue', char_rogue_hooded: 'Hooded Rogue' };
  for (const k of CHAR_SKINS) { const o = document.createElement('option'); o.value = k; o.textContent = SKIN_NAMES[k] || k; skinSel.appendChild(o); }
  try {
    nameIn.value = localStorage.getItem('fl_name') || '';
    if (localStorage.getItem('fl_skin')) skinSel.value = localStorage.getItem('fl_skin');
  } catch (e) { /* storage blocked */ }
  const joinParam = new URLSearchParams(location.search).get('join');
  if (joinParam) codeIn.value = joinParam.toUpperCase().slice(0, 4);

  const ui = {
    show(which) {
      joinBox.style.display = which === 'join' ? '' : 'none';
      roomBox.style.display = which === 'room' ? '' : 'none';
      if (which === 'join') err.textContent = '';
    },
    err(msg) { err.textContent = msg; },
    bots() { return $('botsChk').checked; },
    render() {
      $('roomCode').textContent = net.code;
      // a statically hosted page reached its relay through ?server= — the invite has to carry it too
      const srv = new URLSearchParams(location.search).get('server');
      const link = location.origin + location.pathname + '?join=' + net.code + (srv ? '&server=' + encodeURIComponent(srv) : '');
      $('roomLink').textContent = link; $('roomLink').href = link;
      const list = $('playerList');
      list.innerHTML = '';
      for (const p of net.players) {
        const row = document.createElement('div');
        row.textContent = p.name + (p.id === net.hostId ? '  ·  host' : '') + (p.id === net.id ? '  (you)' : '');
        list.appendChild(row);
      }
      const host = net.id === net.hostId;
      $('startBtn').style.display = host ? '' : 'none';
      $('botsRow').style.display = host ? '' : 'none';
      $('waitMsg').style.display = host ? 'none' : '';
    },
  };
  const name = () => {
    const n = (nameIn.value || '').trim().slice(0, 14) || 'Player';
    try { localStorage.setItem('fl_name', n); localStorage.setItem('fl_skin', skinSel.value); } catch (e) { /* */ }
    return n;
  };
  const guard = fn => async () => { err.textContent = ''; try { await fn(); } catch (e) { err.textContent = e.message || String(e); } };
  $('createBtn').addEventListener('click', guard(() => net.create(name(), skinSel.value)));
  $('joinBtn').addEventListener('click', guard(() => {
    const code = codeIn.value.trim().toUpperCase();
    if (code.length !== 4) throw new Error('Enter the 4-letter lobby code');
    return net.join(code, name(), skinSel.value);
  }));
  codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
  nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') $('createBtn').click(); });
  $('startBtn').addEventListener('click', () => net.startMatch());
  $('leaveBtn').addEventListener('click', () => net.leave());
  ui.show('join');
  if (joinParam && codeIn.value.length === 4) setTimeout(() => nameIn.focus(), 0);
  return ui;
}
