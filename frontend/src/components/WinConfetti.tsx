import React, { useEffect, useRef, useState } from 'react';
import { TERM_COLORS, FLOW_DIRECT, FLOW_STORE } from '../theme';

/**
 * One-shot celebration confetti for the hackathon win. A single burst fires
 * ~1.5s after load from UNDER the win banner and falls the full height of the
 * page, then the canvas unmounts and never runs again.
 *
 * "From under" is a layering trick, not just an origin: the canvas is a fixed
 * full-viewport layer BELOW the 44px ribbon (z 16 < the ribbon's 20), so
 * pieces spawned at the banner's bottom edge — and any that arc upward — are
 * hidden by the opaque ribbon and only appear emerging beneath it.
 *
 * Hand-rolled on a <canvas> rather than pulled in as a dependency — one rAF
 * burst of palette-colored rectangles with gravity, drag and spin, in Donna's
 * own colors (the score-term palette + the two route colors). Honors
 * prefers-reduced-motion by not running at all.
 */

const COLORS = [...Object.values(TERM_COLORS), FLOW_DIRECT, FLOW_STORE];
// Terminal fall ≈ GRAVITY·DRAG/(1−DRAG) ≈ 4.3 px/frame (~260 px/s): a piece
// takes ~3.5s to drift a 900px viewport — slow enough to WATCH it go all the
// way down, and every piece still exits the bottom well inside its life.
const GRAVITY = 0.18;    // px/frame², scaled per piece so the sheet breaks up
const DRAG = 0.96;
const LIFE_MS = 6500;    // generous ceiling; pieces exit the bottom first
const FADE_MS = 400;     // safety fade for stragglers that somehow linger
const POP_DELAY_MS = 1500;

interface Piece {
  x: number; y: number; vx: number; vy: number;
  w: number; h: number; rot: number; vr: number;
  g: number;   // per-piece gravity factor — light pieces trail heavy ones
  color: string; born: number; life: number;
}

export function WinConfetti(): React.JSX.Element | null {
  const ref = useRef<HTMLCanvasElement>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setDone(true); return; }
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) { setDone(true); return; }

    const dpr = window.devicePixelRatio || 1;
    const size = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
    };
    size();
    window.addEventListener('resize', size);

    // The banner's bottom edge is the pop slot. The narrow ribbon may have
    // hidden the banner — fall back to just under the ribbon, top center.
    const originOf = (): [number, number] => {
      const r = document.querySelector('.win-banner')?.getBoundingClientRect();
      if (r && r.width > 0) return [r.left + r.width / 2, r.bottom - 2];
      return [window.innerWidth / 2, 44];
    };

    const pieces: Piece[] = [];
    const burst = (n: number) => {
      const [ox, oy] = originOf();
      const now = performance.now();
      for (let i = 0; i < n; i++) {
        const angle = (-90 + (Math.random() - 0.5) * 240) * (Math.PI / 180);
        const speed = 4 + Math.random() * 7;
        pieces.push({
          x: ox, y: oy,
          vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          w: 5 + Math.random() * 4, h: 8 + Math.random() * 6,
          rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
          g: 0.75 + Math.random() * 0.5,
          color: COLORS[i % COLORS.length],
          born: now, life: LIFE_MS + Math.random() * 1000,
        });
      }
    };

    let raf = 0;
    const tick = () => {
      const now = performance.now();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      for (let i = pieces.length - 1; i >= 0; i--) {
        const p = pieces[i];
        const age = now - p.born;
        // A piece dies at the BOTTOM of the page (or at its life ceiling).
        if (age > p.life || p.y > window.innerHeight + 30) { pieces.splice(i, 1); continue; }
        p.vy += GRAVITY * p.g; p.vx *= DRAG; p.vy *= DRAG;
        p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.globalAlpha = age > p.life - FADE_MS ? (p.life - age) / FADE_MS : 1;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      // The single pop has played out → unmount for good.
      if (pieces.length === 0) { setDone(true); return; }
      raf = window.requestAnimationFrame(tick);
    };

    // Just once, a beat and a half after load — the canvas idles until then.
    const t = window.setTimeout(() => {
      burst(140);
      raf = window.requestAnimationFrame(tick);
    }, POP_DELAY_MS);

    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t);
      window.removeEventListener('resize', size);
    };
  }, []);

  if (done) return null;
  return <canvas ref={ref} className="confetti" aria-hidden="true" />;
}
