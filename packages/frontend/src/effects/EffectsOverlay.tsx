/**
 * EffectsOverlay — All visual desktop effects in one component.
 *
 * CSS effects (scanlines, CRT) render as lightweight divs.
 * Canvas effects (rain, snow, matrix, stars, fireflies, dust, cursor trails)
 * render on a single <canvas> with one RAF loop.
 *
 * Reads effect toggles from the appearance store's designTokens.
 * Only mounts canvas when at least one canvas effect is enabled.
 * pointer-events: none — clicks pass through to the desktop.
 */

import { useRef, useEffect, useCallback } from 'react';
import { useAppearanceStore } from '../stores/appearanceStore';
import { renderSparkleTrail, renderRainbowTrail, renderGhostTrail } from './cursorTrails';

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------
type Tokens = Record<string, string | number | boolean> | undefined;

function isOn(tokens: Tokens, key: string): boolean {
  return tokens?.[key] === true;
}

const CANVAS_EFFECTS = [
  'effects.rain.enabled', 'effects.snow.enabled', 'effects.matrix.enabled',
  'effects.stars.enabled', 'effects.fireflies.enabled', 'effects.dust.enabled',
  'effects.sparkleTrail.enabled', 'effects.rainbowTrail.enabled', 'effects.ghostTrail.enabled',
] as const;

function hasAnyCanvasEffect(tokens: Tokens): boolean {
  return CANVAS_EFFECTS.some(k => isOn(tokens, k));
}

// ---------------------------------------------------------------------------
// Particle effect renderers (inline — simple functions, not modules)
// ---------------------------------------------------------------------------

interface Particle { x: number; y: number; [k: string]: unknown; }

// Rain
function renderRain(ctx: CanvasRenderingContext2D, ps: Particle[], dt: number, w: number, h: number) {
  while (ps.length < 200) ps.push({ x: Math.random() * w, y: Math.random() * h, spd: 400 + Math.random() * 600, len: 10 + Math.random() * 20, op: 0.1 + Math.random() * 0.3 });
  for (const p of ps) {
    p.y = (p.y as number) + (p.spd as number) * dt;
    p.x = (p.x as number) + (p.spd as number) * 0.15 * dt;
    if ((p.y as number) > h) { p.y = -(p.len as number); p.x = Math.random() * w; }
    ctx.strokeStyle = `rgba(180,200,255,${p.op})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x as number, p.y as number);
    ctx.lineTo((p.x as number) + (p.len as number) * 0.15, (p.y as number) + (p.len as number));
    ctx.stroke();
  }
}

// Snow
function renderSnow(ctx: CanvasRenderingContext2D, ps: Particle[], dt: number, w: number, h: number, time: { v: number }) {
  time.v += dt;
  while (ps.length < 150) ps.push({ x: Math.random() * w, y: Math.random() * h, r: 1 + Math.random() * 3, spd: 20 + Math.random() * 60, phase: Math.random() * Math.PI * 2, wobble: 1 + Math.random() * 2, op: 0.3 + Math.random() * 0.7 });
  for (const f of ps) {
    f.y = (f.y as number) + (f.spd as number) * dt;
    f.x = (f.x as number) + Math.sin(time.v * (f.wobble as number) + (f.phase as number)) * 0.5;
    if ((f.y as number) > h + 5) { f.y = -(f.r as number); f.x = Math.random() * w; }
    ctx.beginPath();
    ctx.arc(f.x as number, f.y as number, f.r as number, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${f.op})`;
    ctx.fill();
  }
}

// Matrix
const MATRIX_CHARS = 'アイウエオカキクケコサシスセソタチツテト0123456789ABCDEF';
function renderMatrix(ctx: CanvasRenderingContext2D, cols: number[], dt: number, w: number, h: number, timer: { v: number }, color: string) {
  const FONT = 14;
  const colCount = Math.floor(w / FONT);
  while (cols.length < colCount) cols.push(Math.random() * h / FONT);
  if (cols.length > colCount) cols.length = colCount;
  timer.v += dt;
  if (timer.v < 0.05) return;
  timer.v = 0;
  ctx.fillStyle = 'rgba(0,0,0,0.05)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = color === '#FFFFFF' ? '#00FF41' : color;
  ctx.font = `${FONT}px monospace`;
  for (let i = 0; i < cols.length; i++) {
    const ch = MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];
    ctx.fillText(ch, i * FONT, cols[i] * FONT);
    if (cols[i] * FONT > h && Math.random() > 0.975) cols[i] = 0;
    cols[i]++;
  }
}

// Stars
function renderStars(ctx: CanvasRenderingContext2D, ps: Particle[], dt: number, w: number, h: number, time: { v: number }) {
  time.v += dt;
  while (ps.length < 100) ps.push({ x: Math.random() * w, y: Math.random() * h, r: 0.5 + Math.random() * 1.5, phase: Math.random() * Math.PI * 2, spd: 0.5 + Math.random() * 2, op: 0.3 + Math.random() * 0.7 });
  for (const s of ps) {
    const op = (s.op as number) * (0.5 + 0.5 * Math.sin(time.v * (s.spd as number) + (s.phase as number)));
    ctx.beginPath();
    ctx.arc(s.x as number, s.y as number, s.r as number, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${op})`;
    ctx.fill();
  }
}

// Fireflies
function renderFireflies(ctx: CanvasRenderingContext2D, ps: Particle[], dt: number, w: number, h: number, time: { v: number }) {
  time.v += dt;
  while (ps.length < 20) ps.push({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 20, vy: (Math.random() - 0.5) * 20, phase: Math.random() * Math.PI * 2, gspd: 0.5 + Math.random() * 1.5, r: 2 + Math.random() * 3 });
  for (const f of ps) {
    f.vx = ((f.vx as number) + (Math.random() - 0.5) * 30 * dt) * 0.98;
    f.vy = ((f.vy as number) + (Math.random() - 0.5) * 30 * dt) * 0.98;
    f.x = (f.x as number) + (f.vx as number) * dt;
    f.y = (f.y as number) + (f.vy as number) * dt;
    if ((f.x as number) < 0) f.x = w; if ((f.x as number) > w) f.x = 0;
    if ((f.y as number) < 0) f.y = h; if ((f.y as number) > h) f.y = 0;
    const glow = 0.3 + 0.7 * Math.max(0, Math.sin(time.v * (f.gspd as number) + (f.phase as number)));
    const gr = ctx.createRadialGradient(f.x as number, f.y as number, 0, f.x as number, f.y as number, (f.r as number) * 3);
    gr.addColorStop(0, `rgba(200,255,100,${glow * 0.6})`);
    gr.addColorStop(1, 'rgba(200,255,100,0)');
    ctx.beginPath(); ctx.arc(f.x as number, f.y as number, (f.r as number) * 3, 0, Math.PI * 2);
    ctx.fillStyle = gr; ctx.fill();
    ctx.beginPath(); ctx.arc(f.x as number, f.y as number, f.r as number, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,200,${glow})`; ctx.fill();
  }
}

// Dust
function renderDust(ctx: CanvasRenderingContext2D, ps: Particle[], dt: number, w: number, h: number) {
  while (ps.length < 60) ps.push({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 8, vy: -2 - Math.random() * 5, r: 0.5 + Math.random() * 1.5, op: 0.15 + Math.random() * 0.35 });
  for (const m of ps) {
    m.vx = ((m.vx as number) + (Math.random() - 0.5) * 10 * dt) * 0.99;
    m.vy = ((m.vy as number) + (Math.random() - 0.5) * 10 * dt) * 0.99;
    m.x = (m.x as number) + (m.vx as number) * dt;
    m.y = (m.y as number) + (m.vy as number) * dt;
    if ((m.y as number) < -5) { m.y = h + 5; m.x = Math.random() * w; }
    if ((m.y as number) > h + 5) { m.y = -5; m.x = Math.random() * w; }
    if ((m.x as number) < -5) m.x = w + 5; if ((m.x as number) > w + 5) m.x = -5;
    ctx.beginPath();
    ctx.arc(m.x as number, m.y as number, m.r as number, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(200,200,200,${m.op})`;
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EffectsOverlay() {
  const tokens = useAppearanceStore((s) => s.appearance.designTokens);

  const scanlines = isOn(tokens, 'effects.scanlines.enabled');
  const crt = isOn(tokens, 'effects.crt.enabled');
  const anyCanvas = hasAnyCanvasEffect(tokens);

  // Don't render anything if no effects are on
  if (!scanlines && !crt && !anyCanvas) return null;

  return (
    <>
      {/* CSS effects */}
      {scanlines && (
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 15,
          background: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(0,0,0,0.08) 2px, rgba(0,0,0,0.08) 4px)',
          mixBlendMode: 'multiply',
        }} />
      )}
      {crt && (
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 15,
          borderRadius: 16, boxShadow: 'inset 0 0 80px rgba(0,0,0,0.25), inset 0 0 200px rgba(0,0,0,0.1)',
        }} />
      )}
      {/* Canvas effects */}
      {anyCanvas && <CanvasLayer tokens={tokens} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Canvas layer — separate component to isolate the RAF loop
// ---------------------------------------------------------------------------

function CanvasLayer({ tokens }: { tokens: Tokens }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: 0, y: 0, active: false });

  // Persistent particle arrays (survive re-renders)
  const stateRef = useRef({
    rain: [] as Particle[],
    snow: [] as Particle[],
    matrixCols: [] as number[],
    stars: [] as Particle[],
    fireflies: [] as Particle[],
    dust: [] as Particle[],
    sparkle: [] as Particle[],
    rainbow: [] as { x: number; y: number; age: number }[],
    ghost: [] as { x: number; y: number; age: number }[],
    snowTime: { v: 0 },
    starsTime: { v: 0 },
    fireflyTime: { v: 0 },
    matrixTimer: { v: 0 },
    rainbowHue: { v: 0 },
    ghostTimer: { v: 0 },
  });

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const c = canvasRef.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    mouseRef.current = { x: e.clientX - r.left, y: e.clientY - r.top, active: true };
  }, []);

  const handleMouseLeave = useCallback(() => { mouseRef.current.active = false; }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const parent = canvas.parentElement;
    if (!parent) return;

    // Sizing
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth, h = parent.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);

    // Mouse
    const needsMouse = isOn(tokens, 'effects.sparkleTrail.enabled') ||
      isOn(tokens, 'effects.rainbowTrail.enabled') || isOn(tokens, 'effects.ghostTrail.enabled');
    if (needsMouse) {
      parent.addEventListener('mousemove', handleMouseMove);
      parent.addEventListener('mouseleave', handleMouseLeave);
    }

    const color = String(tokens?.['effects.color'] ?? '#FFFFFF');
    const hasMatrix = isOn(tokens, 'effects.matrix.enabled');
    let lastTime = performance.now();
    let raf = 0;
    const s = stateRef.current;

    const animate = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      const w = parent.clientWidth, h = parent.clientHeight;
      const m = mouseRef.current;

      // Matrix manages its own fading — don't clear if it's the only effect
      if (!hasMatrix) ctx.clearRect(0, 0, w, h);

      if (isOn(tokens, 'effects.rain.enabled')) renderRain(ctx, s.rain, dt, w, h);
      if (isOn(tokens, 'effects.snow.enabled')) renderSnow(ctx, s.snow, dt, w, h, s.snowTime);
      if (hasMatrix) renderMatrix(ctx, s.matrixCols, dt, w, h, s.matrixTimer, color);
      if (isOn(tokens, 'effects.stars.enabled')) renderStars(ctx, s.stars, dt, w, h, s.starsTime);
      if (isOn(tokens, 'effects.fireflies.enabled')) renderFireflies(ctx, s.fireflies, dt, w, h, s.fireflyTime);
      if (isOn(tokens, 'effects.dust.enabled')) renderDust(ctx, s.dust, dt, w, h);
      if (isOn(tokens, 'effects.sparkleTrail.enabled')) renderSparkleTrail(ctx, s.sparkle as any, dt, m.x, m.y, m.active);
      if (isOn(tokens, 'effects.rainbowTrail.enabled')) renderRainbowTrail(ctx, s.rainbow, dt, m.x, m.y, m.active, s.rainbowHue);
      if (isOn(tokens, 'effects.ghostTrail.enabled')) renderGhostTrail(ctx, s.ghost, dt, m.x, m.y, m.active, s.ghostTimer, color);

      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (needsMouse) {
        parent.removeEventListener('mousemove', handleMouseMove);
        parent.removeEventListener('mouseleave', handleMouseLeave);
      }
    };
  }, [tokens, handleMouseMove, handleMouseLeave]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 15, willChange: 'transform' }}
    />
  );
}
