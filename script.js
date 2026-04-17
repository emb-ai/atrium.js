// ─── Constants ────────────────────────────────────────────────────────────────
const ERASE_THRESHOLD = 20;
const STROKE_STYLE = '#168afe';
const LINE_WIDTH = 5;

// ─── Presenter mode ───────────────────────────────────────────────────────────
const IS_PRESENTER = new URLSearchParams(location.search).has('presenter');
const channel = new BroadcastChannel('slides-presenter');
let presenterWin = null;

function broadcastState() {
  if (IS_PRESENTER) return;
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

function getStrokes() {
  return slidesData[currentSlide];
}

function showSlide(idx) {
  if (idx < 0 || idx >= slides.length) return;
  slides[currentSlide].classList.remove('active');
  currentSlide = idx;
  slides[currentSlide].classList.add('active');
  redrawAll();
  broadcastState();
}

// ─── Preload SVGs into slide divs ─────────────────────────────────────────────
async function preloadSlides() {
  const slideElements = [...slides];
  const promises = slideElements.map(async (slide, index) => {
    const src = slide.dataset.src;
    if (!src) return;
    try {
      const response = await fetch(src);
      const svgText = await response.text();
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(svgText, 'image/svg+xml');
      const svgRoot = svgDoc.documentElement;
      slide.innerHTML = '';
      slide.appendChild(svgRoot);
    } catch (err) {
      console.error(`Failed to load slide ${index + 1}:`, err);
      slide.textContent = `⚠️ Failed to load ${src}`;
    }
  });
  await Promise.all(promises);
  slides[0].classList.add('active');
  setupCanvas();
}

// ─── State ────────────────────────────────────────────────────────────────────
let isDrawing = false;
let isErasing = false;
let currentPoints = []; // live stroke in canvas-local CSS pixels
let drawingEnabled = true;
let mirroredLiveStroke = null; // presenter-only: normalized live stroke from main window

// ─── Canvas helpers ───────────────────────────────────────────────────────────
function applyStyles(context) {
  context.lineWidth   = LINE_WIDTH;
  context.lineJoin    = 'round';
  context.lineCap     = 'round';
  context.strokeStyle = STROKE_STYLE;
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

function redrawAll() {
  const { width, height } = getCanvasCssSize();
  ctx.clearRect(0, 0, width, height);
  tctx.clearRect(0, 0, width, height);
  applyStyles(ctx);
  applyStyles(tctx);

  getStrokes().forEach(points => drawStroke(ctx, toScreenPoints(points)));

  if (mirroredLiveStroke && mirroredLiveStroke.length > 1) {
    drawStroke(ctx, toScreenPoints(mirroredLiveStroke));
  }
}

// ─── Erasing ──────────────────────────────────────────────────────────────────
function tryDeleteClosest(pos) {
  const strokes = getStrokes();
  if (!strokes.length) return;

  let closestIdx = -1;
  let closestDist = Infinity;

  strokes.forEach((points, i) => {
    const screenPoints = toScreenPoints(points);
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
function toggleDrawing() {
  drawingEnabled = !drawingEnabled;

  document.body.classList.toggle('drawing-enabled', drawingEnabled);
  document.body.classList.toggle('drawing-disabled', !drawingEnabled);

  el.classList.toggle('drawing-disabled', !drawingEnabled);
  tmp.classList.toggle('drawing-disabled', !drawingEnabled);

  updateCursor();
  broadcastState();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

// ─── Cursor state ─────────────────────────────────────────────────────────────
function updateCursor() {
  el.classList.remove('cursor-pencil', 'cursor-eraser');
  if (!drawingEnabled) return;
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
    getStrokes().push(normalizedStroke);
  }

  currentPoints = [];
  redrawAll();
  broadcastState();
}

// ─── Presenter window: open and respond ──────────────────────────────────────
function openPresenter() {
  if (IS_PRESENTER) return;
  if (presenterWin && !presenterWin.closed) {
    presenterWin.focus();
    return;
  }
  const url = location.pathname + '?presenter=1' + location.hash;
  presenterWin = window.open(url, 'presenter', 'width=960,height=600');
}

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
  mirroredLiveStroke = msg.liveStroke || null;
  redrawAll();
}

// ─── Events & Initialization ─────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  await preloadSlides();

  setupCanvas();

  window.addEventListener('resize', () => {
    if (isDrawing) {
      finalizeDrawing();
      isDrawing = false;
    }
    isErasing = false;
    setupCanvas();
  });

  if (IS_PRESENTER) {
    // Presenter mode: no input, request initial state and listen for updates.
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
  updateCursor();

  el.addEventListener('mousedown', e => {
    if (!drawingEnabled) return;
    if (e.button === 2) {
      isErasing = true;
      updateCursor();
      tryDeleteClosest(getPos(e));
    } else if (e.button === 0) {
      isDrawing = true;
      currentPoints = [getPos(e)];
    }
  });

  el.addEventListener('pointermove', e => {
    if (!drawingEnabled) return;
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
      if (!getStrokes().length) return;
      getStrokes().pop();
      redrawAll();
      broadcastState();
    }
    if (e.key === 'f') {
      e.preventDefault();
      toggleFullscreen();
    }
    if (e.key === 'v' || e.key === 'V') {
      e.preventDefault();
      toggleDrawing();
    }
    if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      openPresenter();
    }
    if (e.key === 'ArrowRight') {
      showSlide(currentSlide + 1);
    }
    if (e.key === 'ArrowLeft') {
      showSlide(currentSlide - 1);
    }
  });
});
