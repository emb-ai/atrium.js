var el = document.getElementById('c');
var ctx = el.getContext('2d');

var tmp = document.createElement('canvas');
var tctx = tmp.getContext('2d');
el.parentNode.appendChild(tmp);

var isDrawing = false;
var points = [];

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

// Draw only the latest segment onto the given context (no clear)
function appendSegment(context, pts) {
  var len = pts.length;
  if (len < 3) return;

  // Connect previous midpoint → new midpoint via the second-to-last point
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

el.onmousedown = function(e) {
  isDrawing = true;
  points = [getPos(e)];
};

el.addEventListener('pointermove', function(e) {
  if (!isDrawing) return;
  points.push(getPos(e));
  // Draw the new segment immediately — no RAF, no clear
  appendSegment(tctx, points);
});

el.onmouseup = function() {
  if (!isDrawing) return;
  isDrawing = false;

  // Commit temp canvas pixels onto the persistent canvas
  var dpr = window.devicePixelRatio || 1;
  ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, el.width / dpr, el.height / dpr);

  // Clear temp canvas
  tctx.clearRect(0, 0, tmp.width / dpr, tmp.height / dpr);
  points = [];
};
