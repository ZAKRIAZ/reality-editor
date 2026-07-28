// ============ Hand tracking + gesture state machine ============
// MediaPipe HandLandmarker → semantic events: draw / confirm / grab / twoHand /
// cycle / clear / duplicate / lock. Coordinates: normalized screen space, y-down,
// already mirrored for selfie view.

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function classify(lm) {
  const palm = dist(lm[0], lm[9]) || 1e-4;
  const ext = (tip, pip) => dist(lm[tip], lm[0]) > dist(lm[pip], lm[0]) * 1.12;
  const fingers = [ext(8, 6), ext(12, 10), ext(16, 14), ext(20, 18)];
  const nUp = fingers.filter(Boolean).length;
  const thumbUp = dist(lm[4], lm[17]) > dist(lm[2], lm[17]) * 1.15;
  const pinch = dist(lm[4], lm[8]) < palm * 0.42;

  let pose = 'other';
  if (pinch) pose = 'pinch';
  else if (fingers[0] && nUp === 1) pose = 'point';
  else if (fingers[0] && fingers[1] && nUp === 2) pose = 'peace';
  else if (nUp === 0 && thumbUp) pose = 'thumbs';
  else if (nUp === 0 && !thumbUp) pose = 'fist';
  else if (nUp === 4) pose = 'open';

  const mir = p => ({ x: 1 - p.x, y: p.y });
  return {
    pose,
    cursor: mir(lm[8]),                                    // index tip
    pinchPoint: mir({ x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 }),
    palmCenter: mir(lm[9]),
  };
}

export class HandTracker {
  constructor() { this.landmarker = null; this.hands = []; }

  async init() {
    const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm');
    const files = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
    this.landmarker = await vision.HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      numHands: 2,
      runningMode: 'VIDEO',
    });
  }

  detect(video, ts) {
    if (!this.landmarker || video.readyState < 2) return this.hands;
    const res = this.landmarker.detectForVideo(video, ts);
    this.hands = (res.landmarks || []).map(classify);
    return this.hands;
  }
}

// ---------- gesture FSM ----------
const HOLD = { cycle: 14, clear: 22, duplicate: 16, lock: 26 };  // frames to hold
const COOLDOWN = 30;

export class GestureEngine {
  constructor(emit) {
    this.emit = emit;             // (event, payload) => void
    this.holds = {};              // pose → consecutive frames
    this.cooldowns = {};          // event → frames remaining
    this.drawing = false;
    this.grabbing = false;
    this.twoHand = null;          // {dist, ang}
    this.lastCursor = null;
  }

  _held(name, active, frames) {
    if (!active) { this.holds[name] = 0; return false; }
    this.holds[name] = (this.holds[name] || 0) + 1;
    return this.holds[name] === frames;                     // fire once
  }

  _ready(ev) {
    if ((this.cooldowns[ev] || 0) > 0) return false;
    this.cooldowns[ev] = COOLDOWN;
    return true;
  }

  update(hands) {
    for (const k in this.cooldowns) if (this.cooldowns[k] > 0) this.cooldowns[k]--;
    const [a, b] = hands;
    this.lastCursor = a ? a.cursor : null;

    // ----- two-hand pinch: scale + rotate -----
    if (a && b && a.pose === 'pinch' && b.pose === 'pinch') {
      const d = Math.hypot(a.pinchPoint.x - b.pinchPoint.x, a.pinchPoint.y - b.pinchPoint.y);
      const ang = Math.atan2(b.pinchPoint.y - a.pinchPoint.y, b.pinchPoint.x - a.pinchPoint.x);
      if (!this.twoHand) this.twoHand = { d, ang };
      else {
        this.emit('twoHand', { scale: d / this.twoHand.d, rotate: ang - this.twoHand.ang });
        this.twoHand = { d, ang };
      }
      this._endGrab(); this._endDraw();
      return;
    }
    if (this.twoHand) { this.twoHand = null; this.emit('twoHandEnd'); }

    if (!a) { this._endDraw(); this._endGrab(); this.holds = {}; return; }

    // ----- single hand -----
    switch (a.pose) {
      case 'point':
        if (!this.drawing) { this.drawing = true; this.emit('drawStart', a.cursor); }
        this.emit('draw', a.cursor);
        this._endGrab();
        break;

      case 'pinch':
        this._endDraw(true);                                 // pinch confirms a drawn path
        if (!this.grabbing) { this.grabbing = true; this.emit('grabStart', a.pinchPoint); }
        this.emit('grabMove', a.pinchPoint);
        break;

      default:
        this._endDraw();
        this._endGrab();
    }

    if (this._held('peace', a.pose === 'peace', HOLD.cycle) && this._ready('cycle'))
      this.emit('cycle', a.cursor);
    if (this._held('fist', a.pose === 'fist', HOLD.clear) && this._ready('clear'))
      this.emit('clear');
    if (this._held('thumbs', a.pose === 'thumbs', HOLD.duplicate) && this._ready('duplicate'))
      this.emit('duplicate');
    if (this._held('open', a.pose === 'open', HOLD.lock) && this._ready('lock'))
      this.emit('lock');
  }

  _endDraw(confirm = false) {
    if (!this.drawing) return;
    this.drawing = false;
    this.emit('drawEnd', { confirm });
  }
  _endGrab() {
    if (!this.grabbing) return;
    this.grabbing = false;
    this.emit('grabEnd');
  }
}
