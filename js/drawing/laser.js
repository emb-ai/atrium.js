// Laser pointer: a short-lived red trail that follows the speaker's cursor.
//
// Reuses the `tmp` canvas as an overlay — drawing and laser modes are
// mutually exclusive, so the tmp canvas is never used for both at once.
// Each point carries a Date.now() timestamp so speaker and slideshow
// windows can fade the trail independently without needing tick-synced
// messages from the speaker.
//
// The module owns the points array outright. On the speaker window, points
// are added via pushLaserPoint(); on the slideshow, they arrive in bulk via
// setLaserPoints() from the BroadcastChannel. Both windows render from the
// same internal `points` — the speaker/slideshow asymmetry lives in the
// `shouldContinue` callback passed to initLaser().

import { tctx, getCanvasCssSize } from '../canvas.js';
import { normalizePoint, denormalizePoint } from '../geometry.js';

const LASER_STYLE = '#dc2626';
const LASER_WIDTH = 10;
const LASER_TTL = 200;
// EMA factor applied to incoming samples before they hit the trail.
// Lower = smoother but laggier; 0.5 is a good balance.
const LASER_SMOOTH_ALPHA = 0.5;

let points = [];   // [{x, y, t}] — normalized coords + Date.now() timestamp
let rafId = null;
let config = null; // { getRefBox: () => rect, shouldContinue: () => bool }

// One-time wiring from the host module. `getRefBox` returns the current
// on-screen refBox for rendering; `shouldContinue` is polled each frame to
// decide whether the RAF loop keeps running (lets speaker vs. slideshow
// windows pick their own stop condition without this module caring which
// role it's in).
export function initLaser(cfg) {
  config = cfg;
}

export function getLaserPoints() {
  return points;
}

export function setLaserPoints(arr) {
  points = Array.isArray(arr) ? arr : [];
}

export function clearLaserPoints() {
  points = [];
}

// Prune first so a stale point doesn't act as the EMA reference when the
// trail has fully aged out — the next sample should start fresh, not
// anchor off a dead tail.
export function pushLaserPoint(pos, refBox) {
  const n = normalizePoint(pos, refBox);
  pruneExpired();
  const last = points.length > 0 ? points[points.length - 1] : null;
  const smoothed = last
    ? {
        x: last.x + LASER_SMOOTH_ALPHA * (n.x - last.x),
        y: last.y + LASER_SMOOTH_ALPHA * (n.y - last.y),
      }
    : n;
  points.push({ x: smoothed.x, y: smoothed.y, t: Date.now() });
}

export function startLaserLoop() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(laserTick);
}

function pruneExpired() {
  const cutoff = Date.now() - LASER_TTL;
  let firstAlive = 0;
  while (firstAlive < points.length && points[firstAlive].t < cutoff) firstAlive++;
  if (firstAlive > 0) points.splice(0, firstAlive);
}

function laserTick() {
  renderLaserFrame();
  if (config.shouldContinue()) {
    rafId = requestAnimationFrame(laserTick);
  } else {
    rafId = null;
    const { width, height } = getCanvasCssSize();
    tctx.clearRect(0, 0, width, height);
  }
}

function renderLaserFrame() {
  const { width, height } = getCanvasCssSize();
  tctx.clearRect(0, 0, width, height);
  pruneExpired();

  const refBox = config.getRefBox();
  tctx.save();
  drawLaserTrail(tctx, points, refBox, LASER_WIDTH);

  // Head sits at the smoothed trail tip (not the raw cursor) so the dot
  // and the ribbon stay glued together — otherwise EMA smoothing leaves a
  // visible gap between them during fast motion.
  if (points.length > 0) {
    drawLaserHead(tctx, denormalizePoint(points[points.length - 1], refBox), LASER_WIDTH);
  }
  tctx.restore();
}

// Densify a polyline by routing it through quadratic curves that
// interpolate the midpoints of consecutive segments (same smoothing the
// drawing tool uses). Removes the kinks between raw pointer samples.
function smoothPolyline(pts, steps) {
  const N = pts.length;
  if (N < 3) return pts.slice();
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const out = [pts[0]];
  let start = pts[0];
  for (let i = 1; i < N - 1; i++) {
    const control = pts[i];
    const end = mid(pts[i], pts[i + 1]);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const it = 1 - t;
      out.push({
        x: it * it * start.x + 2 * it * t * control.x + t * t * end.x,
        y: it * it * start.y + 2 * it * t * control.y + t * t * end.y,
      });
    }
    start = end;
  }
  const last = pts[N - 1];
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    out.push({
      x: start.x + (last.x - start.x) * t,
      y: start.y + (last.y - start.y) * t,
    });
  }
  return out;
}

// Render the trail as a tapered filled ribbon: width and alpha both grow
// from 0 at the tail (index 0, oldest) to full at the head (last index).
// Drawn as a strip of filled quads that share exact vertices at their
// joins, which avoids the cap/overlap artifacts we'd get from stroking.
function drawLaserTrail(context, pts, refBox, width) {
  if (pts.length < 2) return;

  const rawScreen = pts.map(p => denormalizePoint(p, refBox));
  const screen = smoothPolyline(rawScreen, 4);
  const N = screen.length;

  // Per-point unit normals: average of adjacent segment normals so
  // adjacent quads meet cleanly at a shared edge instead of a jagged step.
  const normals = new Array(N);
  for (let i = 0; i < N; i++) {
    let nx = 0, ny = 0;
    if (i > 0) {
      const dx = screen[i].x - screen[i - 1].x;
      const dy = screen[i].y - screen[i - 1].y;
      const len = Math.hypot(dx, dy) || 1;
      nx += -dy / len;
      ny +=  dx / len;
    }
    if (i < N - 1) {
      const dx = screen[i + 1].x - screen[i].x;
      const dy = screen[i + 1].y - screen[i].y;
      const len = Math.hypot(dx, dy) || 1;
      nx += -dy / len;
      ny +=  dx / len;
    }
    const nlen = Math.hypot(nx, ny) || 1;
    normals[i] = { x: nx / nlen, y: ny / nlen };
  }

  context.save();
  context.fillStyle = LASER_STYLE;
  const half = width / 2;

  for (let i = 1; i < N; i++) {
    const r0 = (i - 1) / (N - 1);
    const r1 =  i      / (N - 1);
    const hw0 = half * r0;
    const hw1 = half * r1;
    const n0 = normals[i - 1];
    const n1 = normals[i];
    const p0 = screen[i - 1];
    const p1 = screen[i];

    context.globalAlpha = (r0 + r1) / 2;
    context.beginPath();
    context.moveTo(p0.x + n0.x * hw0, p0.y + n0.y * hw0);
    context.lineTo(p1.x + n1.x * hw1, p1.y + n1.y * hw1);
    context.lineTo(p1.x - n1.x * hw1, p1.y - n1.y * hw1);
    context.lineTo(p0.x - n0.x * hw0, p0.y - n0.y * hw0);
    context.closePath();
    context.fill();
  }
  context.restore();
}

function drawLaserHead(context, pos, width) {
  context.save();
  context.fillStyle = LASER_STYLE;
  context.beginPath();
  // Radius = trail width / 2 so the head matches the ribbon thickness.
  context.arc(pos.x, pos.y, width / 2, 0, Math.PI * 2);
  context.fill();
  context.restore();
}
