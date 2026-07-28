// ============ Simulation fallback ============
// When no camera is available, a procedural "room" stands in for reality so
// every power can still be demonstrated (and the app can be tested headless).

export function createSimScene() {
  const W = 960, H = 540;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  function tick(t) {
    // walls
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#3d4a5c'); sky.addColorStop(0.62, '#2a3442'); sky.addColorStop(1, '#1c232d');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

    // window with drifting clouds
    ctx.fillStyle = '#87b7d4'; ctx.fillRect(600, 70, 260, 170);
    ctx.save(); ctx.beginPath(); ctx.rect(600, 70, 260, 170); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    for (let i = 0; i < 4; i++) {
      const cx = 600 + ((t * 12 + i * 90) % 320) - 30;
      const cy = 100 + i * 35;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 34, 13, 0, 0, 7); ctx.ellipse(cx + 22, cy - 8, 22, 10, 0, 0, 7);
      ctx.fill();
    }
    // sun
    ctx.fillStyle = '#ffe9a8'; ctx.beginPath(); ctx.arc(830, 100, 18, 0, 7); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = '#141a21'; ctx.lineWidth = 8; ctx.strokeRect(600, 70, 260, 170);
    ctx.beginPath(); ctx.moveTo(730, 70); ctx.lineTo(730, 240); ctx.stroke();

    // floor
    ctx.fillStyle = '#3a3128'; ctx.fillRect(0, 380, W, H - 380);
    ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      ctx.beginPath();
      ctx.moveTo(W / 2 + (i - 6) * 60, 380);
      ctx.lineTo(W / 2 + (i - 6) * 190, H);
      ctx.stroke();
    }

    // shelf + objects
    ctx.fillStyle = '#4d3d2e'; ctx.fillRect(80, 180, 220, 14);
    ctx.fillStyle = '#b0483a'; ctx.fillRect(110, 132, 34, 48);          // book
    ctx.fillStyle = '#3e7d5c'; ctx.fillRect(150, 140, 26, 40);          // book
    ctx.fillStyle = '#c8a83c'; ctx.beginPath(); ctx.arc(230, 158, 22, 0, 7); ctx.fill(); // vase

    // table
    ctx.fillStyle = '#5a462f'; ctx.fillRect(340, 330, 260, 16);
    ctx.fillRect(355, 346, 16, 90); ctx.fillRect(570, 346, 16, 90);
    // mug, gently steaming
    ctx.fillStyle = '#d0d4dc'; ctx.fillRect(430, 296, 40, 34);
    ctx.strokeStyle = '#d0d4dc'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(475, 313, 11, -1.2, 1.2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(450, 290);
    ctx.bezierCurveTo(444 + Math.sin(t * 2) * 6, 272, 456 + Math.sin(t * 2 + 1) * 6, 258, 450, 240);
    ctx.stroke();

    // bouncing ball — motion makes time-powers legible
    const bx = 180 + Math.sin(t * 0.9) * 120;
    const by = 470 - Math.abs(Math.sin(t * 2.6)) * 150;
    ctx.fillStyle = '#d4593a';
    ctx.beginPath(); ctx.arc(bx, by, 24, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.beginPath(); ctx.arc(bx - 8, by - 8, 7, 0, 7); ctx.fill();

    // drifting dust in a light shaft
    ctx.fillStyle = 'rgba(255,240,200,.06)';
    ctx.beginPath(); ctx.moveTo(600, 70); ctx.lineTo(860, 70); ctx.lineTo(560, H); ctx.lineTo(240, H);
    ctx.closePath(); ctx.fill();
  }

  tick(0);
  return { canvas: cv, tick };
}
