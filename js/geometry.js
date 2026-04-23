// Pure coordinate math for mapping between canvas CSS pixels and the
// viewBox-relative [0,1] space used for normalized stroke storage.
//
// Kept free of DOM lookups and global state: every function takes its inputs
// explicitly so callers can compose them however they need. The non-pure
// "current SVG / current canvas" wiring lives in main.js.

export function parsePreserveAspectRatio(svg) {
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

// Compute the on-screen rectangle the SVG's viewBox occupies inside a
// canvas of `canvasSize`, replicating SVG's preserveAspectRatio math
// (meet/slice, xMid/xMax/YMid/YMax). When `svg` is null or degenerate,
// returns an aspect-ratio letterbox if `fallbackAspect` is given,
// otherwise the full canvas.
export function computeReferenceBox(svg, canvasSize, fallbackAspect = null) {
  const fallback = () => fallbackAspect
    ? letterbox(fallbackAspect, canvasSize)
    : { x: 0, y: 0, width: canvasSize.width, height: canvasSize.height };

  if (!svg) return fallback();

  const viewBox = svg.viewBox?.baseVal;
  const vbWidth = viewBox?.width || parseFloat(svg.getAttribute('width')) || canvasSize.width;
  const vbHeight = viewBox?.height || parseFloat(svg.getAttribute('height')) || canvasSize.height;

  if (!vbWidth || !vbHeight) return fallback();

  const { align, mode } = parsePreserveAspectRatio(svg);
  if (align === 'none') return fallback();

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

function letterbox(aspect, { width, height }) {
  const scale = Math.min(width / aspect, height);
  const w = aspect * scale;
  const h = scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

export function normalizePoint(point, refBox) {
  return {
    x: refBox.width > 0 ? (point.x - refBox.x) / refBox.width : 0,
    y: refBox.height > 0 ? (point.y - refBox.y) / refBox.height : 0,
  };
}

export function denormalizePoint(point, refBox) {
  return {
    x: refBox.x + point.x * refBox.width,
    y: refBox.y + point.y * refBox.height,
  };
}
