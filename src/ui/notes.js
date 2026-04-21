// Speaker notes panel (speaker window only). Reads per-slide notes from
// data-notes="..." on each .slide div at module load; subscribers keep the
// content in sync as slides / whiteboard mode change.
//
// The vertical resize handle writes --notes-width on <body>, which the
// panel's flex-basis reads. The canvas ResizeObserver in the main module
// picks up the resulting reflow automatically.

import { on, currentSlide, whiteboardMode } from '../state.js';

const NOTES_MIN_WIDTH = 200;
// Reserve enough horizontal room for the canvas/toolbar so dragging the
// handle can't shrink the drawing area to nothing.
const CANVAS_MIN_WIDTH = 320;

const notesPanel   = document.getElementById('notes-panel');
const notesContent = document.getElementById('notes-content');
const notesResizer = document.getElementById('notes-resizer');

const slideNotes = Array.from(document.querySelectorAll('.slide')).map(
  s => s.dataset.notes || '',
);

// Show/hide changes the panel's presence in the flex layout, which shifts
// the canvas's bounding box. The caller knows how to "refresh" the canvas
// (typically: resize backing store + redraw) so we ask for it via callback.
let onVisibilityChange = () => {};

export function initNotes({ onVisibilityChange: cb } = {}) {
  if (cb) onVisibilityChange = cb;
  on('slide', updateNotesContent);
  on('whiteboard', updateNotesContent);
  if (notesResizer) wireResizer();
}

function wireResizer() {
  let draggingId = null;
  let startX = 0;
  let startWidth = 0;

  notesResizer.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    draggingId = e.pointerId;
    startX = e.clientX;
    startWidth = notesPanel.getBoundingClientRect().width;
    notesResizer.setPointerCapture(e.pointerId);
    notesResizer.classList.add('dragging');
    e.preventDefault();
  });

  notesResizer.addEventListener('pointermove', (e) => {
    if (draggingId !== e.pointerId) return;
    const dx = e.clientX - startX;
    const maxWidth = Math.max(NOTES_MIN_WIDTH, window.innerWidth - CANVAS_MIN_WIDTH);
    const next = Math.max(NOTES_MIN_WIDTH, Math.min(maxWidth, startWidth - dx));
    document.body.style.setProperty('--notes-width', next + 'px');
  });

  const endDrag = (e) => {
    if (draggingId !== e.pointerId) return;
    draggingId = null;
    try { notesResizer.releasePointerCapture(e.pointerId); } catch (_) {}
    notesResizer.classList.remove('dragging');
  };
  notesResizer.addEventListener('pointerup', endDrag);
  notesResizer.addEventListener('pointercancel', endDrag);
}

function updateNotesContent() {
  if (whiteboardMode) {
    notesContent.textContent = '(whiteboard mode)';
    return;
  }
  const text = slideNotes[currentSlide] || '';
  notesContent.textContent = text || '(no notes for this slide)';
}

export function showNotes() {
  updateNotesContent();
  notesPanel.classList.add('visible');
  document.body.classList.add('speaker-mode');
  onVisibilityChange();
}

export function hideNotes() {
  notesPanel.classList.remove('visible');
  document.body.classList.remove('speaker-mode');
  onVisibilityChange();
}
