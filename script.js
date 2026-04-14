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
  for (var i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
};

el.onmouseup = function() {
  isDrawing = false;
  points.length = 0;
};
