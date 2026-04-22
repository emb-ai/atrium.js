import { computeReferenceBox } from './geometry.js';
import {
  el,
  tmp,
  getCanvasCssSize,
  setupCanvas as resizeCanvases,
} from './canvas.js';
import {
  syncPenStyles,
  redrawAll as rendererRedrawAll,
} from './drawing/renderer.js';
import {
  updateProgressIndicator,
  updateWhiteboardPagePosition,
} from './ui/progress.js';
import {
  initLaser,
  getLaserPoints,
  clearLaserPoints,
  startLaserLoop,
} from './drawing/laser.js';
import { showSizeDot } from './ui/size-dot.js';
import {
  buildColorPicker,
  toggleColorPicker,
} from './ui/color-picker.js';
import { initNotes, showNotes, hideNotes } from './ui/notes.js';
import { initToolbar, syncToolbar, showToolbar } from './ui/toolbar.js';
import {
  initSlides,
  getSlides,
  preloadSlides,
  pickDeck,
  rebuildSlidesFromSources,
} from './slides.js';
import { initVideoSync, applyVideoSync, broadcastAllVideoStates } from './sync/video.js';
import {
  IS_SLIDESHOW,
  initSpeakerLink,
  isSlideshowOpen,
  isFrozen,
  getMirroredLiveStroke,
  markSlidesReady,
  broadcastState,
  toggleSpeakerMode,
  toggleFreeze,
  postToSlideshow,
  broadcastDeck,
} from './sync/speaker.js';
import {
  initInput,
  isBusy,
  getCursorPos,
  getLiveStrokePoints,
  resetPointerState,
} from './drawing/input.js';
import { initKeybindings } from './ui/keybindings.js';
import {
  on,
  currentSlide, setCurrentSlide,
  whiteboardMode, setWhiteboardMode,
  whiteboardSlides, pushWhiteboardPage,
  whiteboardCurrent, setWhiteboardCurrent,
  strokeColor,
  lineWidth, setLineWidth,
  getActiveStrokes as getStrokes,
  strokesChanged,
  setMode,
  MODE_DRAW, MODE_LASER, MODE_CURSOR,
  isDrawMode, isLaserMode, isCursorMode, isPointerCaptureOn,
} from './state.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const LINE_WIDTH_MIN = 1;
const LINE_WIDTH_MAX = 40;
const LINE_WIDTH_STEP = 2;

// Laser module uses callbacks to stay agnostic of speaker-vs-slideshow role:
// speaker keeps the RAF loop alive while laser mode is on *or* there are
// still fading points; slideshow only keeps it alive while mirrored points
// are still fading out.
initLaser({
  getRefBox: getReferenceBox,
  shouldContinue: () => IS_SLIDESHOW
    ? getLaserPoints().length > 0
    : isLaserMode() || getLaserPoints().length > 0,
});

// ─── Slides ───────────────────────────────────────────────────────────────────
// The `slides` NodeList lives in slides.js (it's reassigned on deck load);
// read it via getSlides() so references stay fresh after rebuilds.

// Whiteboard mode: a separate stack of blank pages with their own strokes.
// Starts with one empty page; more are appended on-demand when navigating past
// the last one (and only if the current page already has something drawn).

function showSlide(idx) {
  if (idx < 0 || idx >= getSlides().length) return;
  // Laser trail is per-viewBox and ephemeral — drop it on slide change so
  // stale points don't briefly render against the new slide's coordinate space.
  clearLaserPoints();
  setCurrentSlide(idx); // subscribers handle redraw / broadcast / notes / toolbar / .active
}

function navigate(delta) {
  if (!whiteboardMode) {
    showSlide(currentSlide + delta);
    return;
  }

  const target = whiteboardCurrent + delta;
  if (target < 0) return;

  if (target >= whiteboardSlides.length) {
    // Auto-append a new blank page only if the current one has ink on it —
    // otherwise right-arrow-spamming on an empty page would pile up blanks.
    if (whiteboardSlides[whiteboardCurrent].length === 0) return;
    pushWhiteboardPage();
  }

  clearLaserPoints();
  setWhiteboardCurrent(target); // subscribers handle redraw / broadcast / toolbar
}

// ─── Size preview dot ─────────────────────────────────────────────────────────
function changeStrokeSize(delta) {
  setLineWidth(Math.min(LINE_WIDTH_MAX, Math.max(LINE_WIDTH_MIN, lineWidth + delta)));
  // 'style' subscribers reapply context pens, sync the toolbar and picker.
  // The sentinel in getCursorPos() keeps the dot from flashing at (0, 0)
  // before the pointer has ever been on the canvas.
  const pos = getCursorPos();
  if (pos.x !== -999) showSizeDot(pos, lineWidth, strokeColor);
}

// ─── Canvas helpers ───────────────────────────────────────────────────────────
function getActiveSvg() {
  return getSlides()[currentSlide]?.querySelector('svg') || null;
}

// Aspect ratio used for the whiteboard when there's no slide to borrow a
// viewBox from (empty deck). Both windows compute the same letterbox from
// this, so strokes drawn on the whiteboard in speaker mode mirror correctly
// to a differently-sized slideshow window.
const DEFAULT_WHITEBOARD_ASPECT = 16 / 9;

// In whiteboard mode the underlying slide is hidden but we still use its SVG
// viewBox as the drawing area so the whiteboard "page" occupies exactly the
// same letterboxed region a slide would — and so strokes mirror to the
// slideshow window with the same aspect ratio regardless of window size.
// With no active slide we fall back to a fixed aspect so the whiteboard
// page keeps its proportions across resizes and between the speaker /
// slideshow windows.
function getReferenceBox() {
  const svg = getActiveSvg();
  const canvasSize = getCanvasCssSize();
  if (svg) return computeReferenceBox(svg, canvasSize);
  return letterbox(DEFAULT_WHITEBOARD_ASPECT, canvasSize);
}

function letterbox(aspect, { width, height }) {
  const scale = Math.min(width / aspect, height);
  const w = aspect * scale;
  const h = scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

// Resize both canvases and redraw. Wraps the pure resize from canvas.js
// because the three non-boot callers (resize, notes show/hide) expect a
// follow-up redraw to restore pen styles + stroke content.
function setupCanvas() {
  resizeCanvases();
  redrawAll();
}

// Top-level redraw: compute the refBox once, hand it + the active stroke
// list to the renderer, then update the slide-relative UI (progress
// indicator + whiteboard page) against the same box.
function redrawAll() {
  const refBox = getReferenceBox();
  rendererRedrawAll({
    refBox,
    strokes: getStrokes() ?? [],
    liveStroke: getMirroredLiveStroke(),
  });
  if (!IS_SLIDESHOW) {
    const total = whiteboardMode ? whiteboardSlides.length : getSlides().length;
    updateProgressIndicator({
      refBox,
      current: whiteboardMode ? whiteboardCurrent + 1 : currentSlide + 1,
      total,
    });
  }
  if (whiteboardMode) updateWhiteboardPagePosition(refBox);
}

// ─── Toggles ──────────────────────────────────────────────────────────────────
// Each toggle flips between its mode and the neutral cursor mode (draw/laser)
// or between cursor and draw (M). The 'mode' subscribers fan out the
// DOM/cursor/broadcast/toolbar side-effects — the mutually-exclusive
// bookkeeping lives in one place instead of three. Existing laser points
// intentionally stay put when leaving laser so the trail fades out
// naturally; the RAF loop stops itself once they expire.
function toggleDrawing()    { setMode(isDrawMode()   ? MODE_CURSOR : MODE_DRAW);   }
function toggleLaser()      { setMode(isLaserMode()  ? MODE_CURSOR : MODE_LASER);  }
function toggleCursorMode() { setMode(isCursorMode() ? MODE_DRAW   : MODE_CURSOR); }

function toggleWhiteboard() {
  resetPointerState();
  clearLaserPoints();
  setWhiteboardMode(!whiteboardMode); // subscribers handle body class / redraw / notes / etc
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen();
  }
}

// ─── State subscriptions ─────────────────────────────────────────────────────
// When state mutates, these run automatically, so the dozens of mutation
// sites no longer each have to remember to redraw / broadcast / re-sync.

function updateActiveSlideClass() {
  getSlides().forEach((s, i) => s.classList.toggle('active', i === currentSlide));
}

function updateWhiteboardBodyClass() {
  document.body.classList.toggle('whiteboard-mode', whiteboardMode);
}

function syncModeDom() {
  const captureOn = isPointerCaptureOn();
  document.body.classList.toggle('drawing-enabled', captureOn);
  document.body.classList.toggle('drawing-disabled', !captureOn);
  document.body.classList.toggle('laser-mode', isLaserMode());
  el.classList.toggle('drawing-disabled', !captureOn);
}

function onModeChanged() {
  syncModeDom();
  if (isLaserMode()) startLaserLoop();
  syncToolbar();
}

on('slide', redrawAll);
on('slide', updateActiveSlideClass);

on('strokes', redrawAll);

on('whiteboard', redrawAll);
on('whiteboard', updateWhiteboardBodyClass);

on('style', syncPenStyles);

on('mode', onModeChanged);

// ─── Events & Initialization ─────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // Apply initial DOM state from the store before any fetches start.
  updateWhiteboardBodyClass();

  // Runs after the initial preload and after every deck rebuild: refresh the
  // .active class, resize canvases, and (re)wire <video> listeners against
  // the current slide set.
  const onDeckChange = () => {
    updateActiveSlideClass();
    document.body.classList.toggle('no-deck', getSlides().length === 0);
    setupCanvas();
    initVideoSync({
      slides: getSlides(),
      isSlideshow: IS_SLIDESHOW,
      broadcast: postToSlideshow,
    });
    syncToolbar();
  };
  initSlides({ onDeckChange });

  await preloadSlides();
  initSpeakerLink({
    getLiveStroke: getLiveStrokePoints,
    onStateApplied: redrawAll,
    onSlideshowOpened: () => { showNotes(); syncToolbar(); },
    onSlideshowClosed: () => { hideNotes(); syncToolbar(); },
    onFreezeChanged: syncToolbar,
    onVideoSync: applyVideoSync,
    onDeckReceived: rebuildSlidesFromSources,
    broadcastVideoCatchup: broadcastAllVideoStates,
  });
  initInput({
    isSlideshow: IS_SLIDESHOW,
    getRefBox: getReferenceBox,
    isFrozen,
    onLiveChange: broadcastState,
  });

  const handleCanvasResize = () => {
    resetPointerState();
    setupCanvas();
  };

  // ResizeObserver fires after layout settles and reacts to the canvas's
  // actual rendered size — so it catches tiling-WM resizes where the window
  // `resize` event can fire before the flex layout (notes sidebar sibling)
  // has fully recomputed, which would otherwise leave the backing store
  // mismatched with the CSS size until the next manual resize.
  new ResizeObserver(handleCanvasResize).observe(el);
  window.addEventListener('resize', handleCanvasResize);

  if (IS_SLIDESHOW) {
    // Slideshow window: no input, no notes panel, just mirror state.
    el.style.pointerEvents = 'none';
    tmp.style.pointerEvents = 'none';
    el.style.cursor = 'default';
    markSlidesReady();
    return;
  }

  // ─── Main window bootstrap ──────────────────────────────────────────────────
  buildColorPicker();
  initNotes({ onVisibilityChange: setupCanvas });

  // Single action table shared by the toolbar and keybindings. Keys not
  // recognized by a given consumer (toolbar has no sizeUp, keybindings has
  // no fullscreen) are simply ignored.
  const actions = {
    prev:       () => navigate(-1),
    next:       () => navigate(1),
    draw:       toggleDrawing,
    laser:      toggleLaser,
    cursor:     toggleCursorMode,
    color:      () => {
      if (!isDrawMode()) return;
      toggleColorPicker();
      showToolbar();
    },
    undo:       () => {
      if (isFrozen()) return;
      const strokes = getStrokes();
      if (!strokes?.length) return;
      strokes.pop();
      strokesChanged();
    },
    whiteboard: toggleWhiteboard,
    slideshow:  toggleSpeakerMode,
    freeze:     toggleFreeze,
    fullscreen: toggleFullscreen,
    loadDeck:   pickDeck,
    sizeUp:     () => { if (isDrawMode()) changeStrokeSize(LINE_WIDTH_STEP); },
    sizeDown:   () => { if (isDrawMode()) changeStrokeSize(-LINE_WIDTH_STEP); },
  };

  initToolbar({
    getSlideCount: () => getSlides().length,
    isSlideshowOpen,
    isFrozen,
    isBusy,
    actions,
  });
  initKeybindings(actions);
  document.getElementById('empty-deck-cta')?.addEventListener('click', pickDeck);
  toggleCursorMode();
});
