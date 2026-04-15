// ─── Constants ────────────────────────────────────────────────────────────────

const ERASE_THRESHOLD = 20; // px — max distance for right-click stroke deletion
const STROKE_STYLE = '#faff00';
const LINE_WIDTH = 5;

// ─── Canvas setup ─────────────────────────────────────────────────────────────

const el  = document.getElementById('c');
const ctx = el.getContext('2d');

const tmp  = Object.assign(document.createElement('canvas'), { id: 'tmp' });
const tctx = tmp.getContext('2d');
el.insertAdjacentElement('afterend', tmp);

// ─── State ────────────────────────────────────────────────────────────────────

let isDrawing = false;
let isErasing = false;
let currentPoints = [];
let strokes = [];

// ─── Canvas helpers ───────────────────────────────────────────────────────────

function applyStyles(context) {
  context.lineWidth   = LINE_WIDTH;
  context.lineJoin    = 'round';
  context.lineCap     = 'round';
  context.strokeStyle = STROKE_STYLE;
}

function setupCanvas() {
  const dpr  = window.devicePixelRatio || 1;
  const { width, height } = el.getBoundingClientRect();

  for (const canvas of [el, tmp]) {
    canvas.width  = width  * dpr;
    canvas.height = height * dpr;
  }

  for (const context of [ctx, tctx]) {
    context.scale(dpr, dpr);
    applyStyles(context);
  }

  redrawAll();
}

function getPos(e) {
  const { left, top } = el.getBoundingClientRect();
  return { x: e.clientX - left, y: e.clientY - top };
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
      const prev    = pts[i - 1];
      const prevMid = { x: (pts[i - 2].x + prev.x) / 2, y: (pts[i - 2].y + prev.y) / 2 };
      const mid     = { x: (prev.x + pts[i].x) / 2,     y: (prev.y + pts[i].y) / 2     };
      context.moveTo(prevMid.x, prevMid.y);
      context.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
    }
  }

  context.stroke();
}

// Appends only the newest segment to the live canvas — no full redraw needed
function appendLiveSegment(pts) {
  const len = pts.length;
  if (len < 3) return;

  const prev    = pts[len - 2];
  const prevMid = { x: (pts[len - 3].x + prev.x) / 2, y: (pts[len - 3].y + prev.y) / 2 };
  const mid     = { x: (prev.x + pts[len - 1].x) / 2, y: (prev.y + pts[len - 1].y) / 2 };

  tctx.beginPath();
  tctx.moveTo(prevMid.x, prevMid.y);
  tctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
  tctx.stroke();
}

function redrawAll() {
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, el.width / dpr, el.height / dpr);
  applyStyles(ctx);
  strokes.forEach(pts => drawStroke(ctx, pts));
  updateBadge();
}

// ─── Badge ────────────────────────────────────────────────────────────────────

const badge = document.getElementById('stroke-count');

function updateBadge() {
  if (!badge) return;
  const n = strokes.length;
  badge.textContent = n === 0 ? 'No strokes' : `${n} stroke${n === 1 ? '' : 's'}`;
  badge.classList.toggle('has-strokes', n > 0);
}

function flashBadge() {
  badge?.classList.add('flash');
  setTimeout(() => badge?.classList.remove('flash'), 300);
}

// ─── Erasing ──────────────────────────────────────────────────────────────────

function tryDeleteClosest(pos) {
  if (!strokes.length) return;

  let closestIdx  = -1;
  let closestDist = Infinity;

  strokes.forEach((pts, i) => {
    for (const p of pts) {
      const d = (p.x - pos.x) ** 2 + (p.y - pos.y) ** 2;
      if (d < closestDist) { closestDist = d; closestIdx = i; }
    }
  });

  if (closestIdx !== -1 && Math.sqrt(closestDist) <= ERASE_THRESHOLD) {
    strokes.splice(closestIdx, 1);
    redrawAll();
    flashBadge();
  }
}

// ─── Fullscreen toggle (F5) ──────────────────────────────────────────────────

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

setupCanvas();
window.addEventListener('resize', setupCanvas);

el.addEventListener('mousedown', e => {
  if (e.button === 2) {
    isErasing = true;
    tryDeleteClosest(getPos(e));
  } else if (e.button === 0) {
    isDrawing = true;
    currentPoints = [getPos(e)];
  }
});

el.addEventListener('pointermove', e => {
  if (isErasing) {
    tryDeleteClosest(getPos(e));
  } else if (isDrawing) {
    currentPoints.push(getPos(e));
    appendLiveSegment(currentPoints);
  }
});

el.addEventListener('mouseup', e => {
  if (e.button === 2) {
    isErasing = false;
  } else if (e.button === 0 && isDrawing) {
    isDrawing = false;

    if (currentPoints.length > 1) strokes.push([...currentPoints]);

    const dpr = window.devicePixelRatio || 1;
    ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, el.width / dpr, el.height / dpr);
    tctx.clearRect(0, 0, tmp.width / dpr, tmp.height / dpr);
    currentPoints = [];
    updateBadge();
  }
});

el.addEventListener('contextmenu', e => e.preventDefault());

document.addEventListener('keydown', e => {
  // Ctrl+Z for undo
  if (e.ctrlKey && e.key === 'z') {
    e.preventDefault();
    if (!strokes.length) return;
    strokes.pop();
    redrawAll();
    flashBadge();
  }

  // F5 for fullscreen toggle
  if (e.key === 'F5') {
    e.preventDefault();
    toggleFullscreen();
  }
});