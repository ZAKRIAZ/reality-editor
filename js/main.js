// ============ REALITY EDITOR — main ============
import { Renderer } from './renderer.js';
import { ParticleSystem } from './particles.js';
import { HandTracker, GestureEngine } from './gestures.js';
import { startVoice } from './voice.js';
import { createSimScene } from './sim.js';

// ---------- power registry (mode = shader branch) ----------
const EFFECTS = [
  { id: 'cosmic',      name: 'COSMIC SPACE',    sub: 'dimension 01 · gravity ≈ 0',      mode: 1,  particles: 'star'   },
  { id: 'cyberpunk',   name: 'CYBERPUNK CITY',  sub: 'dimension 02 · neon rain',        mode: 2,  particles: 'glitch' },
  { id: 'underwater',  name: 'UNDERWATER',      sub: 'dimension 03 · pressure rising',  mode: 3,  particles: 'bubble' },
  { id: 'lava',        name: 'LAVA HELL',       sub: 'dimension 04 · 1400°C',           mode: 4,  particles: 'ember'  },
  { id: 'quantum',     name: 'QUANTUM FIELD',   sub: 'dimension 05 · nothing is stable',mode: 5,  particles: 'glitch' },
  { id: 'crystal',     name: 'CRYSTAL WORLD',   sub: 'dimension 06 · full refraction',  mode: 6,  particles: 'spark'  },
  { id: 'frozenWorld', name: 'FROZEN WORLD',    sub: 'dimension 07 · absolute zero',    mode: 7,  particles: 'snow'   },
  { id: 'dream',       name: 'DREAM STATE',     sub: 'dimension 08 · physics optional', mode: 8,  particles: 'dream'  },
  { id: 'pixel',       name: 'PIXEL UNIVERSE',  sub: 'dimension 09 · reality @ 8-bit',  mode: 9,  particles: null     },
  { id: 'void',        name: 'THE VOID',        sub: 'dimension 10 · stars being born', mode: 10, particles: 'star'   },
  { id: 'blackhole',   name: 'SINGULARITY',     sub: 'gravity · light is bending',      mode: 11, particles: 'orbit'  },
  { id: 'zerog',       name: 'ZERO GRAVITY',    sub: 'gravity · everything levitates',  mode: 12, particles: 'rise'   },
  { id: 'crush',       name: 'GRAVITY ×10',     sub: 'gravity · pulsing in waves',      mode: 13, particles: null     },
  { id: 'timefreeze',  name: 'TIME FREEZE',     sub: 'time · t = 0 inside region',      mode: 14, particles: null     },
  { id: 'slowmo',      name: 'SLOW MOTION',     sub: 'time · 0.35× local flow',         mode: 15, particles: null     },
  { id: 'reverse',     name: 'TIME REVERSE',    sub: 'time · entropy inverted',         mode: 16, particles: null     },
  { id: 'echo',        name: 'GHOST ECHOES',    sub: 'time · parallel timelines',       mode: 17, particles: null     },
  { id: 'gold',        name: 'MATTER → GOLD',   sub: 'material · Au 79',                mode: 18, particles: 'spark'  },
  { id: 'glass',       name: 'MATTER → GLASS',  sub: 'material · refractive index 1.5', mode: 19, particles: null     },
  { id: 'plasma',      name: 'MATTER → PLASMA', sub: 'material · ionized',              mode: 20, particles: 'spark'  },
  { id: 'mirror',      name: 'MIRRORED SPACE',  sub: 'space · geometry reflected',      mode: 21, particles: null     },
  { id: 'twist',       name: 'SPACE TWIST',     sub: 'space · rubber spacetime',        mode: 22, particles: null     },
  { id: 'tunnel',      name: 'INFINITE TUNNEL', sub: 'space · torn open',               mode: 23, particles: 'star'   },
];

// ---------- dom ----------
const $ = s => document.querySelector(s);
const video = $('#video'), glCanvas = $('#gl'), overlay = $('#overlay');
const octx = overlay.getContext('2d');
const hud = {
  source: $('#hud-source'), effect: $('#hud-effect'), effectSub: $('#hud-effect-sub'),
  hands: $('#hud-hands'), voice: $('#hud-voice'), lock: $('#hud-lock'), toast: $('#hud-toast'),
};

// ---------- state ----------
const state = {
  selections: [],          // {base:[[x,y]..] px-units rel. centroid, cx, cy (norm), scale, rot}
  effectIdx: -1,           // -1 = none
  effectStart: 0,
  locked: false,
  drawPath: [],            // in-progress trace, normalized
  cursors: [],             // hand cursors for reticles
  moving: null,            // {dx, dy} grab offset
  sim: false,
};
const effect = () => EFFECTS[state.effectIdx] || null;

// ---------- mask (soft-edged selection texture) ----------
const MW = 512, MH = 288;
const maskCanvas = Object.assign(document.createElement('canvas'), { width: MW, height: MH });
const mctx = maskCanvas.getContext('2d');
let maskDirty = true;

function selectionScreenPts(sel, w = MW, h = MH) {
  const c = Math.cos(sel.rot), s = Math.sin(sel.rot), A = MW / MH;
  return sel.base.map(([bx, by]) => [
    (sel.cx + ((bx * c - by * s) * sel.scale) / A) * w,
    (sel.cy + (bx * s + by * c) * sel.scale) * h,
  ]);
}

function redrawMask() {
  mctx.clearRect(0, 0, MW, MH);
  mctx.fillStyle = '#fff';
  mctx.filter = 'blur(7px)';
  for (const sel of state.selections) {
    const pts = selectionScreenPts(sel);
    mctx.beginPath();
    pts.forEach(([x, y], i) => (i ? mctx.lineTo(x, y) : mctx.moveTo(x, y)));
    mctx.closePath();
    mctx.fill();
  }
  mctx.filter = 'none';
  maskDirty = true;
}

function pointInSelection(p, sel) {
  const pts = selectionScreenPts(sel, 1, 1);   // normalized space
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const activeSel = () => state.selections[state.selections.length - 1] || null;

function makeSelection(path) {
  let cx = 0, cy = 0;
  for (const [x, y] of path) { cx += x; cy += y; }
  cx /= path.length; cy /= path.length;
  const A = MW / MH;
  const base = path.map(([x, y]) => [(x - cx) * A, y - cy]);
  const size = Math.max(...base.map(([x, y]) => Math.hypot(x, y)));
  if (size < 0.04) return null;                                  // too small to be intentional
  const sel = { base, cx, cy, scale: 1, rot: 0 };
  state.selections.push(sel);
  if (state.selections.length > 4) state.selections.shift();
  redrawMask();
  return sel;
}

function defaultSelection() {                                    // for voice with no trace yet
  const path = [];
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    path.push([0.5 + Math.cos(a) * 0.16, 0.5 + Math.sin(a) * 0.26]);
  }
  return makeSelection(path);
}

// ---------- effects ----------
function setEffect(id) {
  const idx = EFFECTS.findIndex(e => e.id === id);
  if (idx < 0) return;
  if (!state.selections.length) defaultSelection();
  state.effectIdx = idx;
  state.effectStart = performance.now();
  if (EFFECTS[idx].mode === 14) captureFrozen();
  if ([15, 16, 17].includes(EFFECTS[idx].mode)) timeState.anchor = timeState.count;
  hud.effect.textContent = EFFECTS[idx].name;
  hud.effectSub.textContent = EFFECTS[idx].sub;
  hud.effect.classList.remove('flash'); void hud.effect.offsetWidth;
  hud.effect.classList.add('flash');
  const sel = activeSel();
  if (sel) particles.burst(sel.cx * overlay.width, sel.cy * overlay.height, 'spark', 30);
}

function cycleEffect() {
  if (!state.selections.length) { toast('TRACE A REGION FIRST'); return; }
  const next = (state.effectIdx + 1) % EFFECTS.length;
  setEffect(EFFECTS[next].id);
}

function clearAll() {
  state.selections = [];
  state.effectIdx = -1;
  state.locked = false;
  redrawMask();
  hud.effect.textContent = 'NO TRANSFORM';
  hud.effectSub.textContent = 'trace a region to begin';
  hud.lock.textContent = '';
  toast('REALITY RESTORED');
}

function duplicateSel() {
  const sel = activeSel();
  if (!sel) return;
  const copy = { ...sel, base: sel.base.map(p => [...p]), cx: Math.min(0.92, sel.cx + 0.14), cy: sel.cy };
  state.selections.push(copy);
  if (state.selections.length > 4) state.selections.shift();
  redrawMask();
  toast('REGION DUPLICATED');
  particles.burst(copy.cx * overlay.width, copy.cy * overlay.height, 'spark', 30);
}

function toggleLock() {
  if (!state.selections.length) return;
  state.locked = !state.locked;
  hud.lock.textContent = state.locked ? '⬢ TRANSFORM LOCKED' : '';
  toast(state.locked ? 'TRANSFORM LOCKED' : 'TRANSFORM UNLOCKED');
}

function toast(msg) {
  hud.toast.textContent = msg;
  hud.toast.classList.remove('show'); void hud.toast.offsetWidth;
  hud.toast.classList.add('show');
}

// ---------- time machinery (ring buffer of downscaled frames) ----------
const TB_N = 48, TB_W = 320, TB_H = 180, TB_MS = 70;
const timeState = {
  frames: Array.from({ length: TB_N }, () =>
    Object.assign(document.createElement('canvas'), { width: TB_W, height: TB_H })),
  count: 0, last: 0, anchor: 0,
  frozen: Object.assign(document.createElement('canvas'), { width: 640, height: 360 }),
};

function captureFrozen() {
  timeState.frozen.getContext('2d').drawImage(sourceEl(), 0, 0, 640, 360);
  renderer.upload('frozen', timeState.frozen);
}

function tickTimeBuffer(now) {
  if (now - timeState.last < TB_MS) return;
  timeState.last = now;
  const cv = timeState.frames[timeState.count % TB_N];
  cv.getContext('2d').drawImage(sourceEl(), 0, 0, TB_W, TB_H);
  timeState.count++;
}

function timeTextures(mode) {
  const { frames, count, anchor } = timeState;
  const avail = Math.min(count, TB_N);
  if (!avail) return;
  const at = i => frames[((i % TB_N) + TB_N) % TB_N];
  const clampIdx = i => Math.max(count - avail, Math.min(count - 1, i));
  if (mode === 15) {                                   // slow-mo: 0.35× playback
    const play = anchor + (count - anchor) * 0.35;
    renderer.upload('pastA', at(clampIdx(Math.floor(play))));
  } else if (mode === 16) {                            // reverse
    const back = anchor - (count - anchor);
    const idx = back < count - avail
      ? (count - avail) + (((back - (count - avail)) % avail) + avail) % avail
      : back;
    renderer.upload('pastA', at(clampIdx(idx)));
  } else if (mode === 17 || mode === 5) {              // echoes / quantum ghosts
    renderer.upload('pastA', at(clampIdx(count - 8)));
    renderer.upload('pastB', at(clampIdx(count - 18)));
  }
}

// ---------- gesture events ----------
function onGesture(ev, p) {
  const sel = activeSel();
  switch (ev) {
    case 'drawStart':
      state.drawPath = [[p.x, p.y]];
      break;
    case 'draw': {
      const last = state.drawPath[state.drawPath.length - 1];
      if (!last || Math.hypot(p.x - last[0], p.y - last[1]) > 0.008)
        state.drawPath.push([p.x, p.y]);
      break;
    }
    case 'drawEnd':
      if (p.confirm && state.drawPath.length >= 8) {
        if (makeSelection(state.drawPath)) {
          toast('REGION LOCKED — CAST A POWER');
          if (state.effectIdx < 0) hud.effectSub.textContent = '✌ or speak to choose a power';
          else state.effectStart = performance.now();
        }
      }
      state.drawPath = [];
      break;
    case 'grabStart':
      state.moving = sel && !state.locked && pointInSelection(p, sel)
        ? { dx: sel.cx - p.x, dy: sel.cy - p.y } : null;
      break;
    case 'grabMove':
      if (state.moving && sel) {
        sel.cx = p.x + state.moving.dx;
        sel.cy = p.y + state.moving.dy;
        redrawMask();
      }
      break;
    case 'grabEnd':
      state.moving = null;
      break;
    case 'twoHand':
      if (sel && !state.locked) {
        sel.scale = Math.max(0.25, Math.min(4, sel.scale * p.scale));
        sel.rot += p.rotate;
        redrawMask();
      }
      break;
    case 'cycle':     cycleEffect(); break;
    case 'clear':     clearAll(); break;
    case 'duplicate': duplicateSel(); break;
    case 'lock':      toggleLock(); break;
  }
}

// ---------- overlay drawing ----------
function drawOverlay(now) {
  const w = overlay.clientWidth, h = overlay.clientHeight;
  if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  octx.clearRect(0, 0, w, h);

  // in-progress trace: living holographic thread
  if (state.drawPath.length > 1) {
    octx.save();
    octx.lineWidth = 2.5;
    octx.lineJoin = octx.lineCap = 'round';
    octx.shadowColor = 'rgba(116,247,255,.9)';
    octx.shadowBlur = 14;
    octx.strokeStyle = 'rgba(200,255,255,.95)';
    octx.beginPath();
    state.drawPath.forEach(([x, y], i) =>
      i ? octx.lineTo(x * w, y * h) : octx.moveTo(x * w, y * h));
    octx.stroke();
    const [hx, hy] = state.drawPath[state.drawPath.length - 1];
    octx.fillStyle = '#fff';
    octx.beginPath(); octx.arc(hx * w, hy * h, 4, 0, 7); octx.fill();
    octx.restore();
  }

  // particles inside active region
  const fx = effect();
  const sel = activeSel();
  let poly = null, center = [w / 2, h / 2];
  if (sel) {
    poly = selectionScreenPts(sel, w, h);
    center = [sel.cx * w, sel.cy * h];
  }
  particles.update(1 / 60, fx ? poly : null, fx?.particles, w, h, center);
  particles.draw(octx);

  // hand reticles
  for (const c of state.cursors) {
    const x = c.pos.x * w, y = c.pos.y * h;
    const col = { point: '#ffffff', pinch: '#ff4fd8', peace: '#74f7ff', fist: '#ffb84f' }[c.pose] || 'rgba(116,247,255,.8)';
    octx.save();
    octx.strokeStyle = col;
    octx.shadowColor = col; octx.shadowBlur = 12;
    octx.lineWidth = 1.5;
    octx.beginPath(); octx.arc(x, y, c.pose === 'pinch' ? 7 : 11, 0, 7); octx.stroke();
    octx.beginPath();
    octx.moveTo(x - 17, y); octx.lineTo(x - 8, y); octx.moveTo(x + 8, y); octx.lineTo(x + 17, y);
    octx.moveTo(x, y - 17); octx.lineTo(x, y - 8); octx.moveTo(x, y + 8); octx.lineTo(x, y + 17);
    octx.stroke();
    octx.restore();
  }
}

// ---------- boot ----------
let renderer, tracker = null, gestures, particles, simScene = null;
const sourceEl = () => (state.sim ? simScene.canvas : video);

async function initCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

function initSimInput() {
  const badge = document.createElement('div');
  badge.className = 'sim-badge';
  badge.textContent = 'SYNTHETIC FEED — NO CAMERA · MOUSE: DRAG=TRACE · E=POWER · D=DUPLICATE · L=LOCK · C=RESET';
  $('#hud').appendChild(badge);
  const norm = e => ({ x: e.clientX / innerWidth, y: e.clientY / innerHeight });
  let down = false;
  addEventListener('mousemove', e => {
    const p = norm(e);
    state.cursors = [{ pos: p, pose: down ? 'point' : 'other' }];
    if (down) onGesture('draw', p);
  });
  addEventListener('mousedown', e => { down = true; onGesture('drawStart', norm(e)); });
  addEventListener('mouseup', () => { down = false; onGesture('drawEnd', { confirm: true }); });
  addEventListener('keydown', e => {
    if (e.key === 'e') cycleEffect();
    if (e.key === 'c') clearAll();
    if (e.key === 'd') duplicateSel();
    if (e.key === 'l') toggleLock();
  });
}

async function boot() {
  renderer = new Renderer(glCanvas);
  particles = new ParticleSystem();
  gestures = new GestureEngine(onGesture);
  redrawMask();

  try {
    await initCamera();
    hud.source.textContent = 'SENSOR: LIVE OPTICAL';
    tracker = new HandTracker();
    tracker.init().then(() => toast('GESTURE MATRIX ONLINE'))
      .catch(() => { hud.hands.textContent = 'HANDS: OFFLINE'; initSimInput(); });
  } catch (_) {
    state.sim = true;
    simScene = createSimScene();
    hud.source.textContent = 'SENSOR: SYNTHETIC FEED';
    initSimInput();
  }

  startVoice({
    onEffect: id => { setEffect(id); },
    onAction: a => ({ clear: clearAll, duplicate: duplicateSel, lock: toggleLock, cycle: cycleEffect }[a]?.()),
    onStatus: s => { hud.voice.textContent = s; },
  });

  requestAnimationFrame(loop);
}

// ---------- main loop ----------
let lastHandTs = 0;
function loop(now) {
  const t = now / 1000;

  if (state.sim) simScene.tick(t);
  renderer.upload('video', sourceEl());
  tickTimeBuffer(now);

  // hands
  if (tracker?.landmarker && now - lastHandTs > 33) {
    lastHandTs = now;
    const hands = tracker.detect(video, now);
    hud.hands.textContent = 'HANDS: ' + hands.length;
    state.cursors = hands.map(h => ({ pos: h.cursor, pose: h.pose }));
    gestures.update(hands);
  }

  if (maskDirty) { renderer.upload('mask', maskCanvas); maskDirty = false; }

  const fx = effect();
  const mode = fx && state.selections.length ? fx.mode : 0;
  if (mode) timeTextures(mode);

  const sel = activeSel();
  renderer.render({
    time: (now - (state.effectStart || 0)) / 1000,
    mode,
    center: sel ? [sel.cx, 1 - sel.cy] : [0.5, 0.5],
    mirror: !state.sim,
  });

  drawOverlay(now);
  requestAnimationFrame(loop);
}

// test hooks (harmless in production)
window.__re = { setEffect, cycleEffect, clearAll, state, EFFECTS, makeSelection, defaultSelection };

$('#boot-btn').addEventListener('click', () => {
  $('#boot').classList.add('hidden');
  boot();
}, { once: true });
