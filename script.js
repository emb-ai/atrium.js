var el = document.getElementById('c');
var ctx = el.getContext('2d');

var tmp = document.createElement('canvas');
var tctx = tmp.getContext('2d');
tmp.id = 'tmp';
el.insertAdjacentElement('afterend', tmp);

var isDrawing = false;
var points = [];
var strokes = []; // sequential history of completed strokes

function setupCanvas() {
  var dpr = window.devicePixelRatio || 1;
  var rect = el.getBoundingClientRect();
  var w = rect.width, h = rect.height;

  [el, tmp].forEach(function(canvas) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  });

  ctx.scale(dpr, dpr);
  tctx.scale(dpr, dpr);

  applyStyles(ctx);
  applyStyles(tctx);

  redrawAll();
}

function applyStyles(c) {
  c.lineWidth = 5;
  c.lineJoin = c.lineCap = 'round';
  c.strokeStyle = '#000';
}

setupCanvas();
window.addEventListener('resize', setupCanvas);

function getPos(e) {
  var rect = el.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// Draw a full stroke (array of points) onto a given context from scratch
function drawStroke(context, pts) {
  if (pts.length < 2) return;
  context.beginPath();
  if (pts.length === 2) {
    context.moveTo(pts[0].x, pts[0].y);
    context.lineTo(pts[1].x, pts[1].y);
    context.stroke();
    return;
  }
  for (var i = 2; i < pts.length; i++) {
    var prev = pts[i - 1];
    var curr = pts[i];
    var prevMidX = (pts[i - 2].x + prev.x) / 2;
    var prevMidY = (pts[i - 2].y + prev.y) / 2;
    var midX = (prev.x + curr.x) / 2;
    var midY = (prev.y + curr.y) / 2;
    context.moveTo(prevMidX, prevMidY);
    context.quadraticCurveTo(prev.x, prev.y, midX, midY);
  }
  context.stroke();
}

// Redraw the persistent canvas from the strokes history
function redrawAll() {
  var dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, el.width / dpr, el.height / dpr);
  applyStyles(ctx);
  strokes.forEach(function(pts) {
    drawStroke(ctx, pts);
  });
  updateStrokeCount();
}

// Draw only the latest segment onto the temp canvas (live preview)
function appendSegment(context, pts) {
  var len = pts.length;
  if (len < 3) return;
  var prev = pts[len - 2];
  var curr = pts[len - 1];
  var prevMidX = (pts[len - 3].x + prev.x) / 2;
  var prevMidY = (pts[len - 3].y + prev.y) / 2;
  var midX = (prev.x + curr.x) / 2;
  var midY = (prev.y + curr.y) / 2;
  context.beginPath();
  context.moveTo(prevMidX, prevMidY);
  context.quadraticCurveTo(prev.x, prev.y, midX, midY);
  context.stroke();
}

function updateStrokeCount() {
  var badge = document.getElementById('stroke-count');
  if (!badge) return;
  var n = strokes.length;
  badge.textContent = n === 0 ? 'No strokes' : n + ' stroke' + (n === 1 ? '' : 's');
  badge.classList.toggle('has-strokes', n > 0);
}

// --- Pointer events ---

el.onmousedown = function(e) {
  if (e.button !== 0) return; // only left button starts drawing
  isDrawing = true;
  points = [getPos(e)];
};

el.addEventListener('pointermove', function(e) {
  if (!isDrawing) return;
  points.push(getPos(e));
  appendSegment(tctx, points);
});

el.onmouseup = function(e) {
  if (!isDrawing) return;
  isDrawing = false;

  // Save the completed stroke
  if (points.length > 1) {
    strokes.push(points.slice());
  }

  // Commit temp canvas pixels onto the persistent canvas
  var dpr = window.devicePixelRatio || 1;
  ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, el.width / dpr, el.height / dpr);

  // Clear temp canvas
  tctx.clearRect(0, 0, tmp.width / dpr, tmp.height / dpr);
  points = [];

  updateStrokeCount();
};

// --- Ctrl+Z: delete last stroke ---

document.addEventListener('keydown', function(e) {
  if (e.ctrlKey && e.key === 'z') {
    e.preventDefault();
    if (strokes.length === 0) return;
    strokes.pop();
    redrawAll();

    // Flash feedback
    var badge = document.getElementById('stroke-count');
    if (badge) {
      badge.classList.add('flash');
      setTimeout(function() { badge.classList.remove('flash'); }, 300);
    }
  }
});
