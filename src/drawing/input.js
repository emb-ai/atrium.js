// Canvas pointer input — mousedown, pointermove, mouseup, contextmenu.
// Owns the live-stroke state (currentPoints, isDrawing, isErasing) and
// the pencil/eraser cursor class. Self-subscribes to 'mode' so entering
// or leaving draw mode updates the cursor and closes the color picker.
//
// Erasing picks the stroke whose closest point is within ERASE_THRESHOLD
// of the pointer. Drawing clips to the reference box but keeps appending
// points when the cursor briefly leaves it — the render-time clip hides
// the outside portion, preserving stroke continuity for arcs that dip
// past the edge.

import {
  on,
  isDrawMode, isLaserMode, isPointerCaptureOn,
  strokeColor, lineWidth,
  getActiveStrokes, strokesChanged,
} from '../state.js';
import { el, getPos } from '../canvas.js';
import { normalizePoint, denormalizePoint } from '../geometry.js';
import { appendLiveSegment } from './renderer.js';
import { pushLaserPoint } from './laser.js';
import { closeColorPicker } from '../ui/color-picker.js';

const ERASE_THRESHOLD = 20;

let isDrawing = false;
let isErasing = false;
let currentPoints = [];
// Cursor starts off-canvas so the size-preview dot doesn't flash at (0,0)
// before the user has actually moved the pointer onto the canvas.
let cursorPos = { x: -999, y: -999 };
let cfg = null;

export function initInput(config) {
  cfg = config;
  if (cfg.isSlideshow) return;

  on('mode', onModeChanged);
  el.addEventListener('mousedown',   onMouseDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('mouseup', onMouseUp);
}

export function isBusy() {
  return isDrawing || isErasing;
}

export function getCursorPos() {
  return cursorPos;
}

// Normalized live-stroke points (or null if not currently drawing). Used
// by speaker to forward the in-progress stroke to the slideshow.
export function getLiveStrokePoints() {
  if (!isDrawing || currentPoints.length === 0) return null;
  return currentPoints.map(p => normalizePoint(p, cfg.getRefBox()));
}

// Cancel whatever the user is doing and commit any live stroke. Called on
// canvas resize and on whiteboard toggle so the stale isDrawing/isErasing
// flags don't hang around once their visual context (the old canvas size
// or the old stroke list) is gone.
export function resetPointerState() {
  finalizeDrawing();
  isErasing = false;
}

// Commit the in-progress stroke (if any) and clear the live-stroke state.
// Safe to call when not drawing — it's a no-op in that case.
export function finalizeDrawing() {
  if (!isDrawing) return;
  if (currentPoints.length > 1) {
    const refBox = cfg.getRefBox();
    const normalized = currentPoints.map(p => normalizePoint(p, refBox));
    getActiveStrokes().push({ points: normalized, width: lineWidth, color: strokeColor });
  }
  isDrawing = false;
  currentPoints = [];
  // Fire 'strokes' even when no stroke was pushed: the live preview on
  // `tmp` still needs clearing via the subscriber-driven redraw.
  strokesChanged();
}

function onModeChanged() {
  if (!isDrawMode()) closeColorPicker();
  updateCursor();
}

function updateCursor() {
  el.classList.remove('cursor-pencil', 'cursor-eraser');
  // Cursor mode shows the OS cursor; laser mode hides the cursor via
  // body.laser-mode CSS and the head dot stands in for it.
  if (!isDrawMode()) return;
  el.classList.add(isErasing ? 'cursor-eraser' : 'cursor-pencil');
}

function isInsideRefBox(pos) {
  const b = cfg.getRefBox();
  return pos.x >= b.x && pos.x <= b.x + b.width
      && pos.y >= b.y && pos.y <= b.y + b.height;
}

function tryDeleteClosest(pos) {
  const strokes = getActiveStrokes();
  if (!strokes.length) return;

  const refBox = cfg.getRefBox();
  let closestIdx = -1;
  let closestDist = Infinity;

  strokes.forEach((stroke, i) => {
    for (const n of stroke.points) {
      const p = denormalizePoint(n, refBox);
      const d = (p.x - pos.x) ** 2 + (p.y - pos.y) ** 2;
      if (d < closestDist) {
        closestDist = d;
        closestIdx = i;
      }
    }
  });

  if (closestIdx !== -1 && Math.sqrt(closestDist) <= ERASE_THRESHOLD) {
    strokes.splice(closestIdx, 1);
    strokesChanged();
  }
}

function onMouseDown(e) {
  // Only draw mode consumes clicks — cursor mode disables pointer capture,
  // laser ignores clicks and follows the pointer directly.
  if (!isDrawMode()) return;
  if (cfg.isFrozen()) return;
  const pos = getPos(e);
  // The canvas covers the whole wrap (including the letterbox around the
  // slide/whiteboard); reject input that starts outside the SVG viewBox
  // area so you can't paint into the empty margins.
  if (!isInsideRefBox(pos)) return;
  if (e.button === 2) {
    isErasing = true;
    updateCursor();
    tryDeleteClosest(pos);
  } else if (e.button === 0) {
    isDrawing = true;
    currentPoints = [pos];
  }
  closeColorPicker();
}

function onPointerMove(e) {
  cursorPos = getPos(e);
  if (!isPointerCaptureOn()) return;
  const inside = isInsideRefBox(cursorPos);
  if (isLaserMode()) {
    if (!cfg.isFrozen()) {
      pushLaserPoint(cursorPos, cfg.getRefBox());
      cfg.onLiveChange?.();
    }
    return;
  }
  if (isErasing) {
    if (inside) tryDeleteClosest(cursorPos);
  } else if (isDrawing) {
    // Keep appending even while the cursor is outside — the render-time
    // clip hides the outside portion, and this preserves stroke continuity
    // for arcs that briefly dip past the edge.
    currentPoints.push(cursorPos);
    appendLiveSegment(currentPoints, cfg.getRefBox());
    cfg.onLiveChange?.();
  }
}

function onMouseUp() {
  if (!isDrawMode()) return;
  finalizeDrawing();
  if (isErasing) {
    isErasing = false;
    updateCursor();
  }
}
