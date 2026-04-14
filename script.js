// Persistent canvas — committed strokes live here
var el = document.getElementById('c');
var ctx = el.getContext('2d');

// Temporary canvas — only the current in-progress stroke
var tmp = document.createElement('canvas');
var tctx = tmp.getContext('2d');
el.parentNode.appendChild(tmp);

var isDrawing = false;
var points = [];
var rafPending = false;

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

function drawStroke(context, pts) {
  if (pts.length < 2) return;
  context.beginPath();
  context.moveTo(pts[0].x, pts[0].y);
  for (var i = 1; i < pts.length - 1; i++) {
    var midX = (pts[i].x + pts[i + 1].x) / 2;
    var midY = (pts[i].y + pts[i + 1].y) / 2;
    context.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
  }
  var last = pts[pts.length - 1];
  context.lineTo(last.x, last.y);
  context.stroke();
}

function render() {
  rafPending = false;
  var dpr = window.devicePixelRatio || 1;
  tctx.clearRect(0, 0, tmp.width / dpr, tmp.height / dpr);
  drawStroke(tctx, points);
}

el.onmousedown = function(e) {
  isDrawing = true;
  points = [getPos(e)];
};

// Use pointermove for lower-latency input on supported browsers
el.addEventListener('pointermove', function(e) {
  if (!isDrawing) return;
  points.push(getPos(e));

  // Batch redraws to animation frames — avoids redundant redraws
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(render);
  }
});

el.onmouseup = function() {
  if (!isDrawing) return;
  isDrawing = false;

  // Commit the current stroke to the persistent canvas
  drawStroke(ctx, points);

  // Clear the temp canvas
  var dpr = window.devicePixelRatio || 1;
  tctx.clearRect(0, 0, tmp.width / dpr, tmp.height / dpr);
  points = [];
};
