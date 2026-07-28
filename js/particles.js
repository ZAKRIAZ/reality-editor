// ============ 2D particle overlay ============
// Screen-space embellishments per power: bubbles, snow, embers, stardust…

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export class ParticleSystem {
  constructor() { this.parts = []; }

  // pts: selection polygon in canvas px; kind: particle style key
  update(dt, pts, kind, w, h, center) {
    // spawn
    if (pts && pts.length > 2 && kind) {
      let [minX, minY, maxX, maxY] = [1e9, 1e9, -1e9, -1e9];
      for (const [x, y] of pts) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      const rate = { quantum: 6, blackhole: 8, void: 2 }[kind] ?? 4;
      for (let n = 0; n < rate; n++) {
        if (this.parts.length > 420) break;
        const x = minX + Math.random() * (maxX - minX);
        const y = minY + Math.random() * (maxY - minY);
        if (!pointInPoly(x, y, pts)) continue;
        this.parts.push(this._spawn(kind, x, y, center));
      }
    }

    // simulate
    const cx = center[0], cy = center[1];
    this.parts = this.parts.filter(p => {
      p.life -= dt;
      if (p.life <= 0) return false;
      if (p.kind === 'orbit') {
        const dx = p.x - cx, dy = p.y - cy;
        const r = Math.hypot(dx, dy) || 1;
        const pull = 4200 / (r + 30);
        p.vx += (-dx / r) * pull * dt + (-dy / r) * 90 * dt;   // inward + tangential
        p.vy += (-dy / r) * pull * dt + (dx / r) * 90 * dt;
      }
      if (p.kind === 'bubble') p.vx += Math.sin(p.life * 6 + p.seed) * 14 * dt;
      if (p.kind === 'snow')   p.vx += Math.sin(p.life * 2 + p.seed) * 8 * dt;
      if (p.kind === 'glitch' && Math.random() < 0.1) {
        p.x += (Math.random() - 0.5) * 30; p.y += (Math.random() - 0.5) * 30;
      }
      p.x += p.vx * dt; p.y += p.vy * dt;
      return p.x > -20 && p.x < w + 20 && p.y > -20 && p.y < h + 20;
    });
  }

  _spawn(kind, x, y, center) {
    const R = Math.random;
    const base = { x, y, vx: 0, vy: 0, seed: R() * 10, kind };
    switch (kind) {
      case 'bubble': return { ...base, vy: -30 - R() * 60, size: 1.5 + R() * 4, life: 2 + R() * 2,
                              color: 'rgba(160,230,255,', alpha: .5 };
      case 'snow':   return { ...base, vy: 25 + R() * 35, size: 1 + R() * 2.5, life: 3 + R() * 2,
                              color: 'rgba(235,245,255,', alpha: .8 };
      case 'ember':  return { ...base, vy: -40 - R() * 70, vx: (R() - .5) * 30, size: 1 + R() * 2.5,
                              life: 1 + R() * 1.5, color: R() < .6 ? 'rgba(255,140,40,' : 'rgba(255,220,90,', alpha: .9 };
      case 'star':   return { ...base, vx: (R() - .5) * 8, vy: (R() - .5) * 8, size: .5 + R() * 1.8,
                              life: 2 + R() * 3, color: 'rgba(220,230,255,', alpha: .9 };
      case 'orbit':  return { ...base, vx: (R() - .5) * 60, vy: (R() - .5) * 60, size: 1 + R() * 2,
                              life: 2.5 + R() * 2, color: 'rgba(255,190,120,', alpha: .8 };
      case 'rise':   return { ...base, vy: -12 - R() * 20, size: .8 + R() * 1.6, life: 2 + R() * 2,
                              color: 'rgba(170,220,255,', alpha: .6 };
      case 'glitch': return { ...base, size: 1 + R() * 3, life: .3 + R() * .5,
                              color: R() < .5 ? 'rgba(80,255,255,' : 'rgba(255,80,220,', alpha: .9 };
      case 'dream':  return { ...base, vx: (R() - .5) * 15, vy: -8 - R() * 12, size: 2 + R() * 5,
                              life: 3 + R() * 2, color: 'rgba(255,200,235,', alpha: .35 };
      case 'spark':  return { ...base, vx: (R() - .5) * 120, vy: (R() - .5) * 120, size: .6 + R() * 1.4,
                              life: .4 + R() * .6, color: 'rgba(150,240,255,', alpha: .9 };
      default:       return { ...base, size: 1.5, life: 1, color: 'rgba(150,240,255,', alpha: .6 };
    }
  }

  burst(x, y, kind = 'spark', n = 24) {
    for (let i = 0; i < n; i++) this.parts.push(this._spawn(kind, x, y, [x, y]));
  }

  draw(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.parts) {
      const fade = Math.min(1, p.life);
      ctx.fillStyle = p.color + (p.alpha * fade) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }
}
