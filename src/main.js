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
import { initVideoSync, applyVideoSync } from './sync/video.js';
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
  setSlidesData,
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
// `slides` is reassigned when the user loads a different deck from a folder
// (see loadDeckFromFiles below), so it can't be const.
let slides = document.querySelectorAll('.slide');
setSlidesData(Array.from(slides).map(() => [])); // one empty stroke list per slide

// Whiteboard mode: a separate stack of blank pages with their own strokes.
// Starts with one empty page; more are appended on-demand when navigating past
// the last one (and only if the current page already has something drawn).

function showSlide(idx) {
  if (idx < 0 || idx >= slides.length) return;
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

// ─── Preload SVGs into slide divs ─────────────────────────────────────────────
function injectSvg(slide, svgText) {
  const svgDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  slide.innerHTML = '';
  slide.appendChild(svgDoc.documentElement);
}

async function preloadSlides() {
  const promises = [...slides].map(async (slide, index) => {
    const src = slide.dataset.src;
    if (!src) return;
    try {
      const response = await fetch(src);
      const svgText = await response.text();
      injectSvg(slide, svgText);
    } catch (err) {
      console.error(`Failed to load slide ${index + 1}:`, err);
      slide.textContent = `⚠️ Failed to load ${src}`;
    }
  });
  await Promise.all(promises);

  updateActiveSlideClass();
  setupCanvas();
}

// ─── Load deck from a folder picked by the user ───────────────────────────────
// Prototype: lets the app run serverless (file://) by having the user pick a
// folder of SVG slides. Files are sorted numerically by name ("1.svg" before
// "10.svg") so ordinal filenames map to slide order.
function pickSlidesFolder() {
  const input = document.createElement('input');
  input.type = 'file';
  input.webkitdirectory = true;
  input.multiple = true;
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    if (files.length) loadDeckFromFiles(files);
  });
  input.click();
}

async function loadDeckFromFiles(files) {
  const svgs = files
    .filter(f => f.name.toLowerCase().endsWith('.svg'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!svgs.length) return;

  const texts = await Promise.all(svgs.map(f => f.text()));
  const sources = svgs.map((file, i) => ({ name: file.name, svgText: texts[i] }));
  // Broadcast before local rebuild: rebuilding locally triggers a state
  // broadcast (via setSlidesData), and the slideshow needs the new deck in
  // place before it applies that state.
  broadcastDeck(sources);
  rebuildSlidesFromSources(sources);
}

// Also used on the slideshow side when a 'deck' message arrives, so the
// mirror can rebuild its #slides container to match the speaker's.
function rebuildSlidesFromSources(sources) {
  const container = document.getElementById('slides');
  container.innerHTML = '';
  sources.forEach(src => {
    const div = document.createElement('div');
    div.className = 'slide';
    div.dataset.src = src.name;
    injectSvg(div, src.svgText);
    container.appendChild(div);
  });

  slides = document.querySelectorAll('.slide');
  if (currentSlide >= slides.length) setCurrentSlide(0);
  setSlidesData(Array.from(slides).map(() => [])); // emits 'strokes' → redraw + toolbar sync
  updateActiveSlideClass();
  setupCanvas();
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
  return slides[currentSlide]?.querySelector('svg') || null;
}

// In whiteboard mode the underlying slide is hidden but we still use its SVG
// viewBox as the drawing area so the whiteboard "page" occupies exactly the
// same letterboxed region a slide would — and so strokes mirror to the
// slideshow window with the same aspect ratio regardless of window size.
function getReferenceBox() {
  return computeReferenceBox(getActiveSvg(), getCanvasCssSize());
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
    strokes: getStrokes(),
    liveStroke: getMirroredLiveStroke(),
  });
  if (!IS_SLIDESHOW) {
    updateProgressIndicator({
      refBox,
      current: whiteboardMode ? whiteboardCurrent + 1 : currentSlide + 1,
      total:   whiteboardMode ? whiteboardSlides.length : slides.length,
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
  slides.forEach((s, i) => s.classList.toggle('active', i === currentSlide));
}

function updateWhiteboardBodyClass() {
  document.body.classList.toggle('whiteboard-mode', whiteboardMode);
}

function syncModeDom() {
  const captureOn = isPointerCaptureOn();
  document.body.classList.toggle('drawing-enabled', captureOn);
  document.body.classList.toggle('drawing-disabled', !captureOn);
  document.body.classList.toggle('laser-mode', isLaserMode());
  document.body.classList.toggle('cursor-mode', isCursorMode());
  el.classList.toggle('drawing-disabled', !captureOn);
  tmp.classList.toggle('drawing-disabled', !captureOn);
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

  await preloadSlides();

  setupCanvas();
  initVideoSync({
    slides,
    isSlideshow: IS_SLIDESHOW,
    broadcast: postToSlideshow,
  });
  initSpeakerLink({
    getLiveStroke: getLiveStrokePoints,
    onStateApplied: redrawAll,
    onSlideshowOpened: () => { showNotes(); syncToolbar(); },
    onSlideshowClosed: () => { hideNotes(); syncToolbar(); },
    onFreezeChanged: syncToolbar,
    onVideoSync: applyVideoSync,
    onDeckReceived: rebuildSlidesFromSources,
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
      if (!getStrokes().length) return;
      getStrokes().pop();
      strokesChanged();
    },
    whiteboard: toggleWhiteboard,
    slideshow:  toggleSpeakerMode,
    freeze:     toggleFreeze,
    fullscreen: toggleFullscreen,
    loadDeck:   pickSlidesFolder,
    sizeUp:     () => { if (isDrawMode()) changeStrokeSize(LINE_WIDTH_STEP); },
    sizeDown:   () => { if (isDrawMode()) changeStrokeSize(-LINE_WIDTH_STEP); },
  };

  initToolbar({
    getSlideCount: () => slides.length,
    isSlideshowOpen,
    isFrozen,
    isBusy,
    actions,
  });
  initKeybindings(actions);
  toggleCursorMode();
});
