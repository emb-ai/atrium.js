// Canvas drawing primitives: turn normalized-coord stroke lists into pixels.
//
// Stateless except for the pen-style helper — callers hand in a refBox
// (the on-screen rect the active SVG viewBox occupies) so this module
// stays free of DOM lookups and the slide/whiteboard-state indirection
// those require.

import {
  ctx, tctx,
  getCanvasCssSize, applyPenStyles, clipToRect,
} from '../canvas.js';
import { denormalizePoint } from '../geometry.js';
import { lineWidth, strokeColor } from '../state.js';

// Fallback for legacy stroke objects that lack a `color` field. Kept here
// (not in state.js) because it's a rendering concern, not app state.
const DEFAULT_STROKE_COLOR = '#168afe';

function applyCurrentStyles(context) {
  applyPenStyles(context, lineWidth, strokeColor);
}

function toScreenPoints(points, refBox) {
  return points.map(p => denormalizePoint(p, refBox));
}

// Reapply current pen width/color to both contexts. Used by the 'style'
// subscriber so appendLiveSegment() picks up the new color/width without
// waiting for the next full redraw.
export function syncPenStyles() {
  applyCurrentStyles(ctx);
  applyCurrentStyles(tctx);
}

// Render a polyline as a chain of quadratic curves whose control points
// are the raw samples and whose endpoints are midpoints between
// consecutive samples. Degenerate for <2 points.
export function drawStroke(context, pts) {
  if (!pts.length) return;
  context.beginPath();

  if (pts.length === 1) {
    const r = context.lineWidth / 2;
    context.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2);
    context.fillStyle = context.strokeStyle;
    context.fill();
    return;
  }

  if (pts.length === 2) {
    context.moveTo(pts[0].x, pts[0].y);
    context.lineTo(pts[1].x, pts[1].y);
  } else {
    for (let i = 2; i < pts.length; i++) {
      const prev = pts[i - 1];
      const prevMid = { x: (pts[i - 2].x + prev.x) / 2, y: (pts[i - 2].y + prev.y) / 2 };
      const mid = { x: (prev.x + pts[i].x) / 2, y: (prev.y + pts[i].y) / 2 };
      context.moveTo(prevMid.x, prevMid.y);
      context.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
    }
  }

  context.stroke();
}

// Append just the newest quadratic segment of the in-progress stroke to
// the tmp canvas, so the speaker window doesn't have to full-redraw on
// every pointermove.
export function appendLiveSegment(pts, refBox) {
  const len = pts.length;
  if (len < 3) return;

  const prev = pts[len - 2];
  const prevMid = { x: (pts[len - 3].x + prev.x) / 2, y: (pts[len - 3].y + prev.y) / 2 };
  const mid = { x: (prev.x + pts[len - 1].x) / 2, y: (prev.y + pts[len - 1].y) / 2 };

  tctx.save();
  clipToRect(tctx, refBox);
  tctx.beginPath();
  tctx.moveTo(prevMid.x, prevMid.y);
  tctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
  tctx.stroke();
  tctx.restore();
}

// Clear both canvases and repaint every committed stroke plus (optionally)
// the in-progress live stroke. On the speaker window the live preview
// already lives on tctx via appendLiveSegment — callers pass liveStroke=null
// there. On the slideshow window liveStroke is the speaker's mirrored
// stroke and must be repainted each frame.
export function redrawAll({ refBox, strokes, liveStroke }) {
  const { width, height } = getCanvasCssSize();
  ctx.clearRect(0, 0, width, height);
  tctx.clearRect(0, 0, width, height);
  applyCurrentStyles(ctx);
  applyCurrentStyles(tctx);

  ctx.save();
  clipToRect(ctx, refBox);

  strokes.forEach(stroke => {
    ctx.lineWidth = stroke.width;
    ctx.strokeStyle = stroke.color || DEFAULT_STROKE_COLOR;
    drawStroke(ctx, toScreenPoints(stroke.points, refBox));
  });

  if (liveStroke && liveStroke.points.length) {
    ctx.lineWidth = liveStroke.width;
    ctx.strokeStyle = liveStroke.color || DEFAULT_STROKE_COLOR;
    drawStroke(ctx, toScreenPoints(liveStroke.points, refBox));
  }

  ctx.restore();
  // Restore the "live" pen styles after the per-stroke overrides so the
  // next appendLiveSegment / free draw picks up the user's current choices.
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeColor;
}
