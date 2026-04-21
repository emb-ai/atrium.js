// Speaker toolbar: every keyboard shortcut is mirrored as a button so
// features are discoverable without memorizing the key map. Lives only
// in the main (speaker) window — on the slideshow window initToolbar is
// never called and all syncToolbar() pokes no-op against a null cfg.
//
// The bar auto-hides after HIDE_DELAY_MS and reappears when the mouse
// enters the bottom REVEAL_ZONE_PX of the viewport. The container has
// pointer-events: none in CSS so dragging the pointer between buttons
// passes through to the canvas (drawing/laser keep working); individual
// buttons re-enable pointer events.

import {
  on,
  isDrawMode, isLaserMode, isCursorMode,
  strokeColor,
  currentSlide,
  whiteboardMode, whiteboardCurrent, whiteboardSlides,
} from '../state.js';

const HIDE_DELAY_MS = 1000;
const REVEAL_ZONE_PX = 120;

const toolbarEl = document.getElementById('toolbar');

let hideTimer = null;
let hovered = false;
// Set by initToolbar(); all exported functions no-op until it's non-null,
// so module-top `on(...)` subscribers are safe even before init runs.
let cfg = null;

export function initToolbar(config) {
  if (!toolbarEl) return;
  cfg = config;

  document.addEventListener('fullscreenchange', syncToolbar);

  toolbarEl.addEventListener('click', e => {
    const btn = e.target.closest('.tb-btn');
    if (!btn || btn.disabled) return;
    const fn = cfg.actions[btn.dataset.action];
    if (!fn) return;
    fn();
    // Drop focus so the next space/enter doesn't re-trigger the button
    // and eat a keyboard shortcut.
    btn.blur();
    syncToolbar();
    showToolbar();
  });

  toolbarEl.addEventListener('mouseenter', () => {
    hovered = true;
    clearTimeout(hideTimer);
    hideTimer = null;
    toolbarEl.classList.remove('tb-hidden');
  });
  toolbarEl.addEventListener('mouseleave', () => {
    hovered = false;
    scheduleHide();
  });

  window.addEventListener('mousemove', e => {
    if (e.clientY >= window.innerHeight - REVEAL_ZONE_PX) showToolbar();
  }, { passive: true });

  on('slide',      syncToolbar);
  on('strokes',    syncToolbar);
  on('whiteboard', syncToolbar);
  on('style',      syncToolbar);
  on('mode',       syncToolbar);

  syncToolbar();
  scheduleHide();
}

export function syncToolbar() {
  if (!toolbarEl || !cfg) return;
  const btn = action => toolbarEl.querySelector(`[data-action="${action}"]`);
  const slideshowOpen = cfg.isSlideshowOpen();
  const frozen = cfg.isFrozen();

  let prevDisabled, nextDisabled;
  if (whiteboardMode) {
    prevDisabled = whiteboardCurrent === 0;
    nextDisabled = whiteboardCurrent >= whiteboardSlides.length - 1
      && whiteboardSlides[whiteboardCurrent].length === 0;
  } else {
    prevDisabled = currentSlide === 0;
    nextDisabled = currentSlide >= cfg.getSlideCount() - 1;
  }
  const prevBtn = btn('prev');
  if (prevBtn) prevBtn.disabled = prevDisabled;
  const nextBtn = btn('next');
  if (nextBtn) nextBtn.disabled = nextDisabled;

  btn('draw')?.classList.toggle('active', isDrawMode());
  btn('laser')?.classList.toggle('active', isLaserMode());
  btn('cursor')?.classList.toggle('active', isCursorMode());
  btn('whiteboard')?.classList.toggle('active', whiteboardMode);
  btn('slideshow')?.classList.toggle('active', slideshowOpen);
  btn('freeze')?.classList.toggle('active', frozen);
  btn('fullscreen')?.classList.toggle('active', !!document.fullscreenElement);

  const colorBtn = btn('color');
  if (colorBtn) {
    colorBtn.disabled = !isDrawMode();
    const dot = colorBtn.querySelector('.tb-color-dot');
    if (dot) dot.style.background = strokeColor;
  }
  const freezeBtn = btn('freeze');
  if (freezeBtn) freezeBtn.disabled = !slideshowOpen;
}

export function showToolbar() {
  if (!toolbarEl || !cfg) return;
  if (cfg.isBusy()) return;
  toolbarEl.classList.remove('tb-hidden');
  scheduleHide();
}

function scheduleHide() {
  if (!toolbarEl) return;
  clearTimeout(hideTimer);
  hideTimer = null;
  if (hovered) return;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    toolbarEl.classList.add('tb-hidden');
  }, HIDE_DELAY_MS);
}
