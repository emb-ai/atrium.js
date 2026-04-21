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
// falls back to the full canvas.
export function computeReferenceBox(svg, canvasSize) {
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
