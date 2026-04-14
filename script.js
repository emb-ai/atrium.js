var el = document.getElementById('c');
var ctx = el.getContext('2d');

ctx.lineJoin = ctx.lineCap = 'round';

var isDrawing, points = [];

// Scale canvas for device pixel ratio to prevent blurriness
function setupCanvas() {
  var dpr = window.devicePixelRatio || 1;
  var rect = el.getBoundingClientRect();

  el.width = rect.width * dpr;
  el.height = rect.height * dpr;

  ctx.scale(dpr, dpr);
  ctx.lineWidth = 6;
  ctx.lineJoin = ctx.lineCap = 'round';
}

setupCanvas();
window.addEventListener('resize', setupCanvas);

// Get mouse position relative to canvas
function getPos(e) {
  var rect = el.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
}

el.onmousedown = function(e) {
  isDrawing = true;
  points.push(getPos(e));
};

el.onmousemove = function(e) {
  if (!isDrawing) return;

  var dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, el.width / dpr, el.height / dpr);
  points.push(getPos(e));

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (var i = 1; i < points.length - 1; i++) {
    var midX = (points[i].x + points[i + 1].x) / 2;
    var midY = (points[i].y + points[i + 1].y) / 2;
    // Draw a quadratic curve using points[i] as the control point
    // and the midpoint to points[i+1] as the end point
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }

  // Connect to the last point
  var last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);

  ctx.stroke();
};

el.onmouseup = function() {
  isDrawing = false;
  points.length = 0;
};
