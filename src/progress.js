// DOM positioning helpers for the slide progress indicator (#progress-indicator)
// and the whiteboard blank page (#whiteboard-page).
//
// Both elements are anchored to the reference box — the on-screen rect the
// active SVG viewBox occupies — so they stay glued to the slide content
// through window resizes. Callers pass the refBox in; this module never
// reads canvas or geometry state itself.

const progressIndicator = document.getElementById('progress-indicator');
const progressCurrent = progressIndicator.querySelector('.progress-current');
const progressTotal = progressIndicator.querySelector('.progress-total');
const whiteboardPageEl = document.getElementById('whiteboard-page');

// Inset from the refBox's bottom-right corner, in CSS pixels. The
// indicator uses transform: translate(-100%, -100%) so its (left, top) is
// its bottom-right corner — subtracting this much pulls it inside the slide.
const PROGRESS_INSET = 18;

export function updateProgressIndicator({ refBox, current, total }) {
  progressCurrent.textContent = String(current);
  progressTotal.textContent = String(total);
  progressIndicator.style.left = (refBox.x + refBox.width - PROGRESS_INSET) + 'px';
  progressIndicator.style.top  = (refBox.y + refBox.height - PROGRESS_INSET) + 'px';
}

// Position the blank whiteboard "page" to exactly cover the refBox, so it
// letterboxes identically to the underlying slide it replaces.
export function updateWhiteboardPagePosition(refBox) {
  whiteboardPageEl.style.left   = refBox.x + 'px';
  whiteboardPageEl.style.top    = refBox.y + 'px';
  whiteboardPageEl.style.width  = refBox.width + 'px';
  whiteboardPageEl.style.height = refBox.height + 'px';
}
