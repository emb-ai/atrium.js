// Mirrored pointer: paints the speaker's pointer onto the slideshow window.
//
// The audience otherwise has no idea where the speaker is pointing — the
// tools that do mirror (strokes, laser trail) only show up once the speaker
// commits to drawing or has moved in the last fraction of a second. This
// module samples the pointer position on the speaker side and paints the
// glyph matching the active tool at the same spot on the slideshow side.
//
// Only the tool modes are mirrored. Cursor mode is the neutral resting
// state — the speaker uses it to click links and videos, not to point — so
// an arrow on the audience's screen would be noise.
//
// The sample is taken window-wide rather than on the canvas so button and
// mode changes are visible even when `#c` is pointer-events:none.
//
// Position travels normalized to the refBox, like strokes and laser points,
// so it lands on the same spot regardless of window size. Positions outside
// the refBox are reported as null — the audience shouldn't see a pointer
// drifting over the toolbar or the notes panel.

import { isDrawMode, isLaserMode } from '../state.js';
import { getPos } from '../canvas.js';
import { normalizePoint, denormalizePoint } from '../geometry.js';
import { isErasingNow } from './input.js';
import { LASER_STYLE, LASER_WIDTH, clearLaserHead } from './laser.js';

// Per-glyph artwork, hotspot and scale.
//
// `hotspotX/Y` are fractions of the image box: the point of the artwork that
// sits on the pointer, mirroring the CSS `cursor: url(...) x y` hotspots so
// the mirror lines up with what the speaker sees.
//
// `scale` converts the target on-screen glyph height into an image box size.
// The 32×32 tool icons fill only about half their box vertically, so
// without this the glyph would come out far smaller than asked for.
const GLYPHS = {
  pencil: { src: './assets/pencil.svg', hotspotX: 8 / 32, hotspotY: 21 / 32, scale: 1.95 },
  eraser: { src: './assets/eraser.svg', hotspotX: 9 / 32, hotspotY: 22 / 32, scale: 1.80 },
};
// Laser mode hides the native cursor and lets the red head dot stand in for
// it, so the mirror draws that dot instead of an image.
const GLYPH_LASER = 'laser';

// Target glyph height as a fraction of refBox height, clamped to sane CSS
// pixels. Tied to the slide box rather than fixed so the pointer stays
// legible when the slideshow runs on a projector far larger than the
// speaker's screen.
const SIZE_RATIO = 0.045;
const MIN_SIZE = 18;
const MAX_SIZE = 64;

// Speaker-side: last in-slide pointer position, normalized. null when the
// pointer is outside the slide area or off-window.
let localPoint = null;
// Slideshow-side: the position + glyph received from the speaker.
let mirroredPoint = null;
const images = new Map(); // glyph name -> { img, ready }
let cfg = null;

export function initMirroredCursor(config) {
  cfg = config;

  if (cfg.isSlideshow) {
    // Preload every glyph: the speaker can switch tools at any moment and a
    // cold fetch would drop the pointer for a frame or two.
    Object.keys(GLYPHS).forEach(loadGlyph);
    return;
  }

  window.addEventListener('pointermove', onPointerMove);
  // The draw glyph flips between pencil and eraser on button state alone,
  // with no pointer movement. Nothing else broadcasts then either — a
  // right-click that deletes no stroke emits no 'strokes' event — so the
  // eraser would stay frozen on the slideshow until the next move.
  window.addEventListener('pointerdown', scheduleBroadcast);
  window.addEventListener('pointerup', scheduleBroadcast);
  window.addEventListener('pointercancel', scheduleBroadcast);
  // relatedTarget is null exactly when the pointer leaves the window.
  window.addEventListener('pointerout', e => { if (!e.relatedTarget) clearLocalPoint(); });
  window.addEventListener('blur', clearLocalPoint);
  // No 'mode' subscription: the pointer position is mode-independent, and
  // the glyph is resolved at read time, so a tool switch mirrors the new
  // glyph at the unchanged position without waiting for a move.
}

// Normalized point + glyph to mirror, or null when there's nothing to show.
// Read by the speaker link on every outbound state broadcast.
export function getLocalCursorPoint() {
  if (!localPoint) return null;
  const glyph = currentGlyph();
  return glyph ? { ...localPoint, glyph } : null;
}

export function setMirroredCursor(point) {
  mirroredPoint = Number.isFinite(point?.x) && Number.isFinite(point?.y)
    ? { x: point.x, y: point.y, glyph: point.glyph }
    : null;
}

// Paint the mirrored pointer. Deliberately unclipped: glyphs extend away
// from their hotspot, so a pointer near the slide edge would otherwise get
// sliced off against the letterbox.
export function drawMirroredCursor(context, refBox) {
  if (!mirroredPoint) return;
  const { x, y } = denormalizePoint(mirroredPoint, refBox);

  if (mirroredPoint.glyph === GLYPH_LASER) {
    // Persists after the trail has aged out, which is the point: a laser
    // held steady on one spot must not disappear for the audience.
    context.save();
    context.fillStyle = LASER_STYLE;
    context.beginPath();
    context.arc(x, y, LASER_WIDTH / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }

  const glyph = GLYPHS[mirroredPoint.glyph];
  const entry = glyph && images.get(mirroredPoint.glyph);
  if (!entry?.ready) return;

  const height = Math.min(MAX_SIZE, Math.max(MIN_SIZE, refBox.height * SIZE_RATIO));
  const size = height * glyph.scale;
  context.drawImage(entry.img, x - size * glyph.hotspotX, y - size * glyph.hotspotY, size, size);
}

// null in cursor mode — nothing to mirror there.
function currentGlyph() {
  if (isLaserMode()) return GLYPH_LASER;
  if (isDrawMode()) return isErasingNow() ? 'eraser' : 'pencil';
  return null;
}

function loadGlyph(name) {
  const entry = { img: new Image(), ready: false };
  images.set(name, entry);
  entry.img.addEventListener('load', () => {
    entry.ready = true;
    // A state message usually beats the image decode; ask the host to
    // repaint so the pointer isn't missing until the next move.
    cfg?.onImageReady?.();
  });
  entry.img.src = GLYPHS[name].src;
}

function onPointerMove(e) {
  // Match the canvas input rules: touch contacts (palm on a pen tablet)
  // aren't a pointer the audience should see.
  if (e.pointerType === 'touch') return;
  const n = normalizePoint(getPos(e), cfg.getRefBox());
  const inside = n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1;
  localPoint = inside ? n : null;
  scheduleBroadcast();
}

function clearLocalPoint() {
  // The speaker's own sticky laser dot leaves with the pointer too, so both
  // windows drop it at the same moment.
  clearLaserHead();
  if (localPoint === null) return;
  localPoint = null;
  scheduleBroadcast();
}

// The host's broadcast coalesces to one per frame, so this can fire on every
// raw pointer sample.
function scheduleBroadcast() {
  cfg?.onCursorMoved?.();
}
