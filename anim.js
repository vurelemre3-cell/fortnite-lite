'use strict';
/* =============================================================================
   fortnite-lite / anim.js
   Skeletal animation for the skinned glTF characters: clip sampling, cross-fade
   blending, an upper-body mask layer, and the joint palette the skinned shader
   consumes. models.js builds the `rig`; game.js owns the state machine that
   decides which clip plays.

   A rig is { nodes, order, parents, rest:{t,r,s}, names, palette, ibm, clips }:
   - order    parent-first node indices, so one pass builds world matrices
   - palette  node index per shader joint slot; ibm the matching inverse bind
   - clips    name -> { dur, ch:[{ node, path, times, vals, nc }] }, path 0/1/2
              = translation / rotation / scale
   ============================================================================= */

class Pose {
  constructor(rig) {
    const n = rig.nodes.length;
    this.rig = rig;
    this.t = new Float32Array(n * 3); this.r = new Float32Array(n * 4); this.s = new Float32Array(n * 3);
    this.reset();
  }
  reset() { this.t.set(this.rig.rest.t); this.r.set(this.rig.rest.r); this.s.set(this.rig.rest.s); }
  copyFrom(p) { this.t.set(p.t); this.r.set(p.r); this.s.set(p.s); }
}

// Index of the last keyframe at or before `t` (binary search).
function keyAt(times, t) {
  let lo = 0, hi = times.length - 1;
  if (t <= times[0]) return 0;
  if (t >= times[hi]) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
  return lo;
}

// Write (weight >= 1) or blend (weight < 1) one clip at time `t` into `pose`.
// Rotations are nlerp'd with the short-way sign fix; plenty for neighbouring
// keys and for cross-fades between similar poses.
function sampleClip(clip, t, pose, weight, mask) {
  const T = pose.t, R = pose.r, S = pose.s;
  const w = weight === undefined ? 1 : weight;
  for (let c = 0; c < clip.ch.length; c++) {
    const ch = clip.ch[c];
    if (mask && !mask[ch.node]) continue;
    const times = ch.times, vals = ch.vals, nc = ch.nc;
    const k = keyAt(times, t);
    const k2 = Math.min(k + 1, times.length - 1);
    const span = times[k2] - times[k];
    const f = span > 1e-6 ? clamp((t - times[k]) / span, 0, 1) : 0;
    const a = k * nc, b = k2 * nc;
    if (ch.path === 1) {
      let ax = vals[a], ay = vals[a + 1], az = vals[a + 2], aw = vals[a + 3];
      let bx = vals[b], by = vals[b + 1], bz = vals[b + 2], bw = vals[b + 3];
      if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
      let qx = ax + (bx - ax) * f, qy = ay + (by - ay) * f, qz = az + (bz - az) * f, qw = aw + (bw - aw) * f;
      const o = ch.node * 4;
      if (w < 1) {
        let px = R[o], py = R[o + 1], pz = R[o + 2], pw = R[o + 3];
        if (px * qx + py * qy + pz * qz + pw * qw < 0) { qx = -qx; qy = -qy; qz = -qz; qw = -qw; }
        qx = px + (qx - px) * w; qy = py + (qy - py) * w; qz = pz + (qz - pz) * w; qw = pw + (qw - pw) * w;
      }
      const l = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
      R[o] = qx / l; R[o + 1] = qy / l; R[o + 2] = qz / l; R[o + 3] = qw / l;
    } else {
      const out = ch.path === 0 ? T : S, o = ch.node * 3;
      for (let i = 0; i < 3; i++) {
        const v = vals[a + i] + (vals[b + i] - vals[a + i]) * f;
        out[o + i] = w < 1 ? out[o + i] + (v - out[o + i]) * w : v;
      }
    }
  }
}

// pose = lerp(pose, src, w), optionally only on masked nodes.
function blendPose(pose, src, w, mask) {
  const n = pose.rig.nodes.length;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const o3 = i * 3, o4 = i * 4;
    for (let k = 0; k < 3; k++) {
      pose.t[o3 + k] += (src.t[o3 + k] - pose.t[o3 + k]) * w;
      pose.s[o3 + k] += (src.s[o3 + k] - pose.s[o3 + k]) * w;
    }
    let qx = src.r[o4], qy = src.r[o4 + 1], qz = src.r[o4 + 2], qw = src.r[o4 + 3];
    const px = pose.r[o4], py = pose.r[o4 + 1], pz = pose.r[o4 + 2], pw = pose.r[o4 + 3];
    if (px * qx + py * qy + pz * qz + pw * qw < 0) { qx = -qx; qy = -qy; qz = -qz; qw = -qw; }
    qx = px + (qx - px) * w; qy = py + (qy - py) * w; qz = pz + (qz - pz) * w; qw = pw + (qw - pw) * w;
    const l = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
    pose.r[o4] = qx / l; pose.r[o4 + 1] = qy / l; pose.r[o4 + 2] = qz / l; pose.r[o4 + 3] = qw / l;
  }
}

// Pre-multiply node i's local rotation by the quaternion q (rotate about the
// node's own axes) — used to bend the spine toward the aim pitch.
function poseRotateLocal(pose, i, qx, qy, qz, qw) {
  const o = i * 4;
  const ax = pose.r[o], ay = pose.r[o + 1], az = pose.r[o + 2], aw = pose.r[o + 3];
  // (a * q): local rotation applied after the pose rotation, in the node's frame
  pose.r[o] = aw * qx + ax * qw + ay * qz - az * qy;
  pose.r[o + 1] = aw * qy - ax * qz + ay * qw + az * qx;
  pose.r[o + 2] = aw * qz + ax * qy - ay * qx + az * qw;
  pose.r[o + 3] = aw * qw - ax * qx - ay * qy - az * qz;
}

const _trs = mat4();
function poseToWorld(rig, pose, world) {
  const order = rig.order, parents = rig.parents;
  for (let k = 0; k < order.length; k++) {
    const i = order[k], p = parents[i];
    const o3 = i * 3, o4 = i * 4;
    m4FromTRS(_trs, [pose.t[o3], pose.t[o3 + 1], pose.t[o3 + 2]], [pose.r[o4], pose.r[o4 + 1], pose.r[o4 + 2], pose.r[o4 + 3]], [pose.s[o3], pose.s[o3 + 1], pose.s[o3 + 2]]);
    const w = world.subarray(i * 16, i * 16 + 16);
    if (p < 0) w.set(_trs);
    else m4Mul(w, world.subarray(p * 16, p * 16 + 16), _trs);
  }
}

function rigPalette(rig, world, out) {
  for (let j = 0; j < rig.palette.length; j++) {
    const n = rig.palette[j];
    const dst = out.subarray(j * 16, j * 16 + 16);
    if (rig.ibmIdentity[j]) dst.set(world.subarray(n * 16, n * 16 + 16));
    else m4Mul(dst, world.subarray(n * 16, n * 16 + 16), rig.ibm.subarray(j * 16, j * 16 + 16));
  }
}

// One character's animation state: a current clip, the clip it is fading from,
// and an optional upper-body layer sampled on top through a node mask.
class Animator {
  constructor(rig) {
    this.rig = rig;
    const n = rig.nodes.length;
    this.pose = new Pose(rig); this.tmp = new Pose(rig);
    this.world = new Float32Array(n * 16);
    this.joints = new Float32Array(Math.max(rig.palette.length, 1) * 16);
    this.cur = null; this.time = 0; this.loop = true; this.speed = 1;
    this.prev = null; this.prevTime = 0; this.prevLoop = true; this.fade = 0; this.fadeDur = 0.15;
    this.curName = '';
  }
  clip(name) { return this.rig.clips[name] || null; }
  // Switch to a clip (no-op if it is already playing). `restart` forces a
  // replay of a one-shot like a gunshot or a pickaxe swing.
  play(name, fadeDur, loop, restart) {
    if (name === this.curName && !restart) return;
    const c = this.clip(name);
    if (!c) return;
    if (this.cur && this.fadeDur > 0 && fadeDur !== 0) {
      this.prev = this.cur; this.prevTime = this.time; this.prevLoop = this.loop; this.fade = 1;
    } else this.fade = 0;
    this.fadeDur = fadeDur === undefined ? 0.15 : fadeDur;
    this.cur = c; this.curName = name; this.time = 0; this.loop = loop !== false;
  }
  update(dt) {
    this.time += dt * this.speed;
    if (this.fade > 0 && this.fadeDur > 0) { this.fade -= dt / this.fadeDur; this.prevTime += dt; }
    if (this.fade < 0) this.fade = 0;
  }
  done() { return !!this.cur && !this.loop && this.time >= this.cur.dur; }
  _t(clip, t, loop) { return clip.dur > 0 ? (loop ? t % clip.dur : Math.min(t, clip.dur)) : 0; }
  // Build this frame's pose. `upper` = { name, time, weight, mask } layers a
  // second clip over the masked nodes. Call finish() afterwards (the game may
  // tweak the pose in between, e.g. to aim the chest).
  evalPose(upper) {
    const pose = this.pose;
    pose.reset();
    if (!this.cur) return pose;
    sampleClip(this.cur, this._t(this.cur, this.time, this.loop), pose, 1);
    if (this.fade > 0 && this.prev) {
      this.tmp.reset();
      sampleClip(this.prev, this._t(this.prev, this.prevTime, this.prevLoop), this.tmp, 1);
      const f = this.fade;
      blendPose(pose, this.tmp, f * f * (3 - 2 * f));
    }
    if (upper && upper.weight > 0.001) {
      const c = this.clip(upper.name);
      if (c) {
        this.tmp.reset();
        sampleClip(c, this._t(c, upper.time, upper.loop !== false), this.tmp, 1);
        blendPose(pose, this.tmp, Math.min(1, upper.weight), upper.mask);
      }
    }
    return pose;
  }
  finish() {
    poseToWorld(this.rig, this.pose, this.world);
    rigPalette(this.rig, this.world, this.joints);
    return this.joints;
  }
  nodeWorld(i) { return this.world.subarray(i * 16, i * 16 + 16); }
}

// A mask (Uint8Array over nodes) covering `rootName` and everything under it.
function rigMask(rig, rootName) {
  const m = new Uint8Array(rig.nodes.length);
  const root = rig.names[rootName];
  if (root === undefined) return m;
  const walk = i => { m[i] = 1; for (const c of rig.nodes[i].children) walk(c); };
  walk(root);
  return m;
}
