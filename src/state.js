// Central reactive store.
//
// Cross-module state lives here and is mutated only through the exported
// setters, each of which emits a named change event via the tiny bus below.
// Subscribers — renderer, speaker-link broadcaster, toolbar, notes panel —
// register once at boot and re-run themselves when state changes, so the
// dozens of mutation sites don't each have to remember to call them.
//
// Imported bindings are live: `import { currentSlide } from './state.js'`
// gives a read-only view that tracks updates made by setters in this module.
// External code cannot reassign these — it must call the matching setter.

// ─── Event bus ────────────────────────────────────────────────────────────────
const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

function emit(event) {
  listeners.get(event)?.forEach(fn => fn());
}

// ─── Slides ───────────────────────────────────────────────────────────────────
export let currentSlide = 0;
// slidesData[i] holds the normalized strokes drawn on slide i. Initialized
// empty; boot must call setSlidesData once the slide count is known.
export let slidesData = [];

export function setCurrentSlide(idx) {
  if (idx === currentSlide) return;
  currentSlide = idx;
  emit('slide');
}

export function setSlidesData(arr) {
  slidesData = arr;
  emit('strokes');
}

// ─── Whiteboard ───────────────────────────────────────────────────────────────
export let whiteboardMode = false;
export let whiteboardSlides = [[]];
export let whiteboardCurrent = 0;

export function setWhiteboardMode(on) {
  if (on === whiteboardMode) return;
  whiteboardMode = on;
  emit('whiteboard');
  emit('strokes'); // active stroke array flipped between slide and whiteboard
}

export function setWhiteboardSlides(arr) {
  whiteboardSlides = arr;
  emit('strokes');
}

export function setWhiteboardCurrent(idx) {
  if (idx === whiteboardCurrent) return;
  whiteboardCurrent = idx;
  emit('whiteboard');
  emit('strokes');
}

// Append a new blank whiteboard page and emit. Kept as a named op because
// callers should not mutate whiteboardSlides directly (live binding).
export function pushWhiteboardPage() {
  whiteboardSlides.push([]);
  emit('strokes');
}

// ─── Interaction mode ────────────────────────────────────────────────────────
// Mutually exclusive. Exactly one of these is active at any time:
//   'draw'   — pencil; left-click draws, right-click erases.
//   'laser'  — red fading pointer trail.
//   'cursor' — neutral; canvas transparent to pointer events (OS cursor shows).
// Draw and laser both require canvas pointer events; cursor disables them.
export const MODE_DRAW   = 'draw';
export const MODE_LASER  = 'laser';
export const MODE_CURSOR = 'cursor';

export let mode = MODE_DRAW;

export function setMode(next) {
  if (next === mode) return;
  mode = next;
  emit('mode');
}

// Derived predicates — live with the mode so callers don't hand-roll the
// comparison at every call site.
export function isDrawMode()   { return mode === MODE_DRAW; }
export function isLaserMode()  { return mode === MODE_LASER; }
export function isCursorMode() { return mode === MODE_CURSOR; }
// Canvas pointer events are on for both draw and laser; only cursor disables.
export function isPointerCaptureOn() { return mode !== MODE_CURSOR; }

// ─── Pen style ────────────────────────────────────────────────────────────────
// Defaults mirror the values the color picker would pick on first open. They
// are plain literals here (not imported from the palette constant) so state.js
// stays free of UI-layer dependencies — boot or the color picker can override.
export let strokeColor = '#168afe';
export let lineWidth = 5;

export function setStrokeColor(c) {
  if (c === strokeColor) return;
  strokeColor = c;
  emit('style');
}

export function setLineWidth(w) {
  if (w === lineWidth) return;
  lineWidth = w;
  emit('style');
}

// ─── Derived helpers ──────────────────────────────────────────────────────────
// The "active" stroke array is the one the user is drawing into — a slide's
// stroke list or the current whiteboard page's.
export function getActiveStrokes() {
  return whiteboardMode ? whiteboardSlides[whiteboardCurrent] : slidesData[currentSlide];
}

// In-place array mutations (push/pop/splice on the array from getActiveStrokes)
// don't reassign a binding, so the bus doesn't know. Callers must call this
// after mutating so subscribers re-render / re-broadcast.
export function strokesChanged() {
  emit('strokes');
}
