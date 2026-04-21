// ─── Constants ────────────────────────────────────────────────────────────────
const ERASE_THRESHOLD = 20;
const COLOR_PALETTE = ['#168afe', '#dc2626', '#16a34a', '#f59e0b', '#a855f7', '#ffffff', '#000000'];
const COLOR_PICKER_HIDE_DELAY = 700;
const TOOLBAR_HIDE_DELAY = 1000;
const TOOLBAR_REVEAL_ZONE = 120;
const DEFAULT_STROKE_COLOR = COLOR_PALETTE[0];
let strokeColor = DEFAULT_STROKE_COLOR;
const LINE_WIDTH_MIN = 1;
const LINE_WIDTH_MAX = 40;
const LINE_WIDTH_STEP = 2;
// Size presets shown as three dots in the color picker. Each dot renders at
// its actual stroke diameter so the button is a preview of the result.
const LINE_WIDTH_PRESETS = [3, 5, 9];
let lineWidth = LINE_WIDTH_PRESETS[1];

// Laser pointer: short-living red trace that follows the cursor.
// Width is fixed (independent of the drawing stroke size controlled by +/-).
const LASER_STYLE = '#dc2626';
const LASER_WIDTH = 10;
const LASER_TTL = 200;
// EMA factor applied to incoming samples before they hit the trail.
// Lower = smoother but laggier; 0.5 is a good balance.
const LASER_SMOOTH_ALPHA = 0.5;

// ─── Speaker mode ─────────────────────────────────────────────────────────────
const IS_SLIDESHOW = new URLSearchParams(location.search).has('slideshow');
const channel = new BroadcastChannel('slides-speaker-mode');
let slideshowWin = null;

// Mark the slideshow window so CSS can suppress the notes panel there.
if (IS_SLIDESHOW) document.body.classList.add('is-slideshow');
document.title = IS_SLIDESHOW ? 'Slideshow' : 'Speaker';

function isFrozen() {
  // Freeze auto-clears if the slideshow window has been closed.
  if (frozen && (!slideshowWin || slideshowWin.closed)) {
    frozen = false;
  }
  syncFreezeIndicator();
  return frozen;
}

function syncFreezeIndicator() {
  document.body.classList.toggle('is-frozen', frozen);
  syncToolbar();
}

function broadcastState() {
  if (IS_SLIDESHOW) return;
  if (isFrozen()) return;
  let liveStrokeNormalized = null;
  if (isDrawing && currentPoints.length > 0) {
    const refBox = getReferenceBox();
    liveStrokeNormalized = currentPoints.map(p => normalizePoint(p, refBox));
  }
  channel.postMessage({
    type: 'state',
    currentSlide,
    slidesData,
    drawingEnabled,
    liveStroke: liveStrokeNormalized,
    liveStrokeWidth: lineWidth,
    liveStrokeColor: strokeColor,
    laserPoints,
    whiteboardMode,
    whiteboardSlides,
    whiteboardCurrent,
  });
}

// ─── Canvas setup ─────────────────────────────────────────────────────────────
const el  = document.getElementById('c');
const ctx = el.getContext('2d');

const tmp  = Object.assign(document.createElement('canvas'), { id: 'tmp' });
const tctx = tmp.getContext('2d');
el.insertAdjacentElement('afterend', tmp);

// ─── Slides ───────────────────────────────────────────────────────────────────
let currentSlide = 0;
const slides = document.querySelectorAll('.slide');
let slidesData = Array.from(slides).map(() => []); // normalized strokes per slide

// Speaker notes — read directly from data-notes="..." on each .slide div.
const slideNotes = Array.from(slides).map(s => s.dataset.notes || '');

// Whiteboard mode: a separate stack of blank pages with their own strokes.
// Starts with one empty page; more are appended on-demand when navigating past
// the last one (and only if the current page already has something drawn).
//
// The slideshow window reads `whiteboard=1` from the URL so it can boot
// straight into whiteboard mode — otherwise there's a visible flash of real
// slides between page load and the first `state` message arriving via
// BroadcastChannel.
let whiteboardMode = new URLSearchParams(location.search).get('whiteboard') === '1';
let whiteboardSlides = [[]];
let whiteboardCurrent = 0;

if (whiteboardMode) document.body.classList.add('whiteboard-mode');

function getStrokes() {
  if (whiteboardMode) return whiteboardSlides[whiteboardCurrent];
  return slidesData[currentSlide];
}

function showSlide(idx) {
  if (idx < 0 || idx >= slides.length) return;
  slides[currentSlide].classList.remove('active');
  currentSlide = idx;
  slides[currentSlide].classList.add('active');
  // Laser trail is per-viewBox and ephemeral — drop it on slide change so
  // stale points don't briefly render against the new slide's coordinate space.
  laserPoints = [];
  redrawAll();
  broadcastState();
  updateNotesContent(); // keep notes bar in sync with the current slide
  syncToolbar();
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
    whiteboardSlides.push([]);
  }

  whiteboardCurrent = target;
  laserPoints = [];
  redrawAll();
  broadcastState();
  syncToolbar();
}

function toggleWhiteboard() {
  if (isDrawing) {
    finalizeDrawing();
    isDrawing = false;
  }
  whiteboardMode = !whiteboardMode;
  document.body.classList.toggle('whiteboard-mode', whiteboardMode);
  laserPoints = [];
  redrawAll();
  broadcastState();
  updateNotesContent();
  syncToolbar();
}

// ─── Preload SVGs into slide divs ─────────────────────────────────────────────
async function preloadSlides() {
  const promises = [...slides].map(async (slide, index) => {
    const src = slide.dataset.src;
    if (!src) return;
    try {
      const response = await fetch(src);
      const svgText = await response.text();
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(svgText, 'image/svg+xml');
      slide.innerHTML = '';
      slide.appendChild(svgDoc.documentElement);
    } catch (err) {
      console.error(`Failed to load slide ${index + 1}:`, err);
      slide.textContent = `⚠️ Failed to load ${src}`;
    }
  });
  await Promise.all(promises);

  slides[0].classList.add('active');
  setupCanvas();
}

// ─── Video sync between speaker and slideshow windows ───────────────────────
function getAllVideos() {
  // Returns [{slideIdx, videoIdx, el}] for every <video> found in the slides,
  // identified by (slide index, index of <video> within that slide).
  const out = [];
  slides.forEach((slide, slideIdx) => {
    const videos = slide.querySelectorAll('video');
    videos.forEach((v, videoIdx) => out.push({ slideIdx, videoIdx, el: v }));
  });
  return out;
}

function findVideo(slideIdx, videoIdx) {
  const slide = slides[slideIdx];
  if (!slide) return null;
  return slide.querySelectorAll('video')[videoIdx] || null;
}

// Called from slideshow-applied syncs so our own mirrored .play()/.pause()
// doesn't bounce back as another broadcast.
let suppressVideoBroadcast = false;

function broadcastVideoState(slideIdx, videoIdx, videoEl) {
  if (IS_SLIDESHOW) return;
  if (isFrozen()) return;
  if (!slideshowWin || slideshowWin.closed) return;
  channel.postMessage({
    type: 'video-sync',
    slideIdx,
    videoIdx,
    paused: videoEl.paused,
    currentTime: videoEl.currentTime,
    playbackRate: videoEl.playbackRate,
    muted: videoEl.muted,
    volume: videoEl.volume,
  });
}

function setupVideoSync() {
  const videos = getAllVideos();
  const events = ['play', 'pause', 'seeked', 'ratechange', 'volumechange', 'ended'];

  for (const { slideIdx, videoIdx, el: v } of videos) {
    if (IS_SLIDESHOW) {
      // Slideshow videos should be muted — the lecturer's physical voice carries.
      // (Still synced to the speaker video's own muted state when messages arrive,
      // but default to muted so autoplay policies allow scripted .play().)
      v.muted = true;

      // Video state is driven entirely by the speaker window via video-sync
      // messages. Hide the native controls so the slideshow audience can't
      // desync playback, and block pointer events so clicks/scrubs on the
      // element can't interact with it either.
      v.controls = false;
      v.removeAttribute('controls');
      v.disablePictureInPicture = true;
      v.style.pointerEvents = 'none';
    } else {
      for (const type of events) {
        v.addEventListener(type, () => {
          if (suppressVideoBroadcast) return;
          broadcastVideoState(slideIdx, videoIdx, v);
        });
      }
    }
  }
}

function applyVideoSync(msg) {
  const v = findVideo(msg.slideIdx, msg.videoIdx);
  if (!v) return;

  suppressVideoBroadcast = true;
  try {
    // Align currentTime only if it has drifted — avoid fighting normal playback.
    const drift = Math.abs(v.currentTime - msg.currentTime);
    if (drift > 0.3) {
      v.currentTime = msg.currentTime;
    }

    v.playbackRate = msg.playbackRate;
    // Keep slideshow muted regardless of speaker window's mute state,
    // so the slideshow doesn't double audio from the lecturer's machine.
    v.muted = true;

    if (msg.paused && !v.paused) {
      v.pause();
    } else if (!msg.paused && v.paused) {
      // .play() returns a promise that may reject under autoplay policy.
      const p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch(err => console.warn('Slideshow video play() rejected:', err));
      }
    }
  } finally {
    // Release suppression on next tick — the DOM will fire sync events in
    // response to our programmatic changes.
    setTimeout(() => { suppressVideoBroadcast = false; }, 0);
  }
}

// ─── State ────────────────────────────────────────────────────────────────────
let isDrawing = false;
let isErasing = false;
let currentPoints = []; // live stroke in canvas-local CSS pixels
let drawingEnabled = true;
let frozen = false;
let mirroredLiveStroke = null; // slideshow-only: normalized live stroke from speaker window
let laserMode = false;
let cursorMode = false;
let laserPoints = []; // [{x, y, t}] — normalized coords with Date.now() timestamps
let mirroredLaserPoints = []; // slideshow-only: mirrored from speaker window
let laserRafId = null;

// ─── Size preview dot ─────────────────────────────────────────────────────────
let cursorPos = { x: -999, y: -999 };
let dotHideTimer = null;

const sizeDot = document.createElement('div');
sizeDot.id = 'size-dot';
document.querySelector('.canvas-wrap').appendChild(sizeDot);

function showSizeDot() {
  const r = lineWidth / 2;

  sizeDot.style.width  = lineWidth + 'px';
  sizeDot.style.height = lineWidth + 'px';
  sizeDot.style.left   = (cursorPos.x - r) + 'px';
  sizeDot.style.top    = (cursorPos.y - r) + 'px';
  sizeDot.style.background = strokeColor;

  // Re-trigger transition: remove fade class, force reflow, re-show
  sizeDot.classList.remove('fade');
  sizeDot.classList.add('visible');
  void sizeDot.offsetWidth; // reflow

  clearTimeout(dotHideTimer);
  dotHideTimer = setTimeout(() => {
    sizeDot.classList.add('fade');
  }, 350);
}

function changeStrokeSize(delta) {
  lineWidth = Math.min(LINE_WIDTH_MAX, Math.max(LINE_WIDTH_MIN, lineWidth + delta));
  applyStyles(ctx);
  applyStyles(tctx);
  if (cursorPos.x !== -999) showSizeDot();
  syncColorPickerSelection();
}

// ─── Canvas helpers ───────────────────────────────────────────────────────────
function applyStyles(context) {
  context.lineWidth   = lineWidth;
  context.lineJoin    = 'round';
  context.lineCap     = 'round';
  context.strokeStyle = strokeColor;
}

function getCanvasCssSize() {
  const rect = el.getBoundingClientRect();
  return {
    width: el.clientWidth || rect.width,
    height: el.clientHeight || rect.height,
  };
}

function getActiveSvg() {
  return slides[currentSlide]?.querySelector('svg') || null;
}

function parsePreserveAspectRatio(svg) {
  const raw = (svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim();
  if (raw === 'none') {
    return { align: 'none', mode: 'meet' };
  }

  const parts = raw.split(/\s+/).filter(Boolean);
  return {
    align: parts[0] || 'xMidYMid',
    mode: parts[1] || 'meet',
  };
}

function getReferenceBox() {
  const canvasSize = getCanvasCssSize();
  // In whiteboard mode the underlying slide is hidden but we still use its
  // SVG viewBox as the drawing area so the whiteboard "page" occupies exactly
  // the same letterboxed region a slide would — and so strokes mirror to the
  // slideshow window with the same aspect ratio regardless of window size.
  const svg = getActiveSvg();

  if (!svg) {
    return { x: 0, y: 0, width: canvasSize.width, height: canvasSize.height };
  }

  const viewBox = svg.viewBox?.baseVal;
  const vbWidth = viewBox?.width || parseFloat(svg.getAttribute('width')) || canvasSize.width;
  const vbHeight = viewBox?.height || parseFloat(svg.getAttribute('height')) || canvasSize.height;

  if (!vbWidth || !vbHeight) {
    return { x: 0, y: 0, width: canvasSize.width, height: canvasSize.height };
  }

  const { align, mode } = parsePreserveAspectRatio(svg);
  if (align === 'none') {
    return { x: 0, y: 0, width: canvasSize.width, height: canvasSize.height };
  }

  const scale = mode === 'slice'
    ? Math.max(canvasSize.width / vbWidth, canvasSize.height / vbHeight)
    : Math.min(canvasSize.width / vbWidth, canvasSize.height / vbHeight);

  const width = vbWidth * scale;
  const height = vbHeight * scale;

  let x = 0;
  let y = 0;

  if (align.includes('xMid')) x = (canvasSize.width - width) / 2;
  else if (align.includes('xMax')) x = canvasSize.width - width;

  if (align.includes('YMid')) y = (canvasSize.height - height) / 2;
  else if (align.includes('YMax')) y = canvasSize.height - height;

  return { x, y, width, height };
}

function normalizePoint(point, refBox) {
  return {
    x: refBox.width > 0 ? (point.x - refBox.x) / refBox.width : 0,
    y: refBox.height > 0 ? (point.y - refBox.y) / refBox.height : 0,
  };
}

function denormalizePoint(point, refBox) {
  return {
    x: refBox.x + point.x * refBox.width,
    y: refBox.y + point.y * refBox.height,
  };
}

function toScreenPoints(points) {
  const refBox = getReferenceBox();
  return points.map(point => denormalizePoint(point, refBox));
}

function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = getCanvasCssSize();

  for (const canvas of [el, tmp]) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  for (const context of [ctx, tctx]) {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.scale(dpr, dpr);
    applyStyles(context);
  }

  redrawAll();
}

function getPos(e) {
  const rect = el.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function isInsideRefBox(pos) {
  const b = getReferenceBox();
  return pos.x >= b.x && pos.x <= b.x + b.width
      && pos.y >= b.y && pos.y <= b.y + b.height;
}

// Clip subsequent drawing to the active slide / whiteboard area. Must be
// paired with context.save()/restore() by the caller so the clip doesn't
// leak into later unrelated draws.
function applyRefBoxClip(context) {
  const b = getReferenceBox();
  context.beginPath();
  context.rect(b.x, b.y, b.width, b.height);
  context.clip();
}

// ─── Drawing ──────────────────────────────────────────────────────────────────
function drawStroke(context, pts) {
  if (pts.length < 2) return;
  context.beginPath();

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

function appendLiveSegment(pts) {
  const len = pts.length;
  if (len < 3) return;

  const prev = pts[len - 2];
  const prevMid = { x: (pts[len - 3].x + prev.x) / 2, y: (pts[len - 3].y + prev.y) / 2 };
  const mid = { x: (prev.x + pts[len - 1].x) / 2, y: (prev.y + pts[len - 1].y) / 2 };

  tctx.save();
  applyRefBoxClip(tctx);
  tctx.beginPath();
  tctx.moveTo(prevMid.x, prevMid.y);
  tctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
  tctx.stroke();
  tctx.restore();
}

const progressIndicator = document.getElementById('progress-indicator');
const progressCurrent = progressIndicator.querySelector('.progress-current');
const progressTotal = progressIndicator.querySelector('.progress-total');

const whiteboardPageEl = document.getElementById('whiteboard-page');

function updateWhiteboardPagePosition() {
  if (!whiteboardMode) return;
  const refBox = getReferenceBox();
  whiteboardPageEl.style.left   = refBox.x + 'px';
  whiteboardPageEl.style.top    = refBox.y + 'px';
  whiteboardPageEl.style.width  = refBox.width + 'px';
  whiteboardPageEl.style.height = refBox.height + 'px';
}

function updateProgressIndicator() {
  if (IS_SLIDESHOW) return;
  if (whiteboardMode) {
    progressCurrent.textContent = String(whiteboardCurrent + 1);
    progressTotal.textContent = String(whiteboardSlides.length);
  } else {
    progressCurrent.textContent = String(currentSlide + 1);
    progressTotal.textContent = String(slides.length);
  }

  // Anchor to the bottom-right corner of the SVG's rendered area (the slide
  // content), not the canvas-wrap container. The element uses
  // transform: translate(-100%, -100%) so (left, top) is its bottom-right.
  const refBox = getReferenceBox();
  const inset = 18;
  progressIndicator.style.left = (refBox.x + refBox.width - inset) + 'px';
  progressIndicator.style.top  = (refBox.y + refBox.height - inset) + 'px';
}

function redrawAll() {
  const { width, height } = getCanvasCssSize();
  ctx.clearRect(0, 0, width, height);
  tctx.clearRect(0, 0, width, height);
  applyStyles(ctx);
  applyStyles(tctx);

  ctx.save();
  applyRefBoxClip(ctx);

  getStrokes().forEach(stroke => {
    ctx.lineWidth = stroke.width;
    ctx.strokeStyle = stroke.color || DEFAULT_STROKE_COLOR;
    drawStroke(ctx, toScreenPoints(stroke.points));
  });

  if (mirroredLiveStroke && mirroredLiveStroke.points.length > 1) {
    ctx.lineWidth = mirroredLiveStroke.width;
    ctx.strokeStyle = mirroredLiveStroke.color || DEFAULT_STROKE_COLOR;
    drawStroke(ctx, toScreenPoints(mirroredLiveStroke.points));
  }

  ctx.restore();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeColor;

  updateProgressIndicator();
  updateWhiteboardPagePosition();
}

// ─── Laser pointer ────────────────────────────────────────────────────────────
// Laser mode reuses the `tmp` canvas as an overlay (it's otherwise only used
// for live stroke segments, and the two modes are mutually exclusive).
// Each point carries a Date.now() timestamp so the speaker and slideshow
// windows can fade the trail independently without needing tick-synchronized
// messages.
function pruneLaser(points) {
  const cutoff = Date.now() - LASER_TTL;
  let firstAlive = 0;
  while (firstAlive < points.length && points[firstAlive].t < cutoff) firstAlive++;
  if (firstAlive > 0) points.splice(0, firstAlive);
}

// Densify a polyline by routing it through quadratic curves that interpolate
// the midpoints of consecutive segments (same smoothing the drawing tool
// uses). Removes the kinks between raw pointer samples.
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

function drawLaserTrail(context, points, refBox, width) {
  if (points.length < 2) return;

  // Render the trail as a tapered filled ribbon: width and alpha both go
  // from 0 at the tail (index 0, oldest) to full at the head (last index).
  // Drawn as a strip of filled quads that share exact vertices at their
  // joins, which avoids the cap/overlap artifacts we'd get from stroking.
  const rawScreen = points.map(p => denormalizePoint(p, refBox));
  const screen = smoothPolyline(rawScreen, 4);
  const N = screen.length;

  // Per-point unit normals: average of adjacent segment normals so adjacent
  // quads meet cleanly at a shared edge instead of a jagged step.
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
  // Radius = stroke width / 2 so the head matches the trail thickness.
  context.arc(pos.x, pos.y, width / 2, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function renderLaserFrame() {
  const { width, height } = getCanvasCssSize();
  tctx.clearRect(0, 0, width, height);

  const points = IS_SLIDESHOW ? mirroredLaserPoints : laserPoints;
  pruneLaser(points);

  const refBox = getReferenceBox();
  tctx.save();
  applyRefBoxClip(tctx);
  drawLaserTrail(tctx, points, refBox, LASER_WIDTH);

  // Head sits at the smoothed trail tip (not the raw cursor) so the dot and
  // the ribbon stay glued together — otherwise EMA smoothing leaves a gap
  // between them during fast motion.
  if (points.length > 0) {
    drawLaserHead(tctx, denormalizePoint(points[points.length - 1], refBox), LASER_WIDTH);
  }
  tctx.restore();
}

function laserLoopActive() {
  if (IS_SLIDESHOW) return mirroredLaserPoints.length > 0;
  return laserMode || laserPoints.length > 0;
}

function laserTick() {
  renderLaserFrame();
  if (laserLoopActive()) {
    laserRafId = requestAnimationFrame(laserTick);
  } else {
    laserRafId = null;
    const { width, height } = getCanvasCssSize();
    tctx.clearRect(0, 0, width, height);
  }
}

function startLaserLoop() {
  if (laserRafId !== null) return;
  laserRafId = requestAnimationFrame(laserTick);
}

function pushLaserPoint(pos) {
  const refBox = getReferenceBox();
  const n = normalizePoint(pos, refBox);
  // Prune first so a stale point doesn't act as the EMA reference: when
  // the trail has fully aged out, the next sample should start fresh.
  pruneLaser(laserPoints);
  const last = laserPoints.length > 0 ? laserPoints[laserPoints.length - 1] : null;
  const a = LASER_SMOOTH_ALPHA;
  const smoothed = last
    ? { x: last.x + a * (n.x - last.x), y: last.y + a * (n.y - last.y) }
    : n;
  laserPoints.push({ x: smoothed.x, y: smoothed.y, t: Date.now() });
  broadcastState();
}

function toggleCursorMode() {
  if (cursorMode) {
    cursorMode = false;
    document.body.classList.remove('cursor-mode');
    setDrawingEnabled(true);
    return;
  }
  if (laserMode) {
    laserMode = false;
    document.body.classList.remove('laser-mode');
  }
  cursorMode = true;
  document.body.classList.add('cursor-mode');
  closeColorPicker();
  setDrawingEnabled(false);
}

function toggleLaser() {
  if (laserMode) {
    // Disabling laser → fall back to cursor mode (the neutral resting state).
    // Existing laser points stay put so the trail fades out naturally; the
    // RAF loop stops itself once everything expires.
    laserMode = false;
    document.body.classList.remove('laser-mode');
    cursorMode = true;
    document.body.classList.add('cursor-mode');
    setDrawingEnabled(false);
    return;
  }
  laserMode = true;
  document.body.classList.add('laser-mode');
  if (cursorMode) {
    cursorMode = false;
    document.body.classList.remove('cursor-mode');
  }
  closeColorPicker();
  // Laser needs the canvas to capture pointer events, so it can only run
  // while drawingEnabled is true (that flag controls pointer-events on the
  // canvas). If the user enabled laser while drawingEnabled was false
  // (cursor mode), force it back on.
  if (!drawingEnabled) {
    setDrawingEnabled(true);
  } else {
    updateCursor();
    syncToolbar();
  }
  startLaserLoop();
}

// ─── Erasing ──────────────────────────────────────────────────────────────────
function tryDeleteClosest(pos) {
  const strokes = getStrokes();
  if (!strokes.length) return;

  let closestIdx = -1;
  let closestDist = Infinity;

  strokes.forEach((stroke, i) => {
    const screenPoints = toScreenPoints(stroke.points);
    for (const p of screenPoints) {
      const d = (p.x - pos.x) ** 2 + (p.y - pos.y) ** 2;
      if (d < closestDist) {
        closestDist = d;
        closestIdx = i;
      }
    }
  });

  if (closestIdx !== -1 && Math.sqrt(closestDist) <= ERASE_THRESHOLD) {
    strokes.splice(closestIdx, 1);
    redrawAll();
    broadcastState();
    syncToolbar();
  }
}

// ─── Toggles ──────────────────────────────────────────────────────────────────
function setDrawingEnabled(on) {
  drawingEnabled = on;

  document.body.classList.toggle('drawing-enabled', drawingEnabled);
  document.body.classList.toggle('drawing-disabled', !drawingEnabled);

  el.classList.toggle('drawing-disabled', !drawingEnabled);
  tmp.classList.toggle('drawing-disabled', !drawingEnabled);

  if (!drawingEnabled) closeColorPicker();

  updateCursor();
  broadcastState();
  syncToolbar();
}

function toggleDrawing() {
  // Mutually exclusive with laser / cursor modes: clicking pencil while
  // either is on switches straight into drawing, it doesn't just clear them.
  if (laserMode) {
    laserMode = false;
    document.body.classList.remove('laser-mode');
    setDrawingEnabled(true);
    return;
  }
  if (cursorMode) {
    cursorMode = false;
    document.body.classList.remove('cursor-mode');
    setDrawingEnabled(true);
    return;
  }
  // Already in drawing mode → disabling returns to cursor mode (the neutral
  // resting state), not a fourth "everything off" state.
  cursorMode = true;
  document.body.classList.add('cursor-mode');
  setDrawingEnabled(false);
}

function toggleFreeze() {
  // Freeze only applies when a slideshow window is open.
  if (!slideshowWin || slideshowWin.closed) {
    if (frozen) {
      frozen = false;
    }
    return;
  }
  frozen = !frozen;
  syncFreezeIndicator();
  if (!frozen) {
    // On unfreeze, immediately sync slideshow to current state.
    broadcastState();
  }
}

// ─── Speaker toolbar ──────────────────────────────────────────────────────────
// Every keyboard shortcut is mirrored as a toolbar button so features are
// discoverable without memorizing the key map. Lives only in the main window.
const toolbarEl = document.getElementById('toolbar');

function syncToolbar() {
  if (!toolbarEl || IS_SLIDESHOW) return;
  const btn = action => toolbarEl.querySelector(`[data-action="${action}"]`);
  const slideshowOpen = !!(slideshowWin && !slideshowWin.closed);

  let prevDisabled, nextDisabled;
  if (whiteboardMode) {
    prevDisabled = whiteboardCurrent === 0;
    nextDisabled = whiteboardCurrent >= whiteboardSlides.length - 1
      && whiteboardSlides[whiteboardCurrent].length === 0;
  } else {
    prevDisabled = currentSlide === 0;
    nextDisabled = currentSlide >= slides.length - 1;
  }
  const prevBtn = btn('prev');
  if (prevBtn) prevBtn.disabled = prevDisabled;
  const nextBtn = btn('next');
  if (nextBtn) nextBtn.disabled = nextDisabled;

  btn('draw')?.classList.toggle('active', drawingEnabled && !laserMode && !cursorMode);
  btn('laser')?.classList.toggle('active', laserMode);
  btn('cursor')?.classList.toggle('active', cursorMode);
  btn('whiteboard')?.classList.toggle('active', whiteboardMode);
  btn('slideshow')?.classList.toggle('active', slideshowOpen);
  btn('freeze')?.classList.toggle('active', frozen);

  const colorBtn = btn('color');
  if (colorBtn) {
    colorBtn.disabled = !drawingEnabled || laserMode;
    const dot = colorBtn.querySelector('.tb-color-dot');
    if (dot) dot.style.background = strokeColor;
  }
  const freezeBtn = btn('freeze');
  if (freezeBtn) freezeBtn.disabled = !slideshowOpen;
}

let toolbarHideTimer = null;
let toolbarHovered = false;

function showToolbar() {
  if (!toolbarEl || IS_SLIDESHOW) return;
  if (isDrawing || isErasing) return;
  toolbarEl.classList.remove('tb-hidden');
  scheduleToolbarHide();
}

function scheduleToolbarHide() {
  if (!toolbarEl || IS_SLIDESHOW) return;
  clearTimeout(toolbarHideTimer);
  toolbarHideTimer = null;
  if (toolbarHovered) return;
  toolbarHideTimer = setTimeout(() => {
    toolbarHideTimer = null;
    toolbarEl.classList.add('tb-hidden');
  }, TOOLBAR_HIDE_DELAY);
}

function wireToolbar() {
  if (!toolbarEl || IS_SLIDESHOW) return;
  const actions = {
    prev:        () => navigate(-1),
    next:        () => navigate(1),
    draw:        () => toggleDrawing(),
    laser:       () => toggleLaser(),
    cursor:      () => toggleCursorMode(),
    color:       () => { if (drawingEnabled && !laserMode) toggleColorPicker(); },
    undo:        () => {
      if (isFrozen()) return;
      if (!getStrokes().length) return;
      getStrokes().pop();
      redrawAll();
      broadcastState();
      syncToolbar();
    },
    whiteboard:  () => toggleWhiteboard(),
    slideshow:   () => toggleSpeakerMode(),
    freeze:      () => toggleFreeze(),
  };

  toolbarEl.addEventListener('click', e => {
    const btn = e.target.closest('.tb-btn');
    if (!btn || btn.disabled) return;
    const fn = actions[btn.dataset.action];
    if (!fn) return;
    fn();
    // Drop focus so the next space/enter doesn't re-trigger the button and
    // eat a keyboard shortcut.
    btn.blur();
    syncToolbar();
    showToolbar();
  });

  toolbarEl.addEventListener('mouseenter', () => {
    toolbarHovered = true;
    clearTimeout(toolbarHideTimer);
    toolbarHideTimer = null;
    toolbarEl.classList.remove('tb-hidden');
  });
  toolbarEl.addEventListener('mouseleave', () => {
    toolbarHovered = false;
    scheduleToolbarHide();
  });

  window.addEventListener('mousemove', e => {
    if (e.clientY >= window.innerHeight - TOOLBAR_REVEAL_ZONE) showToolbar();
  }, { passive: true });

  syncToolbar();
  scheduleToolbarHide();
}

// ─── Color picker ─────────────────────────────────────────────────────────────
const colorPicker     = document.getElementById('color-picker');
const swatchContainer = colorPicker.querySelector('.cp-swatches');
const colorInput      = colorPicker.querySelector('.cp-input');
const customWrap      = colorPicker.querySelector('.cp-custom');
const sizeContainer   = colorPicker.querySelector('.cp-sizes');

function buildColorPicker() {
  COLOR_PALETTE.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cp-swatch';
    b.style.setProperty('--c', c);
    b.dataset.color = c;
    b.setAttribute('aria-label', `Color ${c}`);
    b.addEventListener('click', () => selectColor(c));
    swatchContainer.appendChild(b);
  });
  colorInput.value = strokeColor;
  colorInput.addEventListener('input', e => selectColor(e.target.value));

  LINE_WIDTH_PRESETS.forEach(w => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cp-size';
    b.dataset.size = String(w);
    b.setAttribute('aria-label', `Stroke size ${w}`);
    const dot = document.createElement('span');
    dot.className = 'cp-size-dot';
    dot.style.width = w + 'px';
    dot.style.height = w + 'px';
    b.appendChild(dot);
    b.addEventListener('click', () => selectSize(w));
    sizeContainer.appendChild(b);
  });

  // Hovering the toolbar pauses the auto-hide countdown; leaving it restarts
  // it (but only if a color was selected, i.e. auto-hide was armed).
  colorPicker.addEventListener('mouseenter', () => {
    pickerHovered = true;
    clearTimeout(pickerHideTimer);
    pickerHideTimer = null;
  });
  colorPicker.addEventListener('mouseleave', () => {
    pickerHovered = false;
    if (pickerHideArmed) scheduleColorPickerHide();
  });

  syncColorPickerSelection();
}

function syncColorPickerSelection() {
  const isPreset = COLOR_PALETTE.includes(strokeColor);
  swatchContainer.querySelectorAll('.cp-swatch').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.color === strokeColor);
  });
  customWrap.classList.toggle('selected', !isPreset);
  if (!isPreset) colorInput.value = strokeColor;

  // Size dots inherit the current stroke color so each button previews
  // exactly what that preset will draw.
  sizeContainer.querySelectorAll('.cp-size').forEach(btn => {
    btn.classList.toggle('selected', Number(btn.dataset.size) === lineWidth);
    const dot = btn.querySelector('.cp-size-dot');
    if (dot) dot.style.setProperty('--dot', strokeColor);
  });
}

function selectColor(c) {
  strokeColor = c;
  applyStyles(ctx);
  applyStyles(tctx);
  syncColorPickerSelection();
  syncToolbar();
  scheduleColorPickerHide();
}

function selectSize(w) {
  lineWidth = w;
  applyStyles(ctx);
  applyStyles(tctx);
  syncColorPickerSelection();
  scheduleColorPickerHide();
}

let pickerHideTimer = null;
let pickerHideArmed = false;
let pickerHovered = false;

function scheduleColorPickerHide() {
  pickerHideArmed = true;
  // Pause the countdown while the mouse is over the toolbar; mouseleave will
  // re-invoke this to start it.
  if (pickerHovered) return;
  clearTimeout(pickerHideTimer);
  pickerHideTimer = setTimeout(() => {
    pickerHideTimer = null;
    closeColorPicker();
  }, COLOR_PICKER_HIDE_DELAY);
}

function isColorPickerOpen() {
  return document.body.classList.contains('color-picker-open');
}

function openColorPicker() {
  pickerHideArmed = false;
  document.body.classList.add('color-picker-open');
  colorPicker.setAttribute('aria-hidden', 'false');
}

function closeColorPicker() {
  clearTimeout(pickerHideTimer);
  pickerHideTimer = null;
  pickerHideArmed = false;
  document.body.classList.remove('color-picker-open');
  colorPicker.setAttribute('aria-hidden', 'true');
}

function toggleColorPicker() {
  if (isColorPickerOpen()) closeColorPicker();
  else openColorPicker();
}

// ─── Cursor state ─────────────────────────────────────────────────────────────
function updateCursor() {
  el.classList.remove('cursor-pencil', 'cursor-eraser');
  if (!drawingEnabled) return;
  if (laserMode) return; // cursor hidden via body.laser-mode CSS; head dot stands in
  if (isErasing) {
    el.classList.add('cursor-eraser');
  } else {
    el.classList.add('cursor-pencil');
  }
}

// ─── Finalize current stroke ─────────────────────────────────────────────────
function finalizeDrawing() {
  if (!isDrawing) return;

  if (currentPoints.length > 1) {
    const refBox = getReferenceBox();
    const normalizedStroke = currentPoints.map(point => normalizePoint(point, refBox));
    getStrokes().push({ points: normalizedStroke, width: lineWidth, color: strokeColor });
  }

  currentPoints = [];
  redrawAll();
  broadcastState();
  syncToolbar();
}

// ─── Speaker notes ────────────────────────────────────────────────────────────
// Notes are read from <desc id="slide-notes"> inside each slide's SVG.
// The panel is only shown in the speaker window while a slideshow window is open.

const notesPanel   = document.getElementById('notes-panel');
const notesContent = document.getElementById('notes-content');
const notesResizer = document.getElementById('notes-resizer');

// Drag the vertical divider between canvas-wrap and notes-panel to resize notes.
// Writes --notes-width on <body>, which #notes-panel's flex-basis reads. The
// canvas ResizeObserver reflows drawings automatically as width changes.
if (notesResizer && !IS_SLIDESHOW) {
  const NOTES_MIN = 200;
  const CANVAS_MIN = 320; // reserve enough room for the canvas/toolbar
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
    const maxWidth = Math.max(NOTES_MIN, window.innerWidth - CANVAS_MIN);
    const next = Math.max(NOTES_MIN, Math.min(maxWidth, startWidth - dx));
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
  if (IS_SLIDESHOW) return;
  if (whiteboardMode) {
    notesContent.textContent = '(whiteboard mode)';
    return;
  }
  const text = slideNotes[currentSlide] || '';
  notesContent.textContent = text || '(no notes for this slide)';
}

function showNotes() {
  if (IS_SLIDESHOW) return;
  updateNotesContent();
  notesPanel.classList.add('visible');
  document.body.classList.add('speaker-mode');
  // Reflow the canvas after the panel appears so its bounding box is correct.
  setupCanvas();
}

function hideNotes() {
  if (IS_SLIDESHOW) return;
  notesPanel.classList.remove('visible');
  document.body.classList.remove('speaker-mode');
  setupCanvas();
}

// ─── Speaker mode: open / toggle the slideshow window and respond ────────────
function toggleSpeakerMode() {
  if (IS_SLIDESHOW) return;

  // Toggle: if already open, close it and hide notes.
  if (slideshowWin && !slideshowWin.closed) {
    slideshowWin.close();
    slideshowWin = null;
    frozen = false;
    syncFreezeIndicator();
    hideNotes();
    syncToolbar();
    return;
  }

  const params = new URLSearchParams({ slideshow: '1' });
  if (whiteboardMode) params.set('whiteboard', '1');
  const url = location.pathname + '?' + params.toString() + location.hash;
  slideshowWin = window.open(url, 'slideshow');
  showNotes();
  syncToolbar();
}

// Poll for the slideshow window being closed externally (e.g. the user shuts
// the window directly instead of pressing S again).
setInterval(() => {
  if (!IS_SLIDESHOW && slideshowWin && slideshowWin.closed) {
    slideshowWin = null;
    frozen = false;
    syncFreezeIndicator();
    hideNotes();
    syncToolbar();
  }
}, 500);

let slidesReady = false;
let pendingState = null;

channel.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;

  if (IS_SLIDESHOW) {
    if (msg.type === 'state') {
      if (!slidesReady) {
        pendingState = msg;
        return;
      }
      applySlideshowState(msg);
    } else if (msg.type === 'video-sync') {
      if (!slidesReady) return;
      applyVideoSync(msg);
    }
  } else {
    if (msg.type === 'request-state') {
      broadcastState();
    }
  }
});

function applySlideshowState(msg) {
  if (msg.currentSlide !== currentSlide) {
    slides[currentSlide].classList.remove('active');
    currentSlide = msg.currentSlide;
    slides[currentSlide].classList.add('active');
  }
  slidesData = msg.slidesData;
  drawingEnabled = msg.drawingEnabled;

  // Whiteboard state (older messages may not have these fields).
  const nextWhiteboardMode = !!msg.whiteboardMode;
  if (nextWhiteboardMode !== whiteboardMode) {
    whiteboardMode = nextWhiteboardMode;
    document.body.classList.toggle('whiteboard-mode', whiteboardMode);
  }
  if (Array.isArray(msg.whiteboardSlides)) whiteboardSlides = msg.whiteboardSlides;
  if (typeof msg.whiteboardCurrent === 'number') whiteboardCurrent = msg.whiteboardCurrent;
  mirroredLiveStroke = msg.liveStroke
    ? { points: msg.liveStroke, width: msg.liveStrokeWidth ?? lineWidth, color: msg.liveStrokeColor || DEFAULT_STROKE_COLOR }
    : null;
  mirroredLaserPoints = Array.isArray(msg.laserPoints) ? msg.laserPoints : [];
  if (mirroredLaserPoints.length > 0) startLaserLoop();
  redrawAll();
}

// ─── Events & Initialization ─────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  await preloadSlides();

  setupCanvas();
  setupVideoSync();

  const handleCanvasResize = () => {
    if (isDrawing) {
      finalizeDrawing();
      isDrawing = false;
    }
    isErasing = false;
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
    slidesReady = true;
    if (pendingState) {
      applySlideshowState(pendingState);
      pendingState = null;
    }
    channel.postMessage({ type: 'request-state' });
    return;
  }

  // ─── Main window input handlers ─────────────────────────────────────────────
  buildColorPicker();
  wireToolbar();
  updateCursor();
  toggleCursorMode();

  el.addEventListener('mousedown', e => {
    if (!drawingEnabled) return;
    if (laserMode) return; // laser ignores clicks — trail follows pointer directly
    if (isFrozen()) return;
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
  });

  el.addEventListener('pointermove', e => {
    cursorPos = getPos(e);
    if (!drawingEnabled) return;
    const inside = isInsideRefBox(cursorPos);
    if (laserMode) {
      // Only feed the laser trail while inside — rendering is clipped anyway,
      // but this also keeps us from broadcasting useless outside points.
      if (!isFrozen() && inside) pushLaserPoint(cursorPos);
      return;
    }
    if (isErasing) {
      if (inside) tryDeleteClosest(cursorPos);
    } else if (isDrawing) {
      // Keep appending even while the cursor is outside — the render-time
      // clip hides the outside portion, and this preserves stroke continuity
      // for arcs that briefly dip past the edge.
      currentPoints.push(cursorPos);
      appendLiveSegment(currentPoints);
      broadcastState();
    }
  });

  window.addEventListener('mouseup', () => {
    if (!drawingEnabled) return;
    if (laserMode) return;
    if (isDrawing) {
      finalizeDrawing();
      isDrawing = false;
    }
    if (isErasing) {
      isErasing = false;
      updateCursor();
    }
  });

  el.addEventListener('contextmenu', e => e.preventDefault());

  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault();
      if (isFrozen()) return;
      if (!getStrokes().length) return;
      getStrokes().pop();
      redrawAll();
      broadcastState();
      syncToolbar();
    }
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFreeze();
    }
    if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      toggleDrawing();
    }
    if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      toggleLaser();
    }
    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      toggleCursorMode();
    }
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      if (drawingEnabled && !laserMode) toggleColorPicker();
    }
    if (e.key === 'Escape') {
      if (isColorPickerOpen()) {
        e.preventDefault();
        closeColorPicker();
      }
    }
    if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      toggleSpeakerMode(); // opens or closes (toggles) the slideshow window
    }
    if (e.key === 'ArrowRight') {
      navigate(1);
    }
    if (e.key === 'ArrowLeft') {
      navigate(-1);
    }
    if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      toggleWhiteboard();
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      // drawingEnabled gates canvas pointer-events; laser rides on top of
      // that. Size controls should only act in pure drawing mode.
      if (drawingEnabled && !laserMode) changeStrokeSize(LINE_WIDTH_STEP);
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      if (drawingEnabled && !laserMode) changeStrokeSize(-LINE_WIDTH_STEP);
    }
  });
});
