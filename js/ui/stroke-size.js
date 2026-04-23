// Transient preview dot shown at the cursor after a stroke-size change,
// plus the clamped "bump the line width" helper that drives it.
//
// The dot fades out on its own after SHOW_DURATION_MS via a CSS transition
// driven by the `.fade` class; calling showSizeDot() again resets that
// timer and re-triggers the transition.

import { lineWidth, setLineWidth, strokeColor } from '../state.js';
import { getCursorPos } from '../drawing/input.js';

const SHOW_DURATION_MS = 350;

const LINE_WIDTH_MIN = 1;
const LINE_WIDTH_MAX = 40;
const LINE_WIDTH_STEP = 2;

const sizeDot = document.createElement('div');
sizeDot.id = 'size-dot';
document.querySelector('.canvas-wrap').appendChild(sizeDot);

let hideTimer = null;

export function showSizeDot(pos, size, color) {
  const r = size / 2;

  sizeDot.style.width  = size + 'px';
  sizeDot.style.height = size + 'px';
  sizeDot.style.left   = (pos.x - r) + 'px';
  sizeDot.style.top    = (pos.y - r) + 'px';
  sizeDot.style.background = color;

  // Re-trigger the fade transition: clear the fade class, force reflow,
  // then add `.visible` so the browser animates from scratch.
  sizeDot.classList.remove('fade');
  sizeDot.classList.add('visible');
  void sizeDot.offsetWidth;

  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    sizeDot.classList.add('fade');
  }, SHOW_DURATION_MS);
}

// Change the stroke width by one step in the given direction (+1 / -1),
// clamped to [LINE_WIDTH_MIN, LINE_WIDTH_MAX], then preview the new
// diameter at the cursor. Skips the preview until the pointer has been
// on the canvas at least once.
export function changeStrokeSize(sign) {
  const next = lineWidth + sign * LINE_WIDTH_STEP;
  setLineWidth(Math.min(LINE_WIDTH_MAX, Math.max(LINE_WIDTH_MIN, next)));
  // 'style' subscribers reapply context pens, sync the toolbar and picker.
  const pos = getCursorPos();
  if (pos) showSizeDot(pos, lineWidth, strokeColor);
}
