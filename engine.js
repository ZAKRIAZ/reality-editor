// Reality Editor — core engine (BUILD 1)
(() => {
if (window.createRealityEngine) return; // idempotent under double-eval
// Camera + MediaPipe hand tracking, camera-only experience.
// Gesture FSM: point-trace shape -> pinch confirm -> pinch-drag move,
// two-hand pinch resize/rotate, open-palm dwell cycles power, fist clears.
// WebGL warp pipeline bends the live feed (rise / twist / lens) inside the selection.

const MP_VER = '0.10.14';
const MP_ESM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/+esm`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm`;
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const TAU = Math.PI * 2;

const POWERS = [
  { id: 'hologram', label: 'SELECT', color: '#e4e4e7', desc: 'Holographic selection' },
  { id: 'antigravity', label: 'GRAVITY OFF', color: '#d4d4d8', desc: 'Matter levitates' },
  { id: 'freeze', label: 'FREEZE TIME', color: '#f4f4f5', desc: 'Time stops inside' },
  { id: 'twist', label: 'SPACE TWIST', color: '#c0c3c9', desc: 'Space bends like rubber' },
  { id: 'cosmic', label: 'BLACK HOLE', color: '#9ca3af', desc: 'A black hole tears open' },
  { id: 'underwater', label: 'OCEAN', color: '#d4d4d8', desc: 'Water replaces the air' },
  { id: 'cyberpunk', label: 'NEON CITY', color: '#e4e4e7', desc: 'Neon-soaked reality' },
  { id: 'lava', label: 'LAVA', color: '#c0c3c9', desc: 'The molten world' },
  { id: 'pixel', label: 'PIXEL', color: '#f4f4f5', desc: 'Voxelized reality' },
  { id: 'void', label: 'VOID', color: '#9ca3af', desc: 'Only energy remains' },
  { id: 'thermal', label: 'THERMAL', color: '#e4e4e7', desc: 'Heat vision' },
  { id: 'holo', label: 'HOLOGRAM', color: '#d4d4d8', desc: 'Particle point-cloud' },
];

window.createRealityEngine = function createEngine(opts) { return new RealityEngine(opts); };

class RealityEngine {
  constructor(o) {
    this.stage = o.stage; this.video = o.video; this.fx = o.fx; this.ui = o.ui;
    this.onUpdate = o.onUpdate || (() => {});
    this.onPresence = o.onPresence || (() => {});
    this.intensity = o.intensity ?? 0.85;
    this.skeleton = !!o.skeleton;
    this.mode = 'boot';           // 'hands' | 'mouse'
    this.cameraOK = false;
    this.state = 'IDLE';          // IDLE | DRAWING | SELECTED | MOVING | TRANSFORM
    this.powerIdx = 0;
    this.sel = null;              // {pts:[{x,y}], center:{x,y}, scale, rot, kind}
    this.trail = [];
    this.hands = [];              // per-frame pose snapshots
    this.dwell = null;            // {kind:'palm'|'fist', t, pos}
    this.grab = null; this.twoGrab = null;
    this.fps = 0; this._lastHud = ''; this._t = 0; this._presented = false;
    this._destroyed = false; this._lost = 0; this._cool = 0;
    this.fxState = {};            // per-power scratch (particles etc.)
    this.powerT = 0;              // seconds since current power activated on a selection
    this.gl = null;               // WebGL warp pipeline (lazy)
    this.perfMode = o.perfMode || 'auto';
    this.shapeMode = o.shapeMode || 'panel';   // 'panel' (finger quad) | 'circle'
    this.qual = 1; this._detEvery = 1; this._detN = 0; this._qualT = 0; this.trackMs = 0;
    this.src = document.createElement('canvas'); this.src.width = 960; this.src.height = 540;
    this.srcCtx = this.src.getContext('2d');
    this.frozen = document.createElement('canvas'); this.frozen.width = 960; this.frozen.height = 540;
  }

  get power() { return POWERS[this.powerIdx]; }
  get powers() { return POWERS; }

  async start() {
    window.__re = this;   // debug/testing handle
    this.resize();
    this.gl = makeWarpGL(this.src.width, this.src.height);
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.stage);
    await this.initCamera();
    if (this.cameraOK) await this.initHands(); else this.setMode('nocam');
    this.watchPermission();
    this._last = performance.now();
    const loop = (now) => {
      if (this._destroyed) return;
      const dt = clamp((now - this._last) / 1000, 0.001, 0.1);
      this._last = now; this._t += dt;
      this.fps = lerp(this.fps || 60, 1 / dt, 0.05);
      try { this.tick(dt, now); } catch (err) { console.info('[reality] tick recovered:', err.message); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    this.hud(true);
  }

  destroy() {
    this._destroyed = true;
    if (this._permTimer) clearInterval(this._permTimer);
    try { this._ro && this._ro.disconnect(); } catch (e) {}
    try { this.video.srcObject && this.video.srcObject.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { this.lm && this.lm.close && this.lm.close(); } catch (e) {}
  }

  setOpts(o) {
    if (o.intensity != null) this.intensity = o.intensity;
    if (o.skeleton != null) this.skeleton = !!o.skeleton;
    if (o.perfMode) this.perfMode = o.perfMode;
  }

  setMode(m) { this.mode = m; this.hud(true); }

  async initCamera() {
    this.camBlocked = (() => {
      try { return window.top !== window.self && document.featurePolicy && !document.featurePolicy.allowsFeature('camera'); } catch (e) { return false; }
    })();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' }, audio: false,
      });
      // playsInline must be set imperatively: React drops the template's
      // lowercased playsinline attribute, and without it iOS Safari opens
      // the feed in the native fullscreen player over the AR overlay.
      this.video.playsInline = true;
      this.video.setAttribute('playsinline', '');
      this.video.srcObject = stream;
      try { await this.video.play(); } catch (e) {}
      if (this.video.readyState < 2) {
        await new Promise((res) => {
          const done = () => res();
          this.video.addEventListener('loadeddata', done, { once: true });
          setTimeout(done, 4000);
        });
        try { await this.video.play(); } catch (e) {}
      }
      this.camErr = null;
      this.cameraOK = true;
      this.video.style.opacity = '1';
    } catch (e) {
      console.info('[reality] camera unavailable:', e.name || e.message);
      this.camErr = e.name || String(e);
      this.cameraOK = false;
      this.video.style.opacity = '0';
      this.setMode('nocam');
      this.hud(true);
    }
  }

  async retryCamera() {
    if (this.cameraOK) return true;
    await this.initCamera();
    if (this.cameraOK) {
      if (this.lm) this.setMode('hands');
      else await this.initHands();
    }
    this.hud(true);
    return this.cameraOK;
  }

  // auto-start the feed the moment permission flips to granted
  watchPermission() {
    if (this.camBlocked || this.cameraOK || !navigator.permissions || !navigator.permissions.query) return;
    let busy = false;
    const check = async () => {
      if (this.cameraOK || this._destroyed || busy) return;
      busy = true;
      try {
        const p = await navigator.permissions.query({ name: 'camera' });
        if (p.state === 'granted' && !this.cameraOK) {
          console.info('[reality] permission granted — auto-starting camera');
          await this.retryCamera();
        }
      } catch (e) {}
      busy = false;
      if (this.cameraOK && this._permTimer) { clearInterval(this._permTimer); this._permTimer = null; }
    };
    this._permTimer = setInterval(check, 2500);
    check();
  }

  async initHands() {
    try {
      const t0 = performance.now();
      const mod = await Promise.race([
        import(/* @vite-ignore */ MP_ESM),
        new Promise((_, rej) => setTimeout(() => rej(new Error('cdn timeout')), 12000)),
      ]);
      const files = await mod.FilesetResolver.forVisionTasks(MP_WASM);
      this.lm = await mod.HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MP_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO', numHands: 2,
        minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      console.info('[reality] hand tracking ready in', Math.round(performance.now() - t0), 'ms');
      this.setMode('hands');
    } catch (e) {
      console.info('[reality] hand tracking unavailable:', e.message);
      this.setMode('notrack');
    }
  }

  // ---------- geometry ----------
  resize() {
    const r = this.stage.getBoundingClientRect();
    const base = this.qual < .8 ? 1 : 1.5;   // shrink canvases under load
    const dpr = clamp(window.devicePixelRatio || 1, 1, base);
    for (const cv of [this.fx, this.ui]) {
      cv.width = Math.max(2, Math.round(r.width * dpr));
      cv.height = Math.max(2, Math.round(r.height * dpr));
      cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.cw = r.width; this.ch = r.height;
  }
  cover() {
    const vw = this.cameraOK && this.video.videoWidth ? this.video.videoWidth : 640;
    const vh = this.cameraOK && this.video.videoHeight ? this.video.videoHeight : 360;
    const s = Math.max(this.cw / vw, this.ch / vh);
    const dw = vw * s, dh = vh * s;
    return { ox: (this.cw - dw) / 2, oy: (this.ch - dh) / 2, dw, dh };
  }
  nToPx(p) { const m = this._m; return { x: m.ox + p.x * m.dw, y: m.oy + p.y * m.dh }; }
  pxToN(x, y) { const m = this._m; return { x: (x - m.ox) / m.dw, y: (y - m.oy) / m.dh }; }

  selWorldPts() {
    const s = this.sel; if (!s) return [];
    const cos = Math.cos(s.rot), sin = Math.sin(s.rot);
    return s.pts.map(p => {
      const x = p.x * s.scale, y = p.y * s.scale * this._m.dw / this._m.dh * (this._m.dh / this._m.dw); // keep simple: uniform in norm space
      return { x: s.center.x + (x * cos - p.y * s.scale * sin), y: s.center.y + (x * sin + p.y * s.scale * cos) };
    });
  }
  selPath() {
    const pts = this.selWorldPts(); if (!pts.length) return null;
    const P = pts.map(p => this.nToPx(p));
    const path = new Path2D();
    if (this.sel && this.sel.kind === 'freeform' && P.length > 6) {
      path.moveTo((P[0].x + P[1].x) / 2, (P[0].y + P[1].y) / 2);
      for (let i = 1; i <= P.length; i++) {
        const a = P[i % P.length], b = P[(i + 1) % P.length];
        path.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
    } else {
      path.moveTo(P[0].x, P[0].y);
      for (let i = 1; i < P.length; i++) path.lineTo(P[i].x, P[i].y);
    }
    path.closePath();
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const q of P) { minx = Math.min(minx, q.x); miny = Math.min(miny, q.y); maxx = Math.max(maxx, q.x); maxy = Math.max(maxy, q.y); }
    return { path, x: minx, y: miny, w: maxx - minx, h: maxy - miny, pts };
  }
  ptInSel(n) {
    const g = this._selGeom; if (!g) return false;
    const p = this.nToPx(n);
    return this.fx.getContext('2d').isPointInPath(g.path, p.x * (this.fx.width / this.cw) / (this.fx.width / this.cw), p.y); // ctx transform already dpr-scaled; isPointInPath uses transformed space
  }

  present() {
    if (this._presented) return;
    this._presented = true;
    try { this.onPresence(); } catch (e) {}
  }

  setPower(i) {
    this.powerIdx = ((i % POWERS.length) + POWERS.length) % POWERS.length;
    this.activatePower();
    this.hud(true);
  }
  cyclePower() { this.setPower(this.powerIdx + 1); }
  setPowerById(id) { const i = POWERS.findIndex(p => p.id === id); if (i >= 0) this.setPower(i); }
  setShape(m) { this.shapeMode = m; if (this.state === 'FRAMING') this._frame = null; }
  clearSel() {
    if (this._selGeom) this._dying = { path: this._selGeom.path, t0: this._t };   // dissolve ring
    this.sel = null; this._frame = null; this.grab = null; this.twoGrab = null; this.state = 'IDLE'; this.fxState = {}; this.hud(true);
  }

  // ---------- hand pose extraction ----------
  readHands(now) {
    if (this.mode !== 'hands' || !this.lm || this.video.readyState < 2) { this.hands = []; return; }
    if ((this._detN++ % this._detEvery) !== 0) return;   // reuse last pose on skipped frames
    let res;
    const t0 = performance.now();
    try { res = this.lm.detectForVideo(this.video, now); } catch (e) { this.hands = []; return; }
    this.trackMs = lerp(this.trackMs || 8, performance.now() - t0, .2);
    const out = [];
    const L = res && res.landmarks ? res.landmarks : [];
    for (const raw of L) {
      const lm = raw.map(p => ({ x: 1 - p.x, y: p.y }));   // mirror to match selfie view
      const wrist = lm[0], scale = Math.max(0.02, dist(wrist, lm[9]));
      const ext = (tip, mcp) => dist(lm[tip], wrist) / Math.max(0.001, dist(lm[mcp], wrist)) > 1.32;
      const iExt = ext(8, 5), mExt = ext(12, 9), rExt = ext(16, 13), pExt = ext(20, 17);
      const pinchD = dist(lm[4], lm[8]) / scale;
      const prev = this.hands.find(h => dist(h.wrist, wrist) < 0.18);
      const wasPinch = prev ? prev.pinch : false;
      const pinch = wasPinch ? pinchD < 0.55 : pinchD < 0.38;
      const sm = (a, key) => {
        if (!prev) return a;
        const d = dist(prev[key], a);
        const al = clamp(.35 + d * 26, .35, .95);   // fast moves follow 1:1, slow moves damp jitter
        return { x: lerp(prev[key].x, a.x, al), y: lerp(prev[key].y, a.y, al) };
      };
      const extCount = (iExt ? 1 : 0) + (mExt ? 1 : 0) + (rExt ? 1 : 0) + (pExt ? 1 : 0);
      const fist = !iExt && !mExt && !rExt && !pExt && !pinch;
      const spread = clamp((dist(lm[4], lm[20]) / scale - 1.0) / 1.8, 0, 1);   // thumb-to-pinky span
      out.push({
        lm, wrist, scale, pinch, spread, fist,
        open: extCount >= 3 && !pinch && !fist,
        palm: iExt && mExt && rExt && pExt && !pinch,
        tips: [lm[4], lm[8], lm[12], lm[16], lm[20]],
        tipCenter: { x: (lm[4].x + lm[8].x + lm[12].x + lm[16].x + lm[20].x) / 5, y: (lm[4].y + lm[8].y + lm[12].y + lm[16].y + lm[20].y) / 5 },
        tip: sm(lm[8], 'tip'),
        pinchPos: sm({ x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 }, 'pinchPos'),
        palmCenter: sm({ x: (lm[0].x + lm[5].x + lm[17].x) / 3, y: (lm[0].y + lm[5].y + lm[17].y) / 3 }, 'palmCenter'),
      });
    }
    this.hands = out;
    if (out.length) this.present();
  }

  // ---------- FSM ----------
  fsm(dt) {
    const hands = this.hands;
    const h = hands[0];

    if (!h) {
      this._lost += dt;
      if (this.state === 'FRAMING' && this._lost > 0.5) { this.sel = null; this._frame = null; this.state = 'IDLE'; this.fxState = {}; this.hud(true); }
      if (this.state === 'MOVING' || this.state === 'TRANSFORM') this.state = 'SELECTED';
      if (this.state === 'SELECTED' && this._lost > 2) this.clearSel();   // hands gone → zone dissolves
      this.dwell = null; this.hud();
      return;
    }
    this._lost = 0;
    this._cool = Math.max(0, this._cool - dt);
    const two = hands.length > 1 ? hands[1] : null;
    if (!hands.some(hh => hh.fist)) this._fistLatch = false;   // fist released since lock

    // dwell gestures on a LOCKED area only (palm = cycle power, fist = clear)
    const dwellKind = (this.state === 'SELECTED' && this.sel)
      ? (h.palm ? 'palm' : (h.fist && !this._fistLatch ? 'fist' : null)) : null;
    if (dwellKind && !this._cool) {
      if (!this.dwell || this.dwell.kind !== dwellKind) this.dwell = { kind: dwellKind, t: 0, pos: h.palmCenter };
      if (dist(this.dwell.pos, h.palmCenter) > 0.055) this.dwell.t = 0;   // must hold still
      this.dwell.t += dt; this.dwell.pos = h.palmCenter;
      const need = dwellKind === 'palm' ? 0.9 : 0.8;
      if (this.dwell.t >= need) {
        if (dwellKind === 'palm') {
          // open palm on a locked zone = summon a NEW zone right here
          const pos = { ...h.palmCenter };
          this.clearSel();
          this.state = 'FRAMING'; this.frameT = 0; this._frame = null;
          this.frameFromHands(hands, dt);
          this.activatePower();
          this._cool = 0.4;
        } else { this.clearSel(); this._cool = 1.1; }
        this.dwell = null;
      }
    } else if (!dwellKind) this.dwell = null;

    switch (this.state) {
      case 'IDLE': {
        // deliberate summon: open hand held ~0.4s (no instant zone popping up)
        const openNow = hands.some(hh => hh.open);
        if (!this.sel && !this._cool && openNow) {
          const anchor = (hands.find(hh => hh.open) || h).palmCenter;
          if (!this._summon) this._summon = { t: 0, pos: anchor };
          if (dist(this._summon.pos, anchor) > 0.09) this._summon = { t: 0, pos: anchor };   // big moves reset
          this._summon.t += dt; this._summon.pos = anchor;
          if (this._summon.t >= 0.4) {
            this._summon = null;
            this.state = 'FRAMING'; this.frameT = 0; this._frame = null;
            this.frameFromHands(hands, dt);
            this.activatePower();
            this.hud(true);
          }
        } else this._summon = null;
        break;
      }
      case 'FRAMING': {
        this.frameT += dt;
        this.frameFromHands(hands, dt);
        const lock = hands.some(hh => hh.fist) || hands.some(hh => hh.pinch);
        if (lock && this.frameT > 0.35) {
          this.state = 'SELECTED';
          if (hands.some(hh => hh.fist)) this._fistLatch = true;
          this.activatePower();          // freeze captures the locked instant
          this.flashT = this._t;
          this._cool = 1.2;              // no instant dwell right after locking
          this.hud(true);
        }
        break;
      }
      case 'SELECTED': {
        if (this.sel && h.pinch && two && two.pinch) {
          this.state = 'TRANSFORM';
          this.twoGrab = {
            d0: Math.max(0.02, dist(h.pinchPos, two.pinchPos)),
            a0: Math.atan2(two.pinchPos.y - h.pinchPos.y, two.pinchPos.x - h.pinchPos.x),
            mid0: { x: (h.pinchPos.x + two.pinchPos.x) / 2, y: (h.pinchPos.y + two.pinchPos.y) / 2 },
            scale0: this.sel.scale, rot0: this.sel.rot, c0: { ...this.sel.center },
          };
          break;
        }
        if (this.sel && h.pinch && this.hitSel(h.pinchPos)) {
          this.state = 'MOVING';
          this.grab = { off: { x: this.sel.center.x - h.pinchPos.x, y: this.sel.center.y - h.pinchPos.y } };
          break;
        }
        break;
      }
      case 'MOVING': {
        if (!h.pinch) { this.state = 'SELECTED'; break; }
        this.sel.center.x = h.pinchPos.x + this.grab.off.x;
        this.sel.center.y = h.pinchPos.y + this.grab.off.y;
        break;
      }
      case 'TRANSFORM': {
        if (!two || !h.pinch || !two.pinch) { this.state = 'SELECTED'; this.twoGrab = null; break; }
        const g = this.twoGrab;
        const d = dist(h.pinchPos, two.pinchPos);
        const a = Math.atan2(two.pinchPos.y - h.pinchPos.y, two.pinchPos.x - h.pinchPos.x);
        const mid = { x: (h.pinchPos.x + two.pinchPos.x) / 2, y: (h.pinchPos.y + two.pinchPos.y) / 2 };
        this.sel.scale = clamp(g.scale0 * d / g.d0, 0.25, 3.5);
        this.sel.rot = g.rot0 + (a - g.a0);
        this.sel.center = { x: g.c0.x + (mid.x - g.mid0.x), y: g.c0.y + (mid.y - g.mid0.y) };
        break;
      }
    }
    // watchdog: never strand a non-IDLE state without a selection
    if (!this.sel && this.state !== 'IDLE' && this.state !== 'FRAMING') this.state = 'IDLE';
    this.hud();
  }

  // live zone from hand pose: palms place it, finger spread sizes it, two hands stretch it
  frameFromHands(hands, dt) {
    const open = hands.filter(hh => hh.open);
    // a frame never rebuilds from fewer hands than shaped it: fist/pinch mid-lock and
    // one-hand tracking dropouts hold the framed pose instead of degrading a two-hand
    // panel into the one-hand fallback
    if (this._frame && open.length < (this._frame.n || 1)) return;
    const use = open.length ? open : hands;
    const A = Math.max(0.2, this._m.dw / Math.max(1, this._m.dh));
    const k = 1 - Math.pow(0.000001, dt);
    const panel = this.shapeMode !== 'circle';
    let target = null, nHands = 0;
    if (panel && use.length >= 2 && use[0].tips && use[1].tips) {
      // quad panel held between the hands — corners pinned to each hand's thumb + index tips
      const [ha, hb] = use[0].palmCenter.x <= use[1].palmCenter.x ? [use[0], use[1]] : [use[1], use[0]];
      const aTop = ha.tips[1].y < ha.tips[0].y ? [ha.tips[1], ha.tips[0]] : [ha.tips[0], ha.tips[1]];
      const bTop = hb.tips[1].y < hb.tips[0].y ? [hb.tips[1], hb.tips[0]] : [hb.tips[0], hb.tips[1]];
      target = [aTop[0], bTop[0], bTop[1], aTop[1]];   // TL, TR, BR, BL
      nHands = 2;
    } else if (panel) {
      // one-hand panel: an upright rectangle around the hand — panel mode never shows a circle
      const hh = use[0];
      const cen = hh.tipCenter || hh.palmCenter;
      let mr = 0;
      if (hh.tips) for (const tp of hh.tips) mr = Math.max(mr, Math.hypot((tp.x - cen.x) * A, tp.y - cen.y));
      const ry = clamp(Math.max(mr * 1.4, hh.scale * 1.15), 0.07, 0.55);
      const rx = ry * 1.3 / A;
      target = [
        { x: cen.x - rx, y: cen.y - ry }, { x: cen.x + rx, y: cen.y - ry },
        { x: cen.x + rx, y: cen.y + ry }, { x: cen.x - rx, y: cen.y + ry },
      ];
      nHands = 1;
    }
    if (target) {
      if (!this._frame || !this._frame.quad) this._frame = { quad: true, n: nHands, corners: target.map(p => ({ x: p.x, y: p.y })) };
      else this._frame.n = nHands;   // 1 -> 2 hands: corners lerp toward the new pins
      const f = this._frame;
      for (let n = 0; n < 4; n++) {
        f.corners[n].x = lerp(f.corners[n].x, target[n].x, k);
        f.corners[n].y = lerp(f.corners[n].y, target[n].y, k);
      }
      const c = f.corners;
      const cx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4, cy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4;
      const wx = ((c[1].x + c[2].x) - (c[0].x + c[3].x)) / 2 * A, wy = ((c[1].y + c[2].y) - (c[0].y + c[3].y)) / 2;
      const hx = ((c[3].x + c[2].x) - (c[0].x + c[1].x)) / 2 * A, hy = ((c[3].y + c[2].y) - (c[0].y + c[1].y)) / 2;
      f.cx = cx; f.cy = cy;
      f.theta = Math.atan2(wy, wx);
      f.RX = Math.max(0.03, Math.hypot(wx, wy) * 0.75);   // 1.5x half-extent: ellipse mask covers the corners
      f.RY = Math.max(0.03, Math.hypot(hx, hy) * 0.75);
      this.sel = { pts: c.map(p => ({ x: p.x - cx, y: p.y - cy })), center: { x: cx, y: cy }, scale: 1, rot: 0, kind: 'quad' };
      return;
    }
    // circle mode only: one-hand circle, two-hand stretched ellipse
    let cx, cy, RX, RY, theta;
    if (use.length >= 2) {
      const a2 = use[0].tipCenter || use[0].palmCenter, b2 = use[1].tipCenter || use[1].palmCenter;
      cx = (a2.x + b2.x) / 2; cy = (a2.y + b2.y) / 2;
      const dxs = (b2.x - a2.x) * A, dys = b2.y - a2.y;
      theta = Math.atan2(dys, dxs);
      const sp = (use[0].spread + use[1].spread) / 2;
      RX = Math.hypot(dxs, dys) * 0.62 + 0.05;
      RY = clamp(RX * (0.45 + 0.55 * sp), 0.05, 0.6);
    } else {
      const hh = use[0];
      const cen = hh.tipCenter || hh.palmCenter;
      let mr = 0;
      if (hh.tips) for (const tp of hh.tips) mr = Math.max(mr, Math.hypot((tp.x - cen.x) * A, tp.y - cen.y));
      RY = clamp(Math.max(mr * 1.4, hh.scale * 1.15), 0.07, 0.55);
      RX = RY; theta = 0; cx = cen.x; cy = cen.y;
    }
    if (!this._frame || this._frame.quad) this._frame = { cx, cy, RX, RY, theta };
    else {
      const f = this._frame;
      f.cx = lerp(f.cx, cx, k); f.cy = lerp(f.cy, cy, k);
      f.RX = lerp(f.RX, RX, k); f.RY = lerp(f.RY, RY, k);
      let d = theta - f.theta;
      while (d > Math.PI / 2) d -= Math.PI;
      while (d < -Math.PI / 2) d += Math.PI;
      f.theta += d * k;
    }
    const f = this._frame;
    const pts = [];
    const ct = Math.cos(f.theta), st = Math.sin(f.theta);
    for (let n = 0; n < 48; n++) {
      const a = n / 48 * TAU;
      const xs = Math.cos(a) * f.RX, ys = Math.sin(a) * f.RY;
      pts.push({ x: (xs * ct - ys * st) / A, y: xs * st + ys * ct });
    }
    this.sel = { pts, center: { x: f.cx, y: f.cy }, scale: 1, rot: 0, kind: 'ellipse' };
  }

  hitSel(n) {
    const g = this._selGeom; if (!g) return false;
    const p = this.nToPx(n);
    const c = this.ui.getContext('2d');
    c.save(); c.setTransform(1, 0, 0, 1, 0, 0);   // identity: path coords and point are both raw CSS px
    const hit = c.isPointInPath(g.path, p.x, p.y);
    c.restore();
    return hit;
  }

  pushTrail(p) {
    const last = this.trail[this.trail.length - 1];
    if (!last) { this._ema = { x: p.x, y: p.y }; this.trail.push({ x: p.x, y: p.y }); return; }
    const e = this._ema || last;
    this._ema = { x: lerp(e.x, p.x, .5), y: lerp(e.y, p.y, .5) };   // pen-like damping
    if (dist(last, this._ema) > 0.004) this.trail.push({ ...this._ema });
    if (this.trail.length > 400) this.trail.shift();
  }

  confirmTrail() {
    if (this.trail.length < 8) { this.trail = []; this.state = this.sel ? 'SELECTED' : 'IDLE'; return; }
    const sel = classifyShape(this.trail);
    if (sel) { this.sel = sel; this.state = 'SELECTED'; this.activatePower(); this.flashT = this._t; }
    else this.state = this.sel ? 'SELECTED' : 'IDLE';
    this.trail = [];
    this.hud(true);
  }

  // ---------- effects ----------
  activatePower() {
    this.fxState = {};
    this.powerT = 0;
    if (!this.sel) return;
    if (this.power.id === 'freeze') {
      this.updateSrc();   // capture must be current-frame fresh
      const f = this.frozen.getContext('2d');
      f.clearRect(0, 0, this.frozen.width, this.frozen.height);
      f.drawImage(this.src, 0, 0);
      if (this.gl) this.uploadFrozen();
    }
  }

  updateSrc() {
    const c = this.srcCtx, W = this.src.width, H = this.src.height;
    if (this.cameraOK && this.video.readyState >= 2) {
      c.save(); c.translate(W, 0); c.scale(-1, 1);
      try { c.drawImage(this.video, 0, 0, W, H); } catch (e) {}
      c.restore();
    }
  }

  // adaptive governor: trade AI cadence + canvas resolution for frame rate
  perfGovern(dt) {
    this._qualT += dt;
    if (this._qualT < 1) return;
    this._qualT = 0;
    const f = this.fps;
    let q = this.qual, de = this._detEvery;
    if (this.perfMode === 'quality') { q = 1; de = 1; }
    else if (this.perfMode === 'speed') { q = .6; de = 2; }
    else {
      const heavyAI = (this.trackMs || 0) > 14;
      if (f < 34) { q = .6; de = 2; }                                  // last resort
      else if (f < 52) { q = Math.max(.6, q - .2); de = heavyAI ? 2 : 1; }  // shed pixels; halve AI cadence only when AI is the cost
      else if (f > 55) { q = Math.min(1, q + .2); de = 1; }
    }
    this._detEvery = de;
    const tierChanged = (q < .8) !== (this.qual < .8);
    this.qual = q;
    if (tierChanged) this.resize();
  }

  tick(dt, now) {
    this._m = this.cover();
    this.perfGovern(dt);
    if (this.sel) this.updateSrc();
    this.readHands(now);
    this._selGeom = this.selPath();
    this.fsm(dt);
    if (this.sel) this.powerT += dt;
    this.render(dt);
  }

  render(dt) {
    const fx = this.fx.getContext('2d');
    const ui = this.ui.getContext('2d');
    fx.clearRect(0, 0, this.cw, this.ch);
    ui.clearRect(0, 0, this.cw, this.ch);

    // base feed handled by <video>; nothing to composite when camera is off
    const g = this._selGeom;
    if (g && this.sel) {
      const env = { g, fx, dt, t: this._t, I: this.intensity, m: this._m, src: this.src, frozen: this.frozen, glOK: false };
      const id = this.power.id;
      // GPU pass: per-power treatment of the real pixels, feathered ellipse mask + rim light in-shader
      if (this.gl) {
        const midx = { hologram: 0, antigravity: 1, freeze: 2, twist: 3, cosmic: 4, underwater: 5, cyberpunk: 6, lava: 7, pixel: 8, void: 9, thermal: 10, holo: 11 }[id];
        const wc = this.warpDraw(midx == null ? 0 : midx);
        if (wc) {
          if (this.sel.kind === 'quad') { fx.save(); fx.clip(g.path); fx.drawImage(wc, this._m.ox, this._m.oy, this._m.dw, this._m.dh); fx.restore(); }
          else fx.drawImage(wc, this._m.ox, this._m.oy, this._m.dw, this._m.dh);
          env.glOK = true;
        }
      }
      fx.save(); fx.clip(g.path);
      if (id === 'antigravity') this.fxAntigravity(env);
      else if (id === 'freeze') this.fxFreeze(env);
      else if (id === 'cosmic') this.fxCosmic(env);
      else if (id === 'twist') this.fxTwist(env);
      else if (id === 'underwater' || id === 'cyberpunk' || id === 'lava' || id === 'pixel' || id === 'void' || id === 'thermal' || id === 'holo') {
        if (!env.glOK) this.fxDimFallback(env);
        this.fxDimAccent(env, id);
      }
      else if (!env.glOK) this.fxHologram(env);
      this.postFx(env);
      fx.restore();
    }

    this.drawSelectionUI(ui, g, dt);
    // dissolve-out: zone exhales when erased
    if (this._dying) {
      const k = (this._t - this._dying.t0) / 0.4;
      if (k >= 1) this._dying = null;
      else {
        ui.save();
        ui.globalAlpha = (1 - k) * .5;
        ui.strokeStyle = '#ffffff'; ui.lineWidth = 1 + k * 10;
        ui.stroke(this._dying.path);
        ui.restore();
      }
    }
    this.drawHands(ui);
    this.drawDwell(ui);
  }

  // upload the mirrored feed and run the warp shader for the active power
  warpDraw(mode) {
    const G = this.gl, sl = this.sel, f = this._frame;
    if (!G || !sl || !f) return null;
    if (mode === 2 && !G.hasFrozen) return null;   // freeze falls back to 2D until captured
    const gl = G.gl;
    const RXe = Math.max(0.02, f.RX * sl.scale), RYe = Math.max(0.02, f.RY * sl.scale);
    this._lensRsPx = 0.3 * Math.min(RXe, RYe) * this._m.dh;
    try {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, G.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.src);
    } catch (e) { return null; }
    gl.viewport(0, 0, G.cv.width, G.cv.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(G.u.uTime, this._t);
    gl.uniform1f(G.u.uMode, mode);
    gl.uniform1f(G.u.uIntensity, this.intensity);
    gl.uniform1f(G.u.uPowerT, this.powerT);
    gl.uniform1f(G.u.uAspect, this._m.dw / Math.max(1, this._m.dh));
    gl.uniform1f(G.u.uTheta, f.theta + sl.rot);
    gl.uniform2f(G.u.uCenter, sl.center.x, sl.center.y);
    gl.uniform2f(G.u.uRXY, RXe, RYe);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return G.cv;
  }

  uploadFrozen() {
    const G = this.gl; if (!G) return;
    try {
      const gl = G.gl;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, G.texF);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.frozen);
      gl.activeTexture(gl.TEXTURE0);
      G.hasFrozen = true;
    } catch (e) { G.hasFrozen = false; }
  }

  // holographic scan treatment for the plain SELECT power
  fxHologram({ g, fx, t, I }) {
    fx.fillStyle = `rgba(228,228,231,${0.05 * I})`;
    fx.fillRect(g.x, g.y, g.w, g.h);
    // faint holo grid
    fx.save(); fx.globalAlpha = .10 * I; fx.strokeStyle = '#e4e4e7'; fx.lineWidth = .7;
    const step = 26;
    for (let gx2 = g.x + (step - ((t * 8) % step)); gx2 < g.x + g.w; gx2 += step) { fx.beginPath(); fx.moveTo(gx2, g.y); fx.lineTo(gx2, g.y + g.h); fx.stroke(); }
    for (let gy2 = g.y + step / 2; gy2 < g.y + g.h; gy2 += step) { fx.beginPath(); fx.moveTo(g.x, gy2); fx.lineTo(g.x + g.w, gy2); fx.stroke(); }
    fx.restore();
    // dual scan sweeps
    fx.save(); fx.globalCompositeOperation = 'screen';
    for (const [speed, hgt, alpha] of [[70, 18, .16], [-46, 40, .07]]) {
      const span = g.h + hgt * 2;
      let yy = ((t * speed) % span + span) % span + g.y - hgt;
      const grad = fx.createLinearGradient(0, yy - hgt, 0, yy + hgt);
      grad.addColorStop(0, 'rgba(228,228,231,0)'); grad.addColorStop(.5, `rgba(140,240,255,${alpha * I})`); grad.addColorStop(1, 'rgba(228,228,231,0)');
      fx.fillStyle = grad; fx.fillRect(g.x, yy - hgt, g.w, hgt * 2);
    }
    // inner edge glow
    fx.strokeStyle = `rgba(228,228,231,${.20 * I})`; fx.lineWidth = 8;
    fx.stroke(g.path);
    fx.restore();
  }

  fxAntigravity(env) {
    const { g, fx, dt, t, I, m, src } = env;
    let S = this.fxState;
    if (!S.chunks) {
      S.t0 = t;
      S.chunks = []; S.dust = []; S.orbs = []; S.rings = [];
      const n = Math.round(9 + 7 * I);
      for (let i = 0; i < n; i++) {
        const w = 26 + Math.random() * 58, z = .4 + Math.random() * .6;
        S.chunks.push({
          u: Math.random(), v: Math.random(), w, h: w * (0.62 + Math.random() * 0.75), z,
          x: Math.random(), y: Math.random(), vy: -(0.012 + Math.random() * 0.03) * z, vx: (Math.random() - .5) * 0.007,
          rot: (Math.random() - .5) * 0.6, vr: (Math.random() - .5) * 0.3, ph: Math.random() * TAU,
          px: 0, py: 0, prot: 0, hasPrev: false,
        });
      }
      for (let i = 0; i < 60 * I; i++) S.dust.push({ x: Math.random(), y: Math.random(), z: .3 + Math.random() * .7, s: Math.random() * 1.8 + .5, v: .02 + Math.random() * .06, ph: Math.random() * TAU });
      for (let i = 0; i < 14; i++) S.orbs.push({ a: Math.random() * TAU, r: .12 + Math.random() * .34, sp: (.2 + Math.random() * .5) * (Math.random() < .5 ? -1 : 1), s: 1 + Math.random() * 2.2, ph: Math.random() * TAU });
    }
    if (!env.glOK) {
      const amb = fx.createLinearGradient(0, g.y + g.h, 0, g.y);
      amb.addColorStop(0, `rgba(38,16,72,${.34 * I})`); amb.addColorStop(.6, `rgba(18,10,44,${.18 * I})`); amb.addColorStop(1, `rgba(8,6,26,${.10 * I})`);
      fx.fillStyle = amb; fx.fillRect(g.x, g.y, g.w, g.h);
    }
    // rising energy bands (screen blend)
    fx.save(); fx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 3; i++) {
      const by = g.y + g.h - (((t * (26 + i * 14) + i * 190) % (g.h + 160)) - 80);
      const band = fx.createLinearGradient(0, by + 46, 0, by - 46);
      band.addColorStop(0, 'rgba(120,80,255,0)'); band.addColorStop(.5, `rgba(140,110,255,${.07 * I})`); band.addColorStop(1, 'rgba(120,80,255,0)');
      fx.fillStyle = band; fx.fillRect(g.x, by - 46, g.w, 92);
    }
    // anti-grav pulse rings from center
    const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
    for (let i = 0; i < 3; i++) {
      const ph = ((t * .35 + i / 3) % 1);
      const rr = ph * Math.max(g.w, g.h) * .62;
      fx.globalAlpha = (1 - ph) * .14 * I;
      fx.strokeStyle = '#a78bfa'; fx.lineWidth = 1.5;
      fx.beginPath(); fx.ellipse(cx, cy, rr, rr * .62, 0, 0, TAU); fx.stroke();
    }
    fx.restore();
    // levitating chunks of reality, motion-ghosted, rim-lit
    const sw = src.width, sh = src.height;
    const rr2 = (c2, x, y, w2, h2, r) => { c2.beginPath(); c2.moveTo(x + r, y); c2.arcTo(x + w2, y, x + w2, y + h2, r); c2.arcTo(x + w2, y + h2, x, y + h2, r); c2.arcTo(x, y + h2, x, y, r); c2.arcTo(x, y, x + w2, y, r); c2.closePath(); };
    for (const ch of S.chunks) {
      ch.y += ch.vy * dt * 3.4; ch.x += (ch.vx + Math.sin(t * .9 + ch.ph) * .004) * dt * 3.4;
      ch.rot += ch.vr * dt;
      if (ch.y < -0.16) { ch.y = 1.12; ch.x = Math.random(); ch.u = Math.random(); ch.v = Math.random(); ch.hasPrev = false; }
      const px = g.x + ch.x * g.w, py = g.y + ch.y * g.h + Math.sin(t * 1.4 + ch.ph) * 3 * ch.z;
      const suw = ch.w / m.dw * sw, svh = ch.h / m.dh * sh;
      const su = clamp(((g.x - m.ox) / m.dw + ch.u * (g.w / m.dw)) * sw, 0, sw - suw - 1);
      const sv = clamp(((g.y - m.oy) / m.dh + ch.v * (g.h / m.dh)) * sh, 0, sh - svh - 1);
      const drawChunk = (X, Y, R, alpha, blur) => {
        fx.save(); fx.translate(X, Y); fx.rotate(R);
        rr2(fx, -ch.w / 2, -ch.h / 2, ch.w, ch.h, 5);
        fx.globalAlpha = alpha * .16; fx.fillStyle = '#7c5cff'; fx.fill();  // glow pass
        fx.clip();
        fx.globalAlpha = alpha;
        try { fx.drawImage(src, su, sv, suw, svh, -ch.w / 2, -ch.h / 2, ch.w, ch.h); } catch (e) {}
        // rim light
        const rim = fx.createLinearGradient(0, -ch.h / 2, 0, ch.h / 2);
        rim.addColorStop(0, 'rgba(190,160,255,.34)'); rim.addColorStop(.35, 'rgba(190,160,255,0)'); rim.addColorStop(1, 'rgba(60,30,120,.38)');
        fx.globalAlpha = alpha; fx.fillStyle = rim; fx.fillRect(-ch.w / 2, -ch.h / 2, ch.w, ch.h);
        fx.restore();
        fx.save(); fx.translate(X, Y); fx.rotate(R);
        rr2(fx, -ch.w / 2, -ch.h / 2, ch.w, ch.h, 5);
        fx.globalAlpha = alpha * .5; fx.strokeStyle = 'rgba(196,181,253,.8)'; fx.lineWidth = 1; fx.stroke();
        fx.restore();
      };
      if (ch.hasPrev) drawChunk(ch.px, ch.py, ch.prot, .18, 0);      // motion ghost
      drawChunk(px, py, ch.rot, .95, 20 * I * ch.z);
      ch.px = px; ch.py = py; ch.prot = ch.rot; ch.hasPrev = true;
    }
    // orbiting sparks around center
    fx.save(); fx.globalCompositeOperation = 'lighter';
    for (const o of S.orbs) {
      o.a += o.sp * dt;
      const ox = cx + Math.cos(o.a) * o.r * g.w, oy = cy + Math.sin(o.a) * o.r * g.h * .8;
      const tw = .5 + .5 * Math.sin(t * 3 + o.ph);
      fx.globalAlpha = .5 * tw * I;
      fx.fillStyle = '#c4b5fd'; fx.beginPath(); fx.arc(ox, oy, o.s * tw, 0, TAU); fx.fill();
    }
    fx.restore();
    // dust motes with depth
    fx.fillStyle = '#d8ccff';
    for (const d of S.dust) {
      d.y -= d.v * d.z * dt; if (d.y < 0) { d.y = 1; d.x = Math.random(); }
      fx.globalAlpha = (.16 + .3 * Math.sin(t * 2.4 + d.ph)) * d.z;
      fx.beginPath(); fx.arc(g.x + d.x * g.w, g.y + d.y * g.h, d.s * d.z, 0, TAU); fx.fill();
    }
    fx.globalAlpha = 1;
  }
  fxFreeze(env) {
    const { g, fx, t, I, m, frozen } = env;
    let S = this.fxState;
    if (!S.t0) {
      S.t0 = t;
      S.sparks = Array.from({ length: Math.round(30 * I) }, () => ({ x: Math.random(), y: Math.random(), ph: Math.random() * TAU, s: 1 + Math.random() * 2.4, sp: .9 + Math.random() * 1.6 }));
      S.mist = Array.from({ length: 4 }, () => ({ x: Math.random(), y: .55 + Math.random() * .45, r: .18 + Math.random() * .22, v: .008 + Math.random() * .02, ph: Math.random() * TAU }));
      // frost ferns growing inward from the border
      S.ferns = [];
      const K = 16;
      for (let i = 0; i < K; i++) {
        const side = i % 4, u = Math.random();
        let x, y, dir;
        if (side === 0) { x = u; y = 0.02; dir = Math.PI / 2; }
        else if (side === 1) { x = u; y = .98; dir = -Math.PI / 2; }
        else if (side === 2) { x = .02; y = u; dir = 0; }
        else { x = .98; y = u; dir = Math.PI; }
        const pts = [{ x, y }];
        let a = dir, L = .028 + Math.random() * .02;
        for (let s2 = 0; s2 < 9; s2++) {
          a += (Math.random() - .5) * 1.1;
          const lp = pts[pts.length - 1];
          pts.push({ x: clamp(lp.x + Math.cos(a) * L, 0, 1), y: clamp(lp.y + Math.sin(a) * L, 0, 1) });
          L *= .88;
        }
        S.ferns.push({ pts, delay: Math.random() * 1.4, branches: pts.slice(1, 7).map((p, j) => ({ p, a: a + (j % 2 ? 1.1 : -1.1), l: .02 + Math.random() * .025 })) });
      }
    }
    const age = t - S.t0;
    if (!env.glOK) {
      fx.save();
      try { fx.filter = 'saturate(.55) brightness(1.05) contrast(1.07)'; } catch (e) {}
      fx.drawImage(frozen, m.ox, m.oy, m.dw, m.dh);
      fx.restore();
      const cold = fx.createLinearGradient(0, g.y, 0, g.y + g.h);
      cold.addColorStop(0, `rgba(170,220,255,${.14 * I})`); cold.addColorStop(1, `rgba(40,90,160,${.20 * I})`);
      fx.fillStyle = cold; fx.fillRect(g.x, g.y, g.w, g.h);
    }
    // rime frost creeping in from the selection edge
    fx.save();
    fx.strokeStyle = `rgba(225,246,255,${clamp(age * .5, 0, .32) * I})`;
    fx.lineWidth = Math.min(34, Math.min(g.w, g.h) * .18);
    fx.stroke(g.path);
    fx.restore();
    // frost ferns
    fx.save(); fx.lineCap = 'round';
    for (const f of S.ferns) {
      const gr = clamp((age - f.delay) * .9, 0, 1);
      if (gr <= 0) continue;
      const n = Math.max(2, Math.floor(f.pts.length * gr));
      fx.strokeStyle = `rgba(215,242,255,${.5 * I})`; fx.lineWidth = 1.2; fx.beginPath();
      for (let i2 = 0; i2 < n; i2++) { const P = { x: g.x + f.pts[i2].x * g.w, y: g.y + f.pts[i2].y * g.h }; i2 ? fx.lineTo(P.x, P.y) : fx.moveTo(P.x, P.y); }
      fx.stroke();
      fx.lineWidth = .8; fx.globalAlpha = .7;
      for (let bi = 0; bi < f.branches.length * gr; bi++) {
        const b = f.branches[bi | 0];
        const bx = g.x + b.p.x * g.w, by = g.y + b.p.y * g.h;
        fx.beginPath(); fx.moveTo(bx, by); fx.lineTo(bx + Math.cos(b.a) * b.l * g.w, by + Math.sin(b.a) * b.l * g.h); fx.stroke();
      }
      fx.globalAlpha = 1;
    }
    fx.restore();
    // glinting ice sparkles (4-ray stars)
    fx.save(); fx.globalCompositeOperation = 'lighter';
    for (const p of S.sparks) {
      const tw = Math.max(0, Math.sin(t * p.sp + p.ph));
      if (tw < .05) continue;
      const px = g.x + p.x * g.w, py = g.y + p.y * g.h, r = p.s * tw * 2.4;
      fx.globalAlpha = tw * .8 * I;
      fx.strokeStyle = '#eaf7ff'; fx.lineWidth = 1;
      fx.beginPath();
      fx.moveTo(px - r, py); fx.lineTo(px + r, py);
      fx.moveTo(px, py - r); fx.lineTo(px, py + r);
      fx.moveTo(px - r * .45, py - r * .45); fx.lineTo(px + r * .45, py + r * .45);
      fx.moveTo(px + r * .45, py - r * .45); fx.lineTo(px - r * .45, py + r * .45);
      fx.stroke();
      fx.fillStyle = '#ffffff'; fx.beginPath(); fx.arc(px, py, tw * 1.1, 0, TAU); fx.fill();
    }
    fx.restore();
    // cold mist drifting
    fx.save(); fx.globalCompositeOperation = 'screen';
    for (const ms of S.mist) {
      ms.x += ms.v * .06 * Math.sin(t * .4 + ms.ph); ms.y -= ms.v * .01;
      if (ms.y < .2) ms.y = 1.05;
      const mx = g.x + ms.x * g.w, my = g.y + ms.y * g.h, mr = ms.r * Math.max(g.w, g.h);
      const rg = fx.createRadialGradient(mx, my, 0, mx, my, mr);
      rg.addColorStop(0, `rgba(210,235,255,${.07 * I})`); rg.addColorStop(1, 'rgba(210,235,255,0)');
      fx.fillStyle = rg; fx.fillRect(g.x, g.y, g.w, g.h);
    }
    fx.restore();
  }
  fxCosmic(env) {
    const { g, fx, dt, t, I } = env;
    let S = this.fxState;
    if (!S.stars) {
      S.t0 = t;
      S.stars = [];
      for (const [count, zlo, zhi] of [[110, .15, .4], [70, .4, .75], [26, .75, 1]]) {
        for (let i = 0; i < count * I; i++) S.stars.push({ x: Math.random(), y: Math.random(), z: zlo + Math.random() * (zhi - zlo), ph: Math.random() * TAU });
      }
      S.neb = [
        { x: .3, y: .35, r: .38, h: 268, ph: 0 }, { x: .72, y: .6, r: .34, h: 310, ph: 2 },
        { x: .5, y: .8, r: .3, h: 210, ph: 4 }, { x: .8, y: .2, r: .26, h: 330, ph: 5 },
      ];
      S.shoot = { t: -2 };
    }
    const born = clamp((t - S.t0) * 1.6, 0, 1);   // fade the void in
    const bhx = g.x + g.w * .5, bhy = g.y + g.h * .5;
    // event horizon: darkness deepest at the singularity, thinning outward
    if (!env.glOK) {
      const dk = fx.createRadialGradient(bhx, bhy, 0, bhx, bhy, Math.max(g.w, g.h) * .8);
      dk.addColorStop(0, `rgba(0,0,6,${.96 * I * born})`);
      dk.addColorStop(.38, `rgba(3,4,16,${.58 * I * born})`);
      dk.addColorStop(1, `rgba(3,4,16,${.22 * I * born})`);
      fx.fillStyle = dk;
      fx.fillRect(g.x, g.y, g.w, g.h);
    }
    // nebulae (screen-blended, drifting)
    fx.save(); fx.globalCompositeOperation = 'screen';
    for (const n of S.neb) {
      const nx = g.x + (n.x + Math.sin(t * .045 + n.ph) * .05) * g.w;
      const ny = g.y + (n.y + Math.cos(t * .038 + n.ph) * .05) * g.h;
      const nr = n.r * Math.max(g.w, g.h);
      const rg = fx.createRadialGradient(nx, ny, 0, nx, ny, nr);
      rg.addColorStop(0, `hsla(${n.h + Math.sin(t * .2 + n.ph) * 14},85%,62%,${.15 * I * born})`);
      rg.addColorStop(.55, `hsla(${n.h},80%,45%,${.06 * I * born})`);
      rg.addColorStop(1, 'hsla(260,80%,40%,0)');
      fx.fillStyle = rg; fx.fillRect(g.x, g.y, g.w, g.h);
    }
    fx.restore();
    // parallax starfield (GPU already scatters micro-stars; 2D adds the bright hero stars)
    for (const s of (env.glOK ? S.stars.filter(st => st.z > .72) : S.stars)) {
      const sx = g.x + ((s.x + t * .006 * s.z) % 1) * g.w, sy = g.y + s.y * g.h;
      const tw = .35 + .65 * Math.abs(Math.sin(t * (1 + s.z) + s.ph));
      fx.globalAlpha = tw * born * (.4 + .6 * s.z);
      if (s.z > .75) {
        fx.save(); fx.fillStyle = '#ffffff';
        fx.beginPath(); fx.arc(sx, sy, s.z * 1.5, 0, TAU); fx.fill();
        if (s.z > .9) { fx.strokeStyle = 'rgba(230,240,255,.7)'; fx.lineWidth = .8; const rr3 = 5 * tw; fx.beginPath(); fx.moveTo(sx - rr3, sy); fx.lineTo(sx + rr3, sy); fx.moveTo(sx, sy - rr3); fx.lineTo(sx, sy + rr3); fx.stroke(); }
        fx.restore();
      } else {
        fx.fillStyle = s.z > .5 ? '#dbe4ff' : '#9fb0e8';
        fx.fillRect(sx, sy, s.z * 2.2, s.z * 2.2);
      }
    }
    fx.globalAlpha = 1;
    // the black hole: accretion disk, photon ring, reinforced core
    const rs = Math.max(this._lensRsPx || 0, Math.min(g.w, g.h) * .085);
    fx.save(); fx.globalCompositeOperation = 'lighter';
    fx.translate(bhx, bhy); fx.rotate(.42 + Math.sin(t * .07) * .06);
    fx.save(); fx.scale(1, .34);
    const disk = fx.createRadialGradient(0, 0, rs * 1.05, 0, 0, rs * 3.6);
    disk.addColorStop(0, 'rgba(255,190,120,0)');
    disk.addColorStop(.22, `rgba(255,200,135,${.34 * born * I})`);
    disk.addColorStop(.5, `rgba(244,150,220,${.15 * born * I})`);
    disk.addColorStop(1, 'rgba(150,80,255,0)');
    fx.fillStyle = disk; fx.beginPath(); fx.arc(0, 0, rs * 3.6, 0, TAU); fx.fill();
    // hot streaks orbiting the disk
    for (let i = 0; i < 3; i++) {
      const a0 = t * (1.1 + i * .2) + i * 2.1;
      fx.globalAlpha = .5 * born * I;
      fx.strokeStyle = i ? 'rgba(255,214,165,.55)' : 'rgba(255,240,220,.75)';
      fx.lineWidth = 2.2 - i * .5;
      fx.beginPath(); fx.arc(0, 0, rs * (1.7 + i * .5), a0, a0 + 1.1); fx.stroke();
    }
    fx.restore();
    // photon ring
    fx.globalAlpha = .8 * born;
    fx.strokeStyle = 'rgba(255,232,205,.9)'; fx.lineWidth = 1.4;
    fx.beginPath(); fx.arc(0, 0, rs * 1.45, 0, TAU); fx.stroke();
    fx.restore();
    // absolute core
    const core = fx.createRadialGradient(bhx, bhy, 0, bhx, bhy, rs * 1.15);
    core.addColorStop(0, `rgba(0,0,2,${.98 * born})`);
    core.addColorStop(.82, `rgba(0,0,4,${.9 * born})`);
    core.addColorStop(1, 'rgba(0,0,6,0)');
    fx.fillStyle = core; fx.beginPath(); fx.arc(bhx, bhy, rs * 1.15, 0, TAU); fx.fill();
    // infalling spark stream
    if (!S.fall) S.fall = Array.from({ length: 22 }, () => ({ a: Math.random() * TAU, r: .5 + Math.random() * .9, sp: .25 + Math.random() * .5, z: .4 + Math.random() * .6 }));
    fx.save(); fx.globalCompositeOperation = 'lighter';
    const Rref = Math.min(g.w, g.h) * .5;
    for (const f of S.fall) {
      f.a += f.sp * dt * (1.2 / Math.max(.15, f.r)); f.r -= dt * f.sp * .16;
      if (f.r < .11) { f.r = 1.15; f.a = Math.random() * TAU; }
      const px = bhx + Math.cos(f.a) * f.r * Rref, py = bhy + Math.sin(f.a) * f.r * Rref * .82;
      const stretch = clamp(.16 / f.r, .8, 7);
      fx.globalAlpha = clamp((1.1 - f.r) * .9, .1, .85) * born * f.z;
      fx.strokeStyle = '#ffe9d0'; fx.lineWidth = 1; fx.beginPath(); fx.moveTo(px, py);
      fx.lineTo(px - Math.sin(f.a) * 2.4 * stretch, py + Math.cos(f.a) * 2.4 * stretch * .82);
      fx.stroke();
    }
    fx.restore();
    // comet
    if (t - S.shoot.t > 4) S.shoot = { t, x: Math.random() * .6 + .05, y: Math.random() * .4 + .05, a: .5 + Math.random() * .9 };
    const cAge = t - S.shoot.t;
    if (cAge < .8) {
      const frac = cAge / .8;
      const sx = g.x + (S.shoot.x + cAge * .45 * Math.cos(S.shoot.a)) * g.w;
      const sy = g.y + (S.shoot.y + cAge * .45 * Math.sin(S.shoot.a)) * g.h;
      const tl = 46;
      const tail = fx.createLinearGradient(sx, sy, sx - tl * Math.cos(S.shoot.a), sy - tl * Math.sin(S.shoot.a));
      tail.addColorStop(0, `rgba(255,255,255,${.9 * (1 - frac)})`); tail.addColorStop(1, 'rgba(160,180,255,0)');
      fx.save(); fx.globalCompositeOperation = 'lighter';
      fx.strokeStyle = tail; fx.lineWidth = 1.8; fx.lineCap = 'round';
      fx.beginPath(); fx.moveTo(sx, sy); fx.lineTo(sx - tl * Math.cos(S.shoot.a), sy - tl * Math.sin(S.shoot.a)); fx.stroke();
      fx.restore();
    }
    // purple rim where space meets reality
    fx.save(); fx.globalCompositeOperation = 'screen';
    fx.strokeStyle = `rgba(190,140,255,${.30 * born * I})`; fx.lineWidth = 10;
    fx.stroke(g.path);
    fx.restore();
    fx.globalAlpha = 1;
  }
  // rubber-space vortex layers over the GL twist warp
  fxTwist(env) {
    const { g, fx, dt, t, I } = env;
    let S = this.fxState;
    const cx = g.x + g.w / 2, cy = g.y + g.h / 2, R = Math.min(g.w, g.h) * .5;
    if (!S.orbs) {
      S.t0 = t;
      S.orbs = Array.from({ length: Math.round(26 * I) }, () => ({ a: Math.random() * TAU, r: .18 + Math.random() * .95, sp: (.3 + Math.random() * .9) * (Math.random() < .5 ? -1 : 1), s: .8 + Math.random() * 1.8, ph: Math.random() * TAU }));
    }
    const ramp = clamp((t - S.t0) * 1.4, 0, 1);
    if (!env.glOK) {
      const rg = fx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(g.w, g.h) * .7);
      rg.addColorStop(0, `rgba(45,212,191,${.11 * I * ramp})`);
      rg.addColorStop(.5, `rgba(16,74,86,${.06 * I * ramp})`);
      rg.addColorStop(1, 'rgba(8,28,38,0)');
      fx.fillStyle = rg; fx.fillRect(g.x, g.y, g.w, g.h);
    }
    fx.save(); fx.globalCompositeOperation = 'lighter';
    // spiral filaments dragged around the eye
    for (let arm = 0; arm < 3; arm++) {
      fx.beginPath();
      for (let k = 0; k <= 30; k++) {
        const rr = .07 + (k / 30) * .92;
        const a = (k / 30) * 3.6 * 2.2 - t * .9 + arm * TAU / 3;
        const px = cx + Math.cos(a) * rr * R, py = cy + Math.sin(a) * rr * R * .9;
        k ? fx.lineTo(px, py) : fx.moveTo(px, py);
      }
      fx.strokeStyle = `rgba(94,234,212,${.15 * I * ramp})`;
      fx.lineWidth = 2; fx.stroke();
    }
    // orbiting motes
    for (const o of S.orbs) {
      o.a += o.sp * dt * (1.7 - o.r * .8);
      const px = cx + Math.cos(o.a) * o.r * R, py = cy + Math.sin(o.a) * o.r * R * .9;
      const tw = .5 + .5 * Math.sin(t * 2.5 + o.ph);
      fx.globalAlpha = .55 * tw * I * ramp;
      fx.fillStyle = '#99f6e4'; fx.beginPath(); fx.arc(px, py, o.s * tw, 0, TAU); fx.fill();
    }
    // breathing shimmer rings
    for (let i = 0; i < 2; i++) {
      const rr = R * (.38 + .3 * i) * (1 + .04 * Math.sin(t * 1.6 + i * 2));
      fx.globalAlpha = .10 * I * ramp;
      fx.strokeStyle = '#99f6e4'; fx.lineWidth = 1.2; fx.beginPath(); fx.ellipse(cx, cy, rr, rr * .9, 0, 0, TAU); fx.stroke();
    }
    fx.restore(); fx.globalAlpha = 1;
  }

  // 2D accents for dimension powers (GPU carries the base look)
  fxDimAccent(env, id) {
    const { g, fx, dt, t, I } = env;
    let S = this.fxState;
    if (S.dimId !== id) { this.fxState = S = { dimId: id }; }
    if (id === 'underwater') {
      if (!S.bub) S.bub = Array.from({ length: Math.round(26 * I) }, () => ({ x: Math.random(), y: Math.random(), r: 1.2 + Math.random() * 3.4, v: .05 + Math.random() * .12, ph: Math.random() * TAU }));
      fx.save();
      for (const b of S.bub) {
        b.y -= b.v * dt; b.x += Math.sin(t * 1.6 + b.ph) * .0007;
        if (b.y < -.03) { b.y = 1.03; b.x = Math.random(); }
        const px = g.x + b.x * g.w, py = g.y + b.y * g.h;
        fx.globalAlpha = .5;
        fx.strokeStyle = 'rgba(220,245,255,.8)'; fx.lineWidth = 1;
        fx.beginPath(); fx.arc(px, py, b.r, 0, TAU); fx.stroke();
        fx.globalAlpha = .8; fx.fillStyle = 'rgba(255,255,255,.85)';
        fx.beginPath(); fx.arc(px - b.r * .32, py - b.r * .32, b.r * .22, 0, TAU); fx.fill();
      }
      fx.restore();
    } else if (id === 'cyberpunk') {
      if (!S.rain) S.rain = Array.from({ length: Math.round(46 * I) }, () => ({ x: Math.random(), y: Math.random(), l: .02 + Math.random() * .05, v: .5 + Math.random() * .9, c: Math.random() < .5 }));
      fx.save(); fx.globalCompositeOperation = 'lighter';
      for (const r2 of S.rain) {
        r2.y += r2.v * dt; if (r2.y > 1.05) { r2.y = -.08; r2.x = Math.random(); }
        const px = g.x + r2.x * g.w, py = g.y + r2.y * g.h;
        fx.globalAlpha = .5;
        fx.strokeStyle = r2.c ? 'rgba(80,240,255,.7)' : 'rgba(255,80,200,.6)';
        fx.lineWidth = 1;
        fx.beginPath(); fx.moveTo(px, py); fx.lineTo(px, py + r2.l * g.h); fx.stroke();
      }
      fx.restore();
    } else if (id === 'lava') {
      if (!S.emb) {
        S.emb = Array.from({ length: Math.round(30 * I) }, () => ({ x: Math.random(), y: Math.random(), s: .8 + Math.random() * 1.8, v: .04 + Math.random() * .1, ph: Math.random() * TAU }));
        S.smoke = Array.from({ length: 4 }, () => ({ x: Math.random(), y: .7 + Math.random() * .3, r: .12 + Math.random() * .16, v: .015 + Math.random() * .02, ph: Math.random() * TAU }));
      }
      fx.save(); fx.globalCompositeOperation = 'screen';
      for (const ms of S.smoke) {
        ms.y -= ms.v * dt; ms.x += Math.sin(t * .5 + ms.ph) * .0009;
        if (ms.y < -.1) { ms.y = 1.1; ms.x = Math.random(); }
        const mx = g.x + ms.x * g.w, my = g.y + ms.y * g.h, mr = ms.r * Math.max(g.w, g.h);
        const rg = fx.createRadialGradient(mx, my, 0, mx, my, mr);
        rg.addColorStop(0, `rgba(85,62,55,${.10 * I})`); rg.addColorStop(1, 'rgba(85,62,55,0)');
        fx.fillStyle = rg; fx.fillRect(g.x, g.y, g.w, g.h);
      }
      fx.globalCompositeOperation = 'lighter';
      for (const e of S.emb) {
        e.y -= e.v * dt; e.x += Math.sin(t * 2 + e.ph) * .001;
        if (e.y < -.03) { e.y = 1.03; e.x = Math.random(); }
        const tw = .5 + .5 * Math.sin(t * 4 + e.ph);
        fx.globalAlpha = .75 * tw;
        fx.fillStyle = tw > .75 ? '#ffd9a0' : '#ff7a3c';
        fx.beginPath(); fx.arc(g.x + e.x * g.w, g.y + e.y * g.h, e.s * tw, 0, TAU); fx.fill();
      }
      fx.restore();
    } else if (id === 'void') {
      if (!S.heroes) S.heroes = Array.from({ length: 6 }, () => ({ x: .1 + Math.random() * .8, y: .1 + Math.random() * .8, ph: Math.random() * TAU, sp: .6 + Math.random() }));
      const born = clamp(this.powerT * .4, 0, 1);
      fx.save(); fx.globalCompositeOperation = 'lighter';
      for (const h2 of S.heroes) {
        const tw = Math.max(0, Math.sin(t * h2.sp + h2.ph));
        const px = g.x + h2.x * g.w, py = g.y + h2.y * g.h, r2 = 3.5 * tw;
        fx.globalAlpha = tw * .9 * born;
        fx.fillStyle = '#ffffff'; fx.beginPath(); fx.arc(px, py, 1.3, 0, TAU); fx.fill();
        fx.strokeStyle = 'rgba(210,230,255,.7)'; fx.lineWidth = .8;
        fx.beginPath();
        fx.moveTo(px - r2, py); fx.lineTo(px + r2, py);
        fx.moveTo(px, py - r2); fx.lineTo(px, py + r2);
        fx.stroke();
      }
      fx.restore();
    }
    fx.globalAlpha = 1;
  }

  // no-GPU fallback for dimension powers: graded wash so they still read
  fxDimFallback(env) {
    const { g, fx } = env;
    const tint = { underwater: 'rgba(20,90,120,.5)', cyberpunk: 'rgba(60,10,80,.5)', lava: 'rgba(90,25,5,.5)', pixel: 'rgba(30,40,30,.45)', void: 'rgba(2,2,8,.88)', thermal: 'rgba(200,80,0,.5)', holo: 'rgba(10,40,90,.6)' }[this.power.id] || 'rgba(10,10,14,.4)';
    fx.fillStyle = tint;
    fx.fillRect(g.x, g.y, g.w, g.h);
  }

  // shared finishing pass inside the selection: film grain
  postFx({ g, fx, I }) {
    if (this.qual < .8) return;   // grain is the first luxury to go under load
    if (!this._grainPat) {
      const gc = document.createElement('canvas'); gc.width = gc.height = 128;
      const gg = gc.getContext('2d'); const im = gg.createImageData(128, 128);
      for (let i = 0; i < im.data.length; i += 4) { const v = (110 + Math.random() * 90) | 0; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
      gg.putImageData(im, 0, 0);
      this._grainPat = fx.createPattern(gc, 'repeat');
    }
    fx.save();
    fx.globalCompositeOperation = 'overlay';
    fx.globalAlpha = .07 * I;
    const jx = (Math.random() * 128) | 0, jy = (Math.random() * 128) | 0;
    fx.translate(jx, jy);
    fx.fillStyle = this._grainPat;
    fx.fillRect(g.x - jx - 128, g.y - jy - 128, g.w + 256, g.h + 256);
    fx.restore();
  }

  // ---------- UI layer ----------
  drawSelectionUI(ui, g, dt) {
    if (!g || !this.sel) return;
    const col = this.power.color;
    const framing = this.state === 'FRAMING';
    // lock flash: one clean expanding ring
    if (this.flashT != null) {
      const fAge = this._t - this.flashT;
      if (fAge < .5) {
        const k = fAge / .5;
        ui.save();
        ui.globalAlpha = (1 - k) * .6;
        ui.strokeStyle = '#ffffff'; ui.lineWidth = 1.5 + k * 24;
        ui.stroke(g.path);
        ui.restore();
      }
    }
    ui.save();
    const quad = this.sel.kind === 'quad';
    const birth = framing ? clamp((this.frameT || 0) * 3, 0, 1) : 1;
    ui.globalAlpha = (quad ? .92 : (framing ? .4 + .25 * Math.sin(this._t * 5) : .48)) * birth;
    ui.strokeStyle = quad ? '#ffffff' : col; ui.lineWidth = quad ? 1.6 : 1;
    ui.stroke(g.path);
    if (quad && g.pts) {
      ui.fillStyle = '#ffffff';
      for (const p of g.pts) { const q = this.nToPx(p); ui.beginPath(); ui.arc(q.x, q.y, 3, 0, TAU); ui.fill(); }
    }
    // centered label
    ui.font = '600 10px "IBM Plex Mono", monospace';
    const label = this.power.label + (framing ? ' · FIST LOCKS' : '');
    const tw = ui.measureText(label).width;
    const ly = g.y - 13 < 14 ? g.y + g.h + 19 : g.y - 13;
    ui.globalAlpha = .55; ui.fillStyle = '#0a0a0b';
    ui.fillRect(g.x + g.w / 2 - tw / 2 - 8, ly - 11, tw + 16, 16);
    ui.globalAlpha = .92; ui.fillStyle = '#e4e4e7';
    ui.textAlign = 'center';
    ui.fillText(label, g.x + g.w / 2, ly);
    ui.restore();
  }
  drawTrail(ui) {
    if (this.state !== 'DRAWING' || this.trail.length < 2) return;
    const P = this.trail.map(p => this.nToPx(p));
    const path = new Path2D();
    path.moveTo(P[0].x, P[0].y);
    for (let i = 1; i < P.length - 1; i++) {
      path.quadraticCurveTo(P[i].x, P[i].y, (P[i].x + P[i + 1].x) / 2, (P[i].y + P[i + 1].y) / 2);
    }
    const L = P[P.length - 1]; path.lineTo(L.x, L.y);
    ui.save();
    ui.lineJoin = 'round'; ui.lineCap = 'round';
    ui.strokeStyle = 'rgba(228,228,231,.14)'; ui.lineWidth = 10; ui.stroke(path);  // halo
    ui.strokeStyle = 'rgba(244,244,245,.45)'; ui.lineWidth = 4.5; ui.stroke(path);
    ui.strokeStyle = '#ffffff'; ui.lineWidth = 1.8; ui.stroke(path);               // crisp core
    const tg = ui.createRadialGradient(L.x, L.y, 0, L.x, L.y, 12);
    tg.addColorStop(0, 'rgba(255,255,255,.95)'); tg.addColorStop(.4, 'rgba(240,240,245,.3)'); tg.addColorStop(1, 'rgba(240,240,245,0)');
    ui.fillStyle = tg; ui.beginPath(); ui.arc(L.x, L.y, 12, 0, TAU); ui.fill();    // luminous pen tip
    ui.fillStyle = 'rgba(255,255,255,.9)'; ui.beginPath(); ui.arc(P[0].x, P[0].y, 3, 0, TAU); ui.fill();
    ui.strokeStyle = 'rgba(255,255,255,.4)'; ui.lineWidth = 1;
    ui.beginPath(); ui.arc(P[0].x, P[0].y, 7 + 2 * Math.sin(this._t * 4), 0, TAU); ui.stroke();  // close-loop target
    ui.restore();
  }
  drawHands(ui) {
    const hands = this.hands;
    // energy thread between both hands (hot while framing / transforming)
    if (hands.length > 1) {
      const a = this.nToPx(hands[0].palmCenter), b = this.nToPx(hands[1].palmCenter);
      const hot = this.state === 'FRAMING' || this.state === 'TRANSFORM';
      ui.save();
      ui.strokeStyle = hot ? 'rgba(255,255,255,.55)' : 'rgba(228,228,231,.22)';
      ui.lineWidth = 1;
      ui.setLineDash([2, 6]); ui.lineDashOffset = -this._t * 26;
      ui.beginPath(); ui.moveTo(a.x, a.y); ui.lineTo(b.x, b.y); ui.stroke();
      ui.setLineDash([]);
      ui.fillStyle = hot ? 'rgba(255,255,255,.9)' : 'rgba(228,228,231,.5)';
      ui.beginPath(); ui.arc((a.x + b.x) / 2, (a.y + b.y) / 2, hot ? 2.4 : 1.6, 0, TAU); ui.fill();
      ui.restore();
    }
    for (const h of hands) {
      ui.save();
      if (this.skeleton && h.lm) {
        ui.strokeStyle = 'rgba(228,228,231,.35)'; ui.lineWidth = 1;
        const chains = [[0,1,2,3,4],[0,5,6,7,8],[5,9],[9,10,11,12],[9,13],[13,14,15,16],[13,17],[17,18,19,20],[0,17]];
        for (const cchain of chains) {
          ui.beginPath();
          for (let k = 0; k < cchain.length; k++) { const p = this.nToPx(h.lm[cchain[k]]); k ? ui.lineTo(p.x, p.y) : ui.moveTo(p.x, p.y); }
          ui.stroke();
        }
      }
      const pc = this.nToPx(h.palmCenter);
      const tips = (h.tips && !h.fist) ? h.tips.map(tp => this.nToPx(tp)) : null;
      if (tips) {
        // web: palm center -> every fingertip
        ui.strokeStyle = 'rgba(228,228,231,.30)'; ui.lineWidth = 1;
        ui.beginPath();
        for (const q of tips) { ui.moveTo(pc.x, pc.y); ui.lineTo(q.x, q.y); }
        ui.stroke();
        // arc linking the fingertips (thumb -> pinky)
        ui.strokeStyle = 'rgba(244,244,245,.6)'; ui.lineWidth = 1.1;
        ui.beginPath();
        ui.moveTo(tips[0].x, tips[0].y);
        for (let k = 1; k < tips.length; k++) ui.lineTo(tips[k].x, tips[k].y);
        ui.stroke();
        // fingertip nodes
        ui.fillStyle = 'rgba(250,250,250,.95)';
        for (const q of tips) { ui.beginPath(); ui.arc(q.x, q.y, 2.6, 0, TAU); ui.fill(); }
        // tether threads: each fingertip holds the zone rim while shaping it
        if (this.sel && this._frame && !this._frame.quad && (this.state === 'FRAMING' || this.state === 'TRANSFORM')) {
          const f = this._frame, A = this._m.dw / Math.max(1, this._m.dh);
          const ct = Math.cos(f.theta), st = Math.sin(f.theta);
          const RXe = Math.max(.02, f.RX * this.sel.scale), RYe = Math.max(.02, f.RY * this.sel.scale);
          ui.strokeStyle = 'rgba(255,255,255,.5)'; ui.lineWidth = 1;
          for (let k = 0; k < h.tips.length; k++) {
            const tp = h.tips[k];
            const px2 = (tp.x - this.sel.center.x) * A, py2 = tp.y - this.sel.center.y;
            let qx = (px2 * ct + py2 * st) / RXe, qy = (-px2 * st + py2 * ct) / RYe;
            const ql = Math.hypot(qx, qy) || 1;
            qx /= ql; qy /= ql;
            const ex = qx * RXe, ey = qy * RYe;
            const E = this.nToPx({ x: (ex * ct - ey * st) / A + this.sel.center.x, y: ex * st + ey * ct + this.sel.center.y });
            const Tq = tips[k];
            ui.globalAlpha = .38;
            ui.beginPath(); ui.moveTo(Tq.x, Tq.y); ui.lineTo(E.x, E.y); ui.stroke();
            ui.globalAlpha = .85;
            ui.fillStyle = '#ffffff'; ui.beginPath(); ui.arc(E.x, E.y, 1.6, 0, TAU); ui.fill();
          }
          ui.globalAlpha = 1;
        }
      }
      // palm ring
      ui.strokeStyle = h.fist ? 'rgba(255,255,255,.9)' : 'rgba(228,228,231,.55)';
      ui.lineWidth = h.fist ? 2 : 1.2;
      ui.beginPath(); ui.arc(pc.x, pc.y, h.fist ? 9 : 13, 0, TAU); ui.stroke();
      // pinch highlight
      if (h.pinch) {
        const q = this.nToPx(h.pinchPos);
        ui.strokeStyle = '#ffffff'; ui.lineWidth = 2;
        ui.beginPath(); ui.arc(q.x, q.y, 7, 0, TAU); ui.stroke();
        ui.fillStyle = '#fafafa';
        ui.beginPath(); ui.arc(q.x, q.y, 2.6, 0, TAU); ui.fill();
      }
      ui.restore();
    }
  }

  drawDwell(ui) {
    // summon progress ring — shows the zone charging up before it appears
    if (this._summon && this._summon.t > 0.08 && this.state === 'IDLE') {
      const p = this.nToPx(this._summon.pos);
      const fr = clamp(this._summon.t / 0.4, 0, 1);
      ui.save();
      ui.strokeStyle = 'rgba(228,228,231,.35)'; ui.lineWidth = 1;
      ui.beginPath(); ui.arc(p.x, p.y, 22, 0, TAU); ui.stroke();
      ui.strokeStyle = '#ffffff'; ui.lineWidth = 2;
      ui.beginPath(); ui.arc(p.x, p.y, 22, -Math.PI / 2, -Math.PI / 2 + fr * TAU); ui.stroke();
      ui.restore();
    }
    if (!this.dwell || this.dwell.t < 0.12) return;
    const p = this.nToPx(this.dwell.pos);
    const need = this.dwell.kind === 'palm' ? 0.9 : 0.8;
    const fr = clamp(this.dwell.t / need, 0, 1);
    ui.save();
    ui.strokeStyle = this.dwell.kind === 'palm' ? '#e4e4e7' : '#a1a1aa';
    ui.lineWidth = 3; ui.beginPath(); ui.arc(p.x, p.y, 26, -Math.PI / 2, -Math.PI / 2 + fr * TAU); ui.stroke();
    ui.font = '600 10px "IBM Plex Mono", monospace'; ui.fillStyle = ui.strokeStyle; ui.globalAlpha = .9;
    ui.textAlign = 'center';
    ui.fillText(this.dwell.kind === 'palm' ? 'NEW ZONE' : 'ERASE', p.x, p.y + 44);
    ui.restore();
  }

  // ---------- HUD sync ----------
  hud(force) {
    const stateLabel = {
      IDLE: 'SHOW AN OPEN HAND',
      FRAMING: 'MOVE / SPREAD TO SHAPE — FIST TO LOCK',
      SELECTED: 'AREA LOCKED — ' + this.power.label,
      MOVING: 'MOVING SELECTION',
      TRANSFORM: 'RESIZE / ROTATE',
    }[this.state] || this.state;
    const modeTxt = { boot: 'BOOTING', hands: 'HAND TRACKING', nocam: 'CAMERA REQUIRED', notrack: 'TRACKER ERROR', error: 'ERROR' }[this.mode];
    const sig = stateLabel + this.mode + this.powerIdx + Math.round(this.fps / 5) + (this.hands.length || 0) + this.cameraOK + (this.camErr || '') + Math.round((this.trackMs || 0) / 4);
    if (!force && sig === this._lastHud) return;
    this._lastHud = sig;
    try {
      this.onUpdate({
        stateLabel,
        mode: this.mode,
        cameraOK: this.cameraOK,
        camBlocked: !!this.camBlocked,
        camErr: this.camErr || null,
        powerIdx: this.powerIdx,
        fps: Math.round(this.fps),
        trackMs: Math.round(this.trackMs || 0),
        handsSeen: this.hands.length,
        hasSelection: !!this.sel,
      });
    } catch (e) {}
  }
}

// ---------- shape classification ----------
function classifyShape(raw) {
  // resample + measure
  const pts = raw.slice();
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, per = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    minx = Math.min(minx, p.x); miny = Math.min(miny, p.y);
    maxx = Math.max(maxx, p.x); maxy = Math.max(maxy, p.y);
    if (i) per += dist(pts[i - 1], p);
  }
  const w = maxx - minx, h = maxy - miny;
  if (w < 0.03 || h < 0.03) return null;
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  // shoelace area on closed poly
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  area = Math.abs(area) / 2;
  const circ = per > 0 ? (4 * Math.PI * area) / (per * per) : 0;
  const simp = rdp(pts, 0.012);
  let kind, shape;
  if (circ > 0.72) {
    kind = 'ellipse';
    shape = [];
    for (let i = 0; i < 40; i++) { const a = (i / 40) * TAU; shape.push({ x: Math.cos(a) * w / 2, y: Math.sin(a) * h / 2 }); }
  } else if (simp.length <= 8 && circ > 0.5) {
    kind = 'rect';
    shape = [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }];
  } else {
    kind = 'freeform';
    const sm = smooth(resample(pts, 56), 4);
    shape = sm.map(p => ({ x: p.x - cx, y: p.y - cy }));
  }
  return { pts: shape, center: { x: cx, y: cy }, scale: 1, rot: 0, kind };
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const dmaxAt = (a, b, s, e) => {
    let dmax = 0, idx = s;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(pts[i], a, b);
      if (d > dmax) { dmax = d; idx = i; }
    }
    return { dmax, idx };
  };
  const out = [];
  const rec = (s, e) => {
    const { dmax, idx } = dmaxAt(pts[s], pts[e], s, e);
    if (dmax > eps) { rec(s, idx); rec(idx, e); }
    else out.push(pts[s]);
  };
  rec(0, pts.length - 1);
  out.push(pts[pts.length - 1]);
  return out;
}
function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1e-9;
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / L;
}
function resample(pts, n) {
  const seg = [0]; let per = 0;
  for (let i = 1; i < pts.length; i++) { per += dist(pts[i - 1], pts[i]); seg.push(per); }
  if (per < 1e-6) return pts.slice();
  const out = []; let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / (n - 1)) * per;
    while (j < pts.length - 2 && seg[j + 1] < target) j++;
    const t = clamp((target - seg[j]) / Math.max(1e-9, seg[j + 1] - seg[j]), 0, 1);
    out.push({ x: lerp(pts[j].x, pts[j + 1].x, t), y: lerp(pts[j].y, pts[j + 1].y, t) });
  }
  return out;
}

function smooth(pts, iter) {
  let cur = pts;
  for (let k = 0; k < iter; k++) {
    const nx = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[(i - 1 + cur.length) % cur.length], b = cur[i], c = cur[(i + 1) % cur.length];
      nx.push({ x: (a.x + b.x * 2 + c.x) / 4, y: (a.y + b.y * 2 + c.y) / 4 });
    }
    cur = nx;
  }
  return cur;
}

// ---------- voice commands (Web Speech API) ----------
window.createRealityVoice = function (opts) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
  let on = false;
  const RULES = [
    [/black ?hole|cosmic|galaxy|outer ?space|space/, 'cosmic'],
    [/under ?water|ocean|sea|aqua|water/, 'underwater'],
    [/neon|cyber|punk|city/, 'cyberpunk'],
    [/lava|magma|fire|hell|burn/, 'lava'],
    [/pixel|8 ?bit|retro|game/, 'pixel'],
    [/void|darkness|dark/, 'void'],
    [/thermal|heat|infra ?red|temperature/, 'thermal'],
    [/particle|point ?cloud|hologram|holo/, 'holo'],
    [/circle|round/, '@shape:circle'],
    [/panel|rectangle|square|frame/, '@shape:panel'],
    [/freeze|frozen|stop time|pause/, 'freeze'],
    [/gravity|float|levitat|fly/, 'antigravity'],
    [/twist|swirl|warp|bend|vortex/, 'twist'],
    [/normal|scan|select|original/, 'hologram'],
  ];
  rec.onresult = (e) => {
    let interim = '', fin = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) fin += t; else interim += t;
    }
    if (interim) opts.onTranscript(interim.trim(), false);
    if (fin) {
      const low = fin.toLowerCase();
      opts.onTranscript(fin.trim(), true);
      if (/clear|erase|remove|delete|undo|reset/.test(low)) { opts.onClear(); return; }
      for (const [re, id] of RULES) if (re.test(low)) {
        if (id.indexOf('@shape:') === 0) { opts.onShape && opts.onShape(id.slice(7)); return; }
        opts.onPower(id); return;
      }
    }
  };
  rec.onend = () => { if (on) { try { rec.start(); } catch (e) {} } };
  rec.onerror = (e) => {
    console.info('[reality] voice error:', e.error);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') { on = false; opts.onState(false, e.error); }
  };
  return {
    toggle() {
      on = !on;
      try { if (on) rec.start(); else rec.stop(); } catch (e) {}
      opts.onState(on);
      return on;
    },
    stop() { on = false; try { rec.stop(); } catch (e) {} },
    get active() { return on; },
  };
};

// ---------- GPU effect pipeline (treats the real pixels; feathered mask + rim in-shader) ----------
function makeWarpGL(w, h) {
  try {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const gl = cv.getContext('webgl', { depth: false, stencil: false, antialias: false, alpha: true, premultipliedAlpha: true });
    if (!gl) return null;
    const vsrc = 'attribute vec2 p;varying vec2 v;void main(){v=vec2(p.x*.5+.5,.5-p.y*.5);gl_Position=vec4(p,0.,1.);}';
    const fsrc = [
      "precision mediump float;",
      "varying vec2 v;",
      "uniform sampler2D T;",
      "uniform sampler2D F;",
      "uniform float uTime; uniform float uMode; uniform float uIntensity; uniform float uPowerT; uniform float uAspect; uniform float uTheta;",
      "uniform vec2 uCenter; uniform vec2 uRXY;",
      "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }",
      "float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);",
      "  return mix(mix(hash(i), hash(i+vec2(1.0,0.0)), u.x), mix(hash(i+vec2(0.0,1.0)), hash(i+vec2(1.0,1.0)), u.x), u.y); }",
      "float fbm(vec2 p){ float s = 0.0; float a = 0.5; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p = p * 2.03 + 11.3; a *= 0.5; } return s; }",
      "vec3 grade(vec3 c, vec3 tint, float sat, float lift){ float l = dot(c, vec3(0.299,0.587,0.114)); return mix(vec3(l), c, sat) * tint + lift; }",
      "vec2 fromQ(vec2 q, float cs, float sn){ vec2 pr = q * uRXY; vec2 p2 = vec2(pr.x*cs - pr.y*sn, pr.x*sn + pr.y*cs); return vec2(p2.x/uAspect + uCenter.x, p2.y + uCenter.y); }",
      "void main(){",
      "  float cs = cos(uTheta); float sn = sin(uTheta);",
      "  vec2 p = vec2((v.x - uCenter.x) * uAspect, v.y - uCenter.y);",
      "  vec2 pr = vec2(p.x*cs + p.y*sn, -p.x*sn + p.y*cs);",
      "  vec2 q = pr / uRXY;",
      "  float r = length(q);",
      "  float mR = min(uRXY.x, uRXY.y);",
      "  float fe = clamp(0.05 / mR, 0.03, 0.30);",
      "  float ramp = clamp(uPowerT * 1.8 + 0.08, 0.0, 1.0);",
      "  float mask = (1.0 - smoothstep(1.0 - fe, 1.0 + fe * 0.35, r)) * ramp;",
      "  if (mask < 0.004) { gl_FragColor = vec4(0.0); return; }",
      "  float I = uIntensity;",
      "  vec3 col = vec3(0.0);",
      "  vec3 rimC = vec3(0.9);",
      "  if (uMode < 0.5) {",
      "    float ca = 0.0022 * I;",
      "    col.r = texture2D(T, v + vec2(ca, 0.0)).r;",
      "    col.g = texture2D(T, v).g;",
      "    col.b = texture2D(T, v - vec2(ca, 0.0)).b;",
      "    col = grade(col, vec3(0.96, 1.01, 1.06), 0.88, 0.015);",
      "    float scan = 0.5 + 0.5 * sin((v.y + uTime * 0.045) * 700.0);",
      "    col *= 0.965 + 0.055 * scan;",
      "    float sweep = exp(-abs(fract(v.y - uTime * 0.11) - 0.5) * 26.0);",
      "    col += vec3(0.72, 0.82, 0.92) * sweep * 0.16 * I;",
      "    rimC = vec3(0.85, 0.9, 0.97);",
      "  } else if (uMode < 1.5) {",
      "    vec2 uv = v;",
      "    float wob = 1.0 - r * r * 0.6;",
      "    uv.x += 0.007 * I * wob * sin(uTime * 0.8 + v.y * 12.0);",
      "    float drift = 0.010 * I * wob;",
      "    vec3 acc = texture2D(T, uv).rgb;",
      "    acc += texture2D(T, uv + vec2(0.0, drift * 0.5)).rgb * 0.8;",
      "    acc += texture2D(T, uv + vec2(0.0, drift)).rgb * 0.6;",
      "    acc += texture2D(T, uv + vec2(0.0, drift * 1.6)).rgb * 0.4;",
      "    col = acc / 2.8;",
      "    col = grade(col, vec3(0.92, 0.88, 1.12), 0.82, 0.008);",
      "    float mote = smoothstep(0.78, 1.0, vnoise(vec2(pr.x * 46.0, pr.y * 46.0 + uTime * 1.6)));",
      "    col += vec3(0.62, 0.55, 1.0) * mote * 0.4 * I;",
      "    rimC = vec3(0.68, 0.6, 1.0);",
      "  } else if (uMode < 2.5) {",
      "    vec3 c0 = texture2D(F, v).rgb;",
      "    col = grade(c0, vec3(0.88, 1.0, 1.14), 0.5, 0.03);",
      "    float glint = pow(vnoise(v * 110.0 + floor(uTime * 2.5) * 13.0), 9.0);",
      "    col += vec3(0.85, 0.94, 1.0) * glint * 1.6 * I;",
      "    float frost = fbm(pr * 15.0) * smoothstep(0.45, 1.02, r);",
      "    col = mix(col, vec3(0.83, 0.9, 1.0), frost * 0.55 * I);",
      "    float crack = smoothstep(0.94, 1.0, vnoise(pr * 26.0 + 3.7));",
      "    col += vec3(0.9, 0.97, 1.0) * crack * 0.12;",
      "    rimC = vec3(0.75, 0.92, 1.0);",
      "  } else if (uMode < 3.5) {",
      "    float ang = 2.6 * I * (1.0 - smoothstep(0.05, 1.0, r)) * (0.72 + 0.28 * sin(uTime * 0.6));",
      "    float c1 = cos(ang); float s1 = sin(ang);",
      "    float c2 = cos(ang * 1.07); float s2 = sin(ang * 1.07);",
      "    float c3 = cos(ang * 0.93); float s3 = sin(ang * 0.93);",
      "    vec2 q1 = vec2(q.x*c1 - q.y*s1, q.x*s1 + q.y*c1);",
      "    vec2 q2 = vec2(q.x*c2 - q.y*s2, q.x*s2 + q.y*c2);",
      "    vec2 q3 = vec2(q.x*c3 - q.y*s3, q.x*s3 + q.y*c3);",
      "    col.g = texture2D(T, fromQ(q1, cs, sn)).g;",
      "    col.b = texture2D(T, fromQ(q2, cs, sn)).b;",
      "    col.r = texture2D(T, fromQ(q3, cs, sn)).r;",
      "    col = grade(col, vec3(0.93, 1.05, 1.02), 0.9, 0.0);",
      "    float lines = smoothstep(0.8, 1.0, vnoise(vec2(atan(q.y, q.x) * 4.0, r * 22.0 - uTime * 2.6)));",
      "    col += vec3(0.55, 0.95, 0.86) * lines * 0.22 * I * (1.0 - r * 0.6);",
      "    col *= 1.0 - 0.35 * I * exp(-r * r * 9.0);",
      "    rimC = vec3(0.5, 0.93, 0.83);",
      "  } else if (uMode < 4.5) {",
      "    float k = 0.30 * I;",
      "    vec2 dir = r > 0.001 ? q / r : vec2(0.0, 1.0);",
      "    float rs = 0.30;",
      "    float rr = r - k / (r + 0.06);",
      "    col.r = texture2D(T, fromQ(dir * (r - (k * 0.96) / (r + 0.06)), cs, sn)).r;",
      "    col.g = texture2D(T, fromQ(dir * rr, cs, sn)).g;",
      "    col.b = texture2D(T, fromQ(dir * (r - (k * 1.04) / (r + 0.06)), cs, sn)).b;",
      "    float dark = smoothstep(1.05, 0.45, r) * 0.85;",
      "    col = mix(col, col * 0.12, dark);",
      "    vec2 sp = floor(pr * 160.0);",
      "    float st = step(0.995, hash(sp)) * (0.4 + 0.6 * sin(uTime * 3.0 + hash(sp + 1.3) * 6.28));",
      "    col += vec3(0.9, 0.93, 1.0) * st * smoothstep(1.0, 0.5, r);",
      "    col *= smoothstep(rs * 0.8, rs * 1.45, r);",
      "    col += vec3(1.0, 0.85, 0.6) * exp(-abs(r - rs * 1.35) / 0.045) * 0.85 * I;",
      "    col += vec3(0.55, 0.35, 0.9) * exp(-abs(r - rs * 2.2) / 0.3) * 0.12 * I;",
      "    rimC = vec3(0.8, 0.62, 1.0);",
      "  } else if (uMode < 5.5) {",
      "    vec2 uv = v + vec2(sin(uTime * 1.1 + v.y * 34.0), cos(uTime * 0.9 + v.x * 30.0)) * 0.006 * I;",
      "    col = texture2D(T, uv).rgb;",
      "    col = grade(col, vec3(0.62, 0.95, 1.08), 0.72, 0.01);",
      "    float ca2 = fbm(pr * 7.0 + vec2(uTime * 0.25, uTime * 0.18));",
      "    col += vec3(0.35, 0.75, 0.85) * smoothstep(0.55, 0.85, ca2) * 0.55 * I;",
      "    float shaft = smoothstep(0.55, 1.0, vnoise(vec2(pr.x * 3.0 - pr.y * 1.4 + uTime * 0.12, 0.5)));",
      "    col += vec3(0.45, 0.75, 0.85) * shaft * clamp(0.35 - q.y * 0.35, 0.0, 0.7) * I;",
      "    rimC = vec3(0.45, 0.85, 1.0);",
      "  } else if (uMode < 6.5) {",
      "    vec2 uv = v;",
      "    float row = floor(v.y * 36.0);",
      "    float gl2 = step(0.982, hash(vec2(floor(uTime * 9.0), row)));",
      "    uv.x += gl2 * (hash(vec2(floor(uTime * 9.0) + 4.0, row)) - 0.5) * 0.09 * I;",
      "    float ca3 = 0.004 * I;",
      "    col.r = texture2D(T, uv + vec2(ca3, 0.0)).r;",
      "    col.g = texture2D(T, uv).g;",
      "    col.b = texture2D(T, uv - vec2(ca3, 0.0)).b;",
      "    float lum = dot(col, vec3(0.299, 0.587, 0.114));",
      "    vec3 duo = mix(vec3(0.07, 0.02, 0.14), mix(vec3(0.95, 0.2, 0.65), vec3(0.25, 0.95, 1.0), smoothstep(0.3, 0.85, lum)), smoothstep(0.04, 0.9, lum));",
      "    col = mix(col, duo, 0.72 * I);",
      "    col *= 0.9 + 0.1 * (0.5 + 0.5 * sin(v.y * 520.0 + uTime * 8.0));",
      "    rimC = vec3(0.95, 0.35, 0.8);",
      "  } else if (uMode < 7.5) {",
      "    vec2 uv = v + vec2(fbm(pr * 6.0 + uTime * 0.5) - 0.5, fbm(pr * 6.0 + 7.7 + uTime * 0.45) - 0.5) * 0.014 * I;",
      "    col = texture2D(T, uv).rgb;",
      "    col = grade(col, vec3(1.28, 0.72, 0.45), 0.62, 0.0);",
      "    float vein = fbm(pr * 8.0 + vec2(0.0, uTime * 0.08));",
      "    float vglow = 1.0 - smoothstep(0.0, 0.07, abs(vein - 0.5));",
      "    col += vec3(1.0, 0.42, 0.06) * vglow * (0.7 + 0.3 * sin(uTime * 2.6 + vein * 20.0)) * I;",
      "    col += vec3(0.55, 0.12, 0.01) * smoothstep(0.1, 1.0, q.y + 0.6) * 0.25 * I;",
      "    rimC = vec3(1.0, 0.52, 0.16);",
      "  } else if (uMode < 8.5) {",
      "    float bw = 0.024;",
      "    vec2 cell = floor(pr / bw);",
      "    float appear = step(hash(cell), clamp(uPowerT * 1.2, 0.0, 1.0));",
      "    vec3 pix = texture2D(T, fromQ((cell + 0.5) * bw / uRXY, cs, sn)).rgb;",
      "    pix = floor(pix * 5.0 + 0.5) / 5.0;",
      "    pix = grade(pix, vec3(1.02, 1.04, 1.0), 1.3, 0.0);",
      "    vec2 fr2 = fract(pr / bw);",
      "    float gline = step(0.92, fr2.x) + step(0.92, fr2.y);",
      "    pix *= 1.0 - gline * 0.18;",
      "    col = mix(texture2D(T, v).rgb, pix, appear);",
      "    rimC = vec3(0.65, 0.95, 0.55);",
      "  } else if (uMode < 9.5) {",
      "    col = texture2D(T, v).rgb * 0.05;",
      "    float fl = fbm(pr * 5.0 + uTime * 0.06);",
      "    float e2 = abs(fract(fl * 7.0) - 0.5);",
      "    col += vec3(0.5, 0.75, 1.0) * exp(-e2 * 30.0) * (0.5 + 0.5 * sin(uTime * 1.7 + fl * 12.0)) * 0.55 * I;",
      "    float starT = clamp((uPowerT - 0.8) * 0.3, 0.0, 1.0);",
      "    vec2 sp2 = floor(pr * 150.0);",
      "    float st2 = step(1.0 - 0.01 * starT, hash(sp2)) * (0.4 + 0.6 * sin(uTime * 2.6 + hash(sp2 + 2.7) * 6.28));",
      "    col += vec3(0.9, 0.94, 1.0) * st2;",
      "    rimC = vec3(0.75, 0.85, 1.0);",
      "  } else if (uMode < 10.5) {",
      "    vec3 c0t = texture2D(T, v).rgb;",
      "    float lt = dot(c0t, vec3(0.299, 0.587, 0.114));",
      "    lt = clamp(lt * 1.18 + 0.05 * fbm(pr * 6.0 + uTime * 0.3) - 0.03, 0.0, 1.0);",
      "    vec3 th = mix(vec3(0.03, 0.0, 0.3), vec3(0.0, 0.3, 0.9), smoothstep(0.0, 0.22, lt));",
      "    th = mix(th, vec3(0.0, 0.8, 0.4), smoothstep(0.22, 0.42, lt));",
      "    th = mix(th, vec3(1.0, 0.9, 0.0), smoothstep(0.42, 0.62, lt));",
      "    th = mix(th, vec3(1.0, 0.3, 0.0), smoothstep(0.62, 0.82, lt));",
      "    th = mix(th, vec3(1.0, 1.0, 1.0), smoothstep(0.82, 1.0, lt));",
      "    col = th * (0.94 + 0.06 * sin(v.y * 500.0));",
      "    rimC = vec3(1.0, 0.55, 0.1);",
      "  } else {",
      "    float N = 90.0;",
      "    vec2 qc = (floor(q * N) + 0.5) / N;",
      "    vec3 c0h = texture2D(T, fromQ(qc, cs, sn)).rgb;",
      "    float lh = dot(c0h, vec3(0.299, 0.587, 0.114));",
      "    vec2 fr3 = fract(q * N) - 0.5;",
      "    float dotm = smoothstep(0.45 * (lh + 0.18), 0.0, length(fr3));",
      "    col = vec3(0.01, 0.04, 0.11);",
      "    col += vec3(0.25, 0.65, 1.0) * dotm * (0.3 + lh * 1.5);",
      "    float spark = step(0.995, hash(floor(q * N) + floor(uTime * 3.0)));",
      "    col += vec3(0.7, 0.9, 1.0) * spark * 0.7;",
      "    col += vec3(0.1, 0.3, 0.6) * exp(-abs(fract(v.y * 2.0 - uTime * 0.13) - 0.5) * 22.0) * 0.5;",
      "    rimC = vec3(0.4, 0.75, 1.0);",
      "  }",
      "  float edge = exp(-abs(r - 1.0) / (fe * 1.1));",
      "  col += rimC * edge * (0.32 + 0.1 * sin(uTime * 2.2)) * I;",
      "  col += col * col * 0.20;",
      "  gl_FragColor = vec4(col * mask, mask);",
      "}"
    ].join('\n');
    const mk = (type, src2) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src2); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, vsrc));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, fsrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('program link failed');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const mkTex = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return t;
    };
    gl.activeTexture(gl.TEXTURE0); const tex = mkTex();
    gl.activeTexture(gl.TEXTURE1); const texF = mkTex();
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(gl.getUniformLocation(prog, 'T'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'F'), 1);
    gl.disable(gl.BLEND);
    const u = {};
    for (const n of ['uTime', 'uMode', 'uIntensity', 'uPowerT', 'uAspect', 'uTheta', 'uCenter', 'uRXY']) u[n] = gl.getUniformLocation(prog, n);
    console.info('[reality] gpu effect pipeline ready');
    return { cv, gl, prog, tex, texF, u, hasFrozen: false };
  } catch (e) {
    console.info('[reality] webgl unavailable, 2d-only effects:', e.message);
    return null;
  }
}

})();