// BroadcastChannel wiring between the speaker window and its mirrored
// slideshow. Speaker is authoritative; slideshow is a strict listener that
// applies incoming `state` / `live` / `video-sync` messages and never writes
// back.
//
// Owns: window.open lifecycle, `frozen` (pauses outbound broadcasts so the
// speaker can preview changes without leaking them to the audience), the
// pendingState queue (messages arriving before slides render), and the
// slideshow-only `mirroredLiveStroke` cache the renderer reads. The
// equivalent cache for the mirrored pointer lives in drawing/cursor.js,
// which owns both ends of that mirror.

import {
  on, batch,
  currentSlide, setCurrentSlide,
  slidesData, setSlidesData,
  mode, setMode,
  lineWidth, strokeColor,
  whiteboardMode, setWhiteboardMode,
  whiteboardSlides, setWhiteboardSlides,
  whiteboardCurrent, setWhiteboardCurrent,
} from '../state.js';
import { getLaserPoints, setLaserPoints, startLaserLoop } from '../drawing/laser.js';
import { setMirroredCursor } from '../drawing/cursor.js';

const SLIDESHOW_CLOSED_POLL_MS = 500;

const params = new URLSearchParams(location.search);

export const IS_SLIDESHOW = params.has('slideshow');

// Set when the speaker already had a user-loaded deck at the moment it opened
// this window. Tells preloadSlides() to skip index.html's data-src slides
// outright — those are the built-in demo deck, and painting them would show
// the wrong slides for as long as the real deck takes to arrive.
export const SLIDESHOW_AWAITS_DECK = IS_SLIDESHOW && params.has('deck');

const channel = new BroadcastChannel('slides-speaker-mode');
let slideshowWin = null;
let frozen = false;
let slidesReady = false;
let pendingState = null;
let pendingDeck = null;
// Speaker-side cache of a user-loaded deck (from the folder picker). null
// means the deck is whatever's in the HTML; both windows load the same
// data-src URLs in that case, so no explicit sync is needed. Once set,
// it's replayed to any slideshow window that asks for state.
let currentDeckSources = null;
// Slideshow-only cache of the speaker's in-progress stroke. Exposed via
// getMirroredLiveStroke() so the renderer can paint it alongside committed
// strokes without a separate redraw path.
let mirroredLiveStroke = null;
// Slideshow-only: whether any `state` message has landed yet. Gates the
// retry request in markSlidesReady().
let receivedState = false;
// Slideshow-only: newest `state` waiting for the next frame. Applying a state
// costs several full redraws, and while the speaker draws, messages arrive
// faster than that — applying each one let a backlog build up and froze the
// window. Only the newest matters, so older ones are dropped unapplied.
let queuedState = null;
let queuedLive = null;
let applyFrameId = null;
// Speaker-side: physical pixel width of the screen the slideshow window sits
// on, as reported by that window. null until one announces itself. PDF import
// uses it to pick a rasterization resolution instead of always assuming 4K.
let slideshowScreenWidthPx = null;
let cfg = null;

if (IS_SLIDESHOW) document.body.classList.add('is-slideshow');
document.title = IS_SLIDESHOW ? 'Slideshow' : 'Speaker';

// Slideshow can boot straight into whiteboard mode via ?whiteboard=1 and onto
// the speaker's current slide via ?slide=N — without these, the audience sees
// a flash of real slides (or slide 0) between page load and the first `state`
// message arriving.
if (IS_SLIDESHOW) {
  if (params.get('whiteboard') === '1') setWhiteboardMode(true);
  const slideParam = Number.parseInt(params.get('slide'), 10);
  if (Number.isFinite(slideParam) && slideParam >= 0) setCurrentSlide(slideParam);
}

// Subscribed at module load rather than from initSpeakerLink(): the slideshow
// window doesn't reach initSpeakerLink() until preloadSlides() has resolved,
// and anything the speaker sends in that gap would be dropped.
// onChannelMessage parks messages arriving before markSlidesReady() in
// pendingDeck / pendingState, so early delivery is safe.
channel.addEventListener('message', onChannelMessage);

// Ask for deck + state as early as possible so the speaker's reply — which
// for a PDF deck is the slow part — travels while this window is still
// booting, instead of starting only once it has finished.
// The viewport report goes first: it's what the speaker sizes a PDF import
// against, and a deck imported before it lands is stuck at the 4K default.
if (IS_SLIDESHOW) {
  reportViewport();
  channel.postMessage({ type: 'request-state' });
  // Moving the window to another monitor changes both of these, and the
  // resolution only matters for decks imported from here on.
  window.addEventListener('resize', reportViewport);
}

function reportViewport() {
  channel.postMessage({
    type: 'viewport',
    screenWidthPx: Math.round(screen.width * devicePixelRatio),
  });
}

export function getSlideshowScreenWidthPx() {
  return slideshowScreenWidthPx;
}

export function initSpeakerLink(config) {
  cfg = config;

  if (IS_SLIDESHOW) return;

  // Poll for external close (user closes the slideshow window directly
  // instead of toggling it from the speaker).
  setInterval(() => {
    if (slideshowWin && slideshowWin.closed) closeSlideshow();
  }, SLIDESHOW_CLOSED_POLL_MS);

  on('slide',      broadcastState);
  on('strokes',    broadcastState);
  on('whiteboard', broadcastState);
  on('mode',       broadcastState);
}

export function isSlideshowOpen() {
  return !!(slideshowWin && !slideshowWin.closed);
}

export function isFrozen() {
  // Auto-clear freeze if the slideshow window has gone away — frozen-without-
  // a-target is nonsensical and the freeze indicator would otherwise linger.
  if (frozen && !isSlideshowOpen()) {
    frozen = false;
    syncFreezeIndicator();
  }
  return frozen;
}

export function getMirroredLiveStroke() {
  return mirroredLiveStroke;
}

export function markSlidesReady() {
  slidesReady = true;
  // Deck must apply before state so setSlidesData in applySlideshowState
  // lines up with the new slide count.
  if (pendingDeck) {
    cfg?.onDeckReceived?.(pendingDeck.sources);
    pendingDeck = null;
  }
  if (pendingState) {
    applySlideshowState(pendingState);
    pendingState = null;
  }
  // The boot-time request above normally means state has already arrived and
  // was applied from the queue. Re-ask only if it hasn't — covers a speaker
  // that wasn't listening yet when this window sent its first request.
  if (!receivedState) channel.postMessage({ type: 'request-state' });
}

// Two outbound kinds, coalesced into at most one message per frame:
//  • `state` — everything, including all strokes of all slides. Sent on
//    committed changes (slide, strokes, whiteboard, mode).
//  • `live`  — only what moves under the pointer: the in-progress stroke,
//    laser trail and pointer position. Sent while drawing / pointing, so the
//    per-frame cost doesn't grow with the ink already on the slides.
// A frame that has both sends one `state`, which carries the live fields too.
// Pointer devices sample far faster than the screen refreshes, hence the
// coalescing. Guards run at send time, so a freeze that lands mid-frame still
// holds. A hidden tab gets no animation frames (Zoom in the foreground tab),
// so it sends at once instead of stalling until the tab is shown again.
let broadcastFrameId = null;
let fullBroadcastPending = false;

export function broadcastState() {
  scheduleBroadcast(true);
}

export function broadcastLive() {
  scheduleBroadcast(false);
}

function scheduleBroadcast(full) {
  if (IS_SLIDESHOW) return;
  if (full) fullBroadcastPending = true;
  if (document.hidden) {
    flushBroadcast();
    return;
  }
  if (broadcastFrameId !== null) return;
  broadcastFrameId = requestAnimationFrame(() => {
    broadcastFrameId = null;
    flushBroadcast();
  });
}

function flushBroadcast() {
  const full = fullBroadcastPending;
  fullBroadcastPending = false;
  if (isFrozen()) return;
  const live = liveFields();
  if (!full) {
    channel.postMessage({ type: 'live', ...live });
    return;
  }
  channel.postMessage({
    type: 'state',
    currentSlide,
    slidesData,
    mode,
    whiteboardMode,
    whiteboardSlides,
    whiteboardCurrent,
    ...live,
  });
}

function liveFields() {
  return {
    liveStroke: cfg?.getLiveStroke?.() ?? null,
    liveStrokeWidth: lineWidth,
    liveStrokeColor: strokeColor,
    laserPoints: getLaserPoints(),
    cursorPoint: cfg?.getCursorPoint?.() ?? null,
  };
}

// Forward an arbitrary message (used by video for its own message
// type). Mirrors the guards that broadcastState applies plus the
// isSlideshowOpen check — no point blasting video events when nothing's
// listening and it was the original behavior we need to preserve.
export function postToSlideshow(msg) {
  if (IS_SLIDESHOW) return;
  if (isFrozen()) return;
  if (!isSlideshowOpen()) return;
  channel.postMessage(msg);
}

// Store and broadcast a user-loaded deck so the slideshow window rebuilds
// its #slides container from the same SVG text. Kept separate from
// broadcastState because state fires on every stroke/slide/mode change
// and the deck payload would be pointless overhead there.
export function broadcastDeck(sources) {
  if (IS_SLIDESHOW) return;
  currentDeckSources = sources;
  channel.postMessage({ type: 'deck', sources });
}

export function toggleSpeakerMode() {
  if (IS_SLIDESHOW) return;

  if (isSlideshowOpen()) {
    slideshowWin.close();
    closeSlideshow();
    return;
  }

  const openParams = new URLSearchParams({ slideshow: '1' });
  if (whiteboardMode) openParams.set('whiteboard', '1');
  if (currentSlide) openParams.set('slide', String(currentSlide));
  // Tell the new window a real deck is coming so it doesn't paint the demo
  // slides baked into index.html while waiting for it.
  if (currentDeckSources) openParams.set('deck', '1');
  slideshowWin = window.open(
    location.pathname + '?' + openParams.toString() + location.hash,
    'slideshow',
  );
  cfg?.onSlideshowOpened?.();
}

export function toggleFreeze() {
  // Freeze only makes sense while a slideshow window is open.
  if (!isSlideshowOpen()) {
    if (frozen) {
      frozen = false;
      syncFreezeIndicator();
    }
    return;
  }
  frozen = !frozen;
  syncFreezeIndicator();
  if (!frozen) {
    // On unfreeze, immediately push current state so the slideshow catches
    // up on everything it missed while broadcasts were paused.
    broadcastState();
    cfg?.broadcastVideoCatchup?.();
  }
}

function closeSlideshow() {
  slideshowWin = null;
  // Forget the audience resolution: a later import shouldn't be sized for a
  // screen that's no longer attached.
  slideshowScreenWidthPx = null;
  frozen = false;
  syncFreezeIndicator();
  cfg?.onSlideshowClosed?.();
}

function syncFreezeIndicator() {
  document.body.classList.toggle('is-frozen', frozen);
  cfg?.onFreezeChanged?.();
}

function onChannelMessage(event) {
  const msg = event.data;
  if (!msg) return;

  if (IS_SLIDESHOW) {
    if (msg.type === 'deck') {
      if (!slidesReady) {
        pendingDeck = msg;
        return;
      }
      // Queued messages belong to the old deck; the speaker sends a fresh
      // state right after the deck.
      queuedState = null;
      queuedLive = null;
      cfg?.onDeckReceived?.(msg.sources);
    } else if (msg.type === 'state') {
      receivedState = true;
      // If slides are still loading, queue the message so the final
      // markSlidesReady() can apply it without racing preloadSlides.
      if (!slidesReady) {
        pendingState = msg;
        return;
      }
      queueSlideshowState(msg);
    } else if (msg.type === 'live') {
      // Dropped until slides are ready: the next pointer move sends fresh
      // live fields anyway.
      if (!slidesReady) return;
      queueSlideshowLive(msg);
    } else if (msg.type === 'video-sync') {
      if (!slidesReady) return;
      cfg?.onVideoSync?.(msg);
    }
  } else {
    if (msg.type === 'viewport') {
      if (Number.isFinite(msg.screenWidthPx) && msg.screenWidthPx > 0) {
        slideshowScreenWidthPx = msg.screenWidthPx;
      }
    } else if (msg.type === 'request-state') {
      // Deck before state so the slideshow rebuilds its #slides container
      // before applying the stroke arrays sized to the new slide count.
      if (currentDeckSources) channel.postMessage({ type: 'deck', sources: currentDeckSources });
      broadcastState();
      cfg?.broadcastVideoCatchup?.();
    }
  }
}

function queueSlideshowState(msg) {
  queuedState = msg;
  // A state carries the live fields too, and is newer than any queued live.
  queuedLive = null;
  scheduleApply();
}

function queueSlideshowLive(msg) {
  queuedLive = msg;
  scheduleApply();
}

function scheduleApply() {
  if (applyFrameId !== null) return;
  applyFrameId = requestAnimationFrame(() => {
    applyFrameId = null;
    const state = queuedState;
    const live = queuedLive;
    queuedState = null;
    queuedLive = null;
    if (state) applySlideshowState(state);
    if (live) applySlideshowLive(live);
  });
}

function applyLiveFields(msg) {
  mirroredLiveStroke = msg.liveStroke
    ? { points: msg.liveStroke, width: msg.liveStrokeWidth ?? lineWidth, color: msg.liveStrokeColor }
    : null;
  setMirroredCursor(msg.cursorPoint);
  setLaserPoints(msg.laserPoints);
}

function applySlideshowLive(msg) {
  applyLiveFields(msg);
  if (getLaserPoints().length > 0) startLaserLoop();
  cfg?.onLiveApplied?.();
}

function applySlideshowState(msg) {
  // Batched so the subscribers of every setter below run once at the end —
  // a redraw each for 'slide', 'strokes' and 'whiteboard' tripled the cost.
  // setSlidesData emits unconditionally, so that final redraw always runs
  // and picks up the new mirroredLiveStroke / pointer even when nothing else
  // changed.
  batch(() => {
    applyLiveFields(msg);

    setCurrentSlide(msg.currentSlide);
    setSlidesData(msg.slidesData);
    if (typeof msg.mode === 'string') setMode(msg.mode);
    setWhiteboardMode(!!msg.whiteboardMode);
    if (Array.isArray(msg.whiteboardSlides)) setWhiteboardSlides(msg.whiteboardSlides);
    if (typeof msg.whiteboardCurrent === 'number') setWhiteboardCurrent(msg.whiteboardCurrent);
  });
  if (getLaserPoints().length > 0) startLaserLoop();
}
