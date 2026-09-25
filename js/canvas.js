// Owns the drawing surfaces, bottom to top:
//  • `el`  — the transparent canvas in index.html (pointer target), holding
//    committed strokes.
//  • `tmp` — an in-memory sibling used for live-stroke preview during
//    drawing, and reused as the laser-pointer overlay (the two modes
//    are mutually exclusive).
//  • `overlay` — slideshow-only use: the speaker's mirrored in-progress
//    stroke and pointer. They change every frame while the speaker draws or
//    points; keeping them off `el` means those frames don't repaint all the
//    committed ink underneath.
//
// All stroke math happens in CSS pixels; the HiDPI scaling is hidden
// inside setupCanvas via ctx.scale(dpr, dpr).

export const el  = document.getElementById('c');
export const ctx = el.getContext('2d');

export const tmp  = Object.assign(document.createElement('canvas'), { id: 'tmp' });
export const tctx = tmp.getContext('2d');
el.insertAdjacentElement('afterend', tmp);

export const overlay = Object.assign(document.createElement('canvas'), { id: 'overlay' });
export const octx    = overlay.getContext('2d');
tmp.insertAdjacentElement('afterend', overlay);

export function getCanvasCssSize() {
  const rect = el.getBoundingClientRect();
  return {
    width: el.clientWidth || rect.width,
    height: el.clientHeight || rect.height,
  };
}

export function getPos(e) {
  const rect = el.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// Apply pen styles (width, round joins/caps, color) to a 2D context.
// Kept as a helper so drawing code doesn't forget a field.
export function applyPenStyles(context, lineWidth, color) {
  context.lineWidth   = lineWidth;
  context.lineJoin    = 'round';
  context.lineCap     = 'round';
  context.strokeStyle = color;
}

// Clip subsequent drawing on `context` to the given rect. Callers must
// pair this with context.save() / context.restore() so the clip doesn't
// leak into unrelated draws.
export function clipToRect(context, rect) {
  context.beginPath();
  context.rect(rect.x, rect.y, rect.width, rect.height);
  context.clip();
}

// Resize all canvases to (cssWidth × dpr) and apply the matching transform
// so drawing code can work in CSS pixels. `setTransform` wipes the context's
// pen styles — the caller must redraw (which reapplies styles) afterwards.
export function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = getCanvasCssSize();

  for (const canvas of [el, tmp, overlay]) {
    canvas.width  = Math.round(width  * dpr);
    canvas.height = Math.round(height * dpr);
  }

  for (const context of [ctx, tctx, octx]) {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.scale(dpr, dpr);
  }
}
