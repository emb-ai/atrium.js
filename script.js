// ─── Constants ────────────────────────────────────────────────────────────────
const ERASE_THRESHOLD = 20;
const COLOR_PALETTE = ['#168afe', '#dc2626', '#16a34a', '#f59e0b', '#a855f7', '#ffffff', '#000000'];
const COLOR_PICKER_HIDE_DELAY = 700;
const DEFAULT_STROKE_COLOR = COLOR_PALETTE[0];
let strokeColor = DEFAULT_STROKE_COLOR;
const LINE_WIDTH_MIN = 1;
const LINE_WIDTH_MAX = 40;
const LINE_WIDTH_STEP = 2;
let lineWidth = 5;

// Laser pointer: short-living red trace that follows the cursor.
// Width is fixed (independent of the drawing stroke size controlled by +/-).
const LASER_STYLE = '#dc2626';
const LASER_WIDTH = 10;
const LASER_TTL = 200;
// EMA factor applied to incoming samples before they hit the trail.
// Lower = smoother but laggier; 0.5 is a good balance.
const LASER_SMOOTH_ALPHA = 0.5;

// ─── Presenter mode ───────────────────────────────────────────────────────────
const IS_PRESENTER = new URLSearchParams(location.search).has('presenter');
const channel = new BroadcastChannel('slides-presenter');
let presenterWin = null;

// Mark the presenter window so CSS can suppress the notes panel there.
if (IS_PRESENTER) document.body.classList.add('is-presenter');

function isFrozen() {
  // Freeze auto-clears if the presenter window has been closed.
  if (frozen && (!presenterWin || presenterWin.closed)) {
    frozen = false;
  }
  syncFreezeIndicator();
  return frozen;
}

function syncFreezeIndicator() {
  document.body.classList.toggle('is-frozen', frozen);
}

function broadcastState() {
  if (IS_PRESENTER) return;
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

function getStrokes() {
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

// ─── Video sync between main and presenter windows ───────────────────────────
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

// Called from presenter-applied syncs so our own mirrored .play()/.pause()
// doesn't bounce back as another broadcast.
let suppressVideoBroadcast = false;

function broadcastVideoState(slideIdx, videoIdx, videoEl) {
  if (IS_PRESENTER) return;
  if (isFrozen()) return;
  if (!presenterWin || presenterWin.closed) return;
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
    if (IS_PRESENTER) {
      // Presenter videos should be muted — the lecturer's physical voice carries.
      // (Still synced to the main video's own muted state when messages arrive,
      // but default to muted so autoplay policies allow scripted .play().)
      v.muted = true;

      // Video state is driven entirely by the main window via video-sync
      // messages. Hide the native controls so the presenter audience can't
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
    // Keep presenter muted regardless of main window's mute state,
    // so the presenter doesn't double audio from the lecturer's machine.
    v.muted = true;

    if (msg.paused && !v.paused) {
      v.pause();
    } else if (!msg.paused && v.paused) {
      // .play() returns a promise that may reject under autoplay policy.
      const p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch(err => console.warn('Presenter video play() rejected:', err));
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
let mirroredLiveStroke = null; // presenter-only: normalized live stroke from main window
let laserMode = false;
let laserPoints = []; // [{x, y, t}] — normalized coords with Date.now() timestamps
let mirroredLaserPoints = []; // presenter-only: mirrored from main window
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

  tctx.beginPath();
  tctx.moveTo(prevMid.x, prevMid.y);
  tctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
  tctx.stroke();
}

const progressIndicator = document.getElementById('progress-indicator');
const progressCurrent = progressIndicator.querySelector('.progress-current');
const progressTotal = progressIndicator.querySelector('.progress-total');

function updateProgressIndicator() {
  if (IS_PRESENTER) return;
  progressCurrent.textContent = String(currentSlide + 1);
  progressTotal.textContent = String(slides.length);

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

  getStrokes().forEach(stroke => {
    ctx.lineWidth = stroke.width;
    ctx.strokeStyle = stroke.color || DEFAULT_STROKE_COLOR;
    drawStroke(ctx, toScreenPoints(stroke.points));
  });
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeColor;

  if (mirroredLiveStroke && mirroredLiveStroke.points.length > 1) {
    ctx.lineWidth = mirroredLiveStroke.width;
    ctx.strokeStyle = mirroredLiveStroke.color || DEFAULT_STROKE_COLOR;
    drawStroke(ctx, toScreenPoints(mirroredLiveStroke.points));
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = strokeColor;
  }

  updateProgressIndicator();
}

// ─── Laser pointer ────────────────────────────────────────────────────────────
// Laser mode reuses the `tmp` canvas as an overlay (it's otherwise only used
// for live stroke segments, and the two modes are mutually exclusive).
// Each point carries a Date.now() timestamp so the main and presenter windows
// can fade the trail independently without needing tick-synchronized messages.
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

  const points = IS_PRESENTER ? mirroredLaserPoints : laserPoints;
  pruneLaser(points);

  const refBox = getReferenceBox();
  drawLaserTrail(tctx, points, refBox, LASER_WIDTH);

  // Head sits at the smoothed trail tip (not the raw cursor) so the dot and
  // the ribbon stay glued together — otherwise EMA smoothing leaves a gap
  // between them during fast motion.
  if (points.length > 0) {
    drawLaserHead(tctx, denormalizePoint(points[points.length - 1], refBox), LASER_WIDTH);
  }
}

function laserLoopActive() {
  if (IS_PRESENTER) return mirroredLaserPoints.length > 0;
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

function toggleLaser() {
  laserMode = !laserMode;
  document.body.classList.toggle('laser-mode', laserMode);
  if (laserMode) closeColorPicker();
  // Laser needs the canvas to capture pointer events, so it can only run
  // while drawingEnabled is true (that flag controls pointer-events on the
  // canvas). If the user enabled laser while drawingEnabled was false
  // (slide-interaction mode), force it back on.
  if (laserMode && !drawingEnabled) {
    setDrawingEnabled(true);
  }
  updateCursor();
  if (laserMode) {
    startLaserLoop();
  }
  // On toggle-off we keep the existing points so they fade out naturally;
  // the RAF loop stops itself once everything expires.
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
}

function toggleDrawing() {
  // Mutually exclusive with laser mode.
  if (!drawingEnabled && laserMode) {
    laserMode = false;
    document.body.classList.remove('laser-mode');
  }
  setDrawingEnabled(!drawingEnabled);
}

function toggleFreeze() {
  // Freeze only applies when a presenter window is open.
  if (!presenterWin || presenterWin.closed) {
    if (frozen) {
      frozen = false;
    }
    return;
  }
  frozen = !frozen;
  syncFreezeIndicator();
  if (!frozen) {
    // On unfreeze, immediately sync presenter to current state.
    broadcastState();
  }
}

// ─── Color picker ─────────────────────────────────────────────────────────────
const colorPicker     = document.getElementById('color-picker');
const swatchContainer = colorPicker.querySelector('.cp-swatches');
const colorInput      = colorPicker.querySelector('.cp-input');
const customWrap      = colorPicker.querySelector('.cp-custom');

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
}

function selectColor(c) {
  strokeColor = c;
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
}

// ─── Speaker notes ────────────────────────────────────────────────────────────
// Notes are read from <desc id="slide-notes"> inside each slide's SVG.
// The panel is only shown in the main window while a presenter window is open.

const notesPanel   = document.getElementById('notes-panel');
const notesContent = document.getElementById('notes-content');

function updateNotesContent() {
  if (IS_PRESENTER) return;
  const text = slideNotes[currentSlide] || '';
  notesContent.textContent = text || '(no notes for this slide)';
}

function showNotes() {
  if (IS_PRESENTER) return;
  updateNotesContent();
  notesPanel.classList.add('visible');
  document.body.classList.add('presenter-open');
  // Reflow the canvas after the panel appears so its bounding box is correct.
  setupCanvas();
}

function hideNotes() {
  if (IS_PRESENTER) return;
  notesPanel.classList.remove('visible');
  document.body.classList.remove('presenter-open');
  setupCanvas();
}

// ─── Presenter window: open / toggle and respond ──────────────────────────────
function openPresenter() {
  if (IS_PRESENTER) return;

  // Toggle: if already open, close it and hide notes.
  if (presenterWin && !presenterWin.closed) {
    presenterWin.close();
    presenterWin = null;
    frozen = false;
    syncFreezeIndicator();
    hideNotes();
    return;
  }

  const url = location.pathname + '?presenter=1' + location.hash;
  presenterWin = window.open(url, 'presenter');
  showNotes();
}

// Poll for the presenter window being closed externally (e.g. the user shuts
// the window directly instead of pressing P again).
setInterval(() => {
  if (!IS_PRESENTER && presenterWin && presenterWin.closed) {
    presenterWin = null;
    frozen = false;
    syncFreezeIndicator();
    hideNotes();
  }
}, 500);

let slidesReady = false;
let pendingState = null;

channel.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;

  if (IS_PRESENTER) {
    if (msg.type === 'state') {
      if (!slidesReady) {
        pendingState = msg;
        return;
      }
      applyPresenterState(msg);
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

function applyPresenterState(msg) {
  if (msg.currentSlide !== currentSlide) {
    slides[currentSlide].classList.remove('active');
    currentSlide = msg.currentSlide;
    slides[currentSlide].classList.add('active');
  }
  slidesData = msg.slidesData;
  drawingEnabled = msg.drawingEnabled;
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

  window.addEventListener('resize', () => {
    if (isDrawing) {
      finalizeDrawing();
      isDrawing = false;
    }
    isErasing = false;
    setupCanvas();
  });

  if (IS_PRESENTER) {
    // Presenter window: no input, no notes panel, just mirror state.
    el.style.pointerEvents = 'none';
    tmp.style.pointerEvents = 'none';
    el.style.cursor = 'default';
    slidesReady = true;
    if (pendingState) {
      applyPresenterState(pendingState);
      pendingState = null;
    }
    channel.postMessage({ type: 'request-state' });
    return;
  }

  // ─── Main window input handlers ─────────────────────────────────────────────
  buildColorPicker();
  updateCursor();

  el.addEventListener('mousedown', e => {
    if (!drawingEnabled) return;
    if (laserMode) return; // laser ignores clicks — trail follows pointer directly
    if (isFrozen()) return;
    if (e.button === 2) {
      isErasing = true;
      updateCursor();
      tryDeleteClosest(getPos(e));
    } else if (e.button === 0) {
      isDrawing = true;
      currentPoints = [getPos(e)];
    }
    closeColorPicker();
  });

  el.addEventListener('pointermove', e => {
    cursorPos = getPos(e);
    if (!drawingEnabled) return;
    if (laserMode) {
      if (!isFrozen()) pushLaserPoint(cursorPos);
      return;
    }
    if (isErasing) {
      tryDeleteClosest(getPos(e));
    } else if (isDrawing) {
      currentPoints.push(getPos(e));
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
    }
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFreeze();
    }
    if (e.key === 'v' || e.key === 'V') {
      e.preventDefault();
      toggleDrawing();
    }
    if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      toggleLaser();
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
    if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      openPresenter(); // opens or closes (toggles) the presenter window
    }
    if (e.key === 'ArrowRight') {
      showSlide(currentSlide + 1);
    }
    if (e.key === 'ArrowLeft') {
      showSlide(currentSlide - 1);
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
