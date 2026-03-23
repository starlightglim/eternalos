/**
 * Cursor trail renderers.
 * Each is a simple object with init/spawn/update/render methods.
 */

interface TrailParticle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Sparkle Trail — golden particles with gravity
// ---------------------------------------------------------------------------
export function renderSparkleTrail(
  ctx: CanvasRenderingContext2D, particles: TrailParticle[], dt: number, mx: number, my: number, active: boolean
) {
  // Spawn
  if (active) {
    for (let i = 0; i < 2; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = 20 + Math.random() * 80;
      particles.push({
        x: mx + (Math.random() - 0.5) * 4, y: my + (Math.random() - 0.5) * 4,
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - 20,
        life: 0, maxLife: 0.3 + Math.random() * 0.5,
        r: 1 + Math.random() * 2, hue: Math.random() * 60 + 30,
      });
    }
  }
  // Update + render
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    if (p.life > p.maxLife) { particles.splice(i, 1); continue; }
    p.vy += 50 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const t = p.life / p.maxLife;
    ctx.beginPath();
    ctx.arc(p.x, p.y, (p.r as number) * (1 - t * 0.5), 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${p.hue}, 100%, 70%, ${1 - t})`;
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Rainbow Trail — color-cycling line
// ---------------------------------------------------------------------------
interface RainbowPoint { x: number; y: number; age: number; }

export function renderRainbowTrail(
  ctx: CanvasRenderingContext2D, trail: RainbowPoint[], dt: number, mx: number, my: number, active: boolean, hueRef: { v: number }
) {
  hueRef.v = (hueRef.v + dt * 200) % 360;
  if (active) {
    trail.push({ x: mx, y: my, age: 0 });
    if (trail.length > 50) trail.shift();
  }
  for (let i = trail.length - 1; i >= 0; i--) {
    trail[i].age += dt;
    if (trail[i].age > 0.8) { trail.splice(i, 1); }
  }
  if (trail.length < 2) return;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let i = 1; i < trail.length; i++) {
    const prev = trail[i - 1], curr = trail[i];
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(curr.x, curr.y);
    ctx.strokeStyle = `hsla(${(hueRef.v + i * 8) % 360}, 100%, 60%, ${1 - curr.age / 0.8})`;
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Ghost Trail — fading cursor echoes
// ---------------------------------------------------------------------------
interface Ghost { x: number; y: number; age: number; }

export function renderGhostTrail(
  ctx: CanvasRenderingContext2D, ghosts: Ghost[], dt: number, mx: number, my: number, active: boolean, timer: { v: number }, color: string
) {
  timer.v += dt;
  if (active && timer.v >= 0.04) {
    timer.v = 0;
    ghosts.push({ x: mx, y: my, age: 0 });
    if (ghosts.length > 15) ghosts.shift();
  }
  for (let i = ghosts.length - 1; i >= 0; i--) {
    ghosts[i].age += dt;
    if (ghosts[i].age > 0.6) { ghosts.splice(i, 1); continue; }
    const g = ghosts[i];
    const t = g.age / 0.6;
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.scale(1 + t * 0.3, 1 + t * 0.3);
    ctx.globalAlpha = (1 - t) * 0.5;
    // Small cursor arrow shape
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(0, 12); ctx.lineTo(4, 9);
    ctx.lineTo(7, 14); ctx.lineTo(9, 13); ctx.lineTo(6, 8); ctx.lineTo(10, 8);
    ctx.closePath();
    ctx.fillStyle = color === '#FFFFFF' ? 'rgba(255,255,255,1)' : color;
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
