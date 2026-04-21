// BroadcastChannel wiring between the speaker window and its mirrored
// slideshow. Speaker is authoritative; slideshow is a strict listener that
// applies incoming `state` / `video-sync` messages and never writes back.
//
// Owns: window.open lifecycle, `frozen` (pauses outbound broadcasts so the
// speaker can preview changes without leaking them to the audience), the
// pendingState queue (messages arriving before slides render), and the
// slideshow-only `mirroredLiveStroke` cache the renderer reads.

import {
  on,
  currentSlide, setCurrentSlide,
  slidesData, setSlidesData,
  mode, setMode,
  lineWidth, strokeColor,
  whiteboardMode, setWhiteboardMode,
  whiteboardSlides, setWhiteboardSlides,
  whiteboardCurrent, setWhiteboardCurrent,
} from './state.js';
import { getLaserPoints, setLaserPoints, startLaserLoop } from './laser.js';

const SLIDESHOW_CLOSED_POLL_MS = 500;

export const IS_SLIDESHOW = new URLSearchParams(location.search).has('slideshow');

const channel = new BroadcastChannel('slides-speaker-mode');
let slideshowWin = null;
let frozen = false;
let slidesReady = false;
let pendingState = null;
// Slideshow-only cache of the speaker's in-progress stroke. Exposed via
// getMirroredLiveStroke() so the renderer can paint it alongside committed
// strokes without a separate redraw path.
let mirroredLiveStroke = null;
let cfg = null;

if (IS_SLIDESHOW) document.body.classList.add('is-slideshow');
document.title = IS_SLIDESHOW ? 'Slideshow' : 'Speaker';

// Slideshow can boot straight into whiteboard mode via ?whiteboard=1 —
// without this, the audience sees a flash of real slides between page load
// and the first `state` message arriving.
if (IS_SLIDESHOW && new URLSearchParams(location.search).get('whiteboard') === '1') {
  setWhiteboardMode(true);
}

export function initSpeakerLink(config) {
  cfg = config;

  channel.addEventListener('message', onChannelMessage);

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
  if (pendingState) {
    applySlideshowState(pendingState);
    pendingState = null;
  }
  // Announce readiness so the speaker window can reply with current state
  // — handles the case where this window opened after the speaker sent its
  // most recent update.
  channel.postMessage({ type: 'request-state' });
}

export function broadcastState() {
  if (IS_SLIDESHOW) return;
  if (isFrozen()) return;
  const liveStroke = cfg?.getLiveStroke?.() ?? null;
  channel.postMessage({
    type: 'state',
    currentSlide,
    slidesData,
    mode,
    liveStroke,
    liveStrokeWidth: lineWidth,
    liveStrokeColor: strokeColor,
    laserPoints: getLaserPoints(),
    whiteboardMode,
    whiteboardSlides,
    whiteboardCurrent,
  });
}

// Forward an arbitrary message (used by video-sync for its own message
// type). Mirrors the guards that broadcastState applies plus the
// isSlideshowOpen check — no point blasting video events when nothing's
// listening and it was the original behavior we need to preserve.
export function postToSlideshow(msg) {
  if (IS_SLIDESHOW) return;
  if (isFrozen()) return;
  if (!isSlideshowOpen()) return;
  channel.postMessage(msg);
}

export function toggleSpeakerMode() {
  if (IS_SLIDESHOW) return;

  if (isSlideshowOpen()) {
    slideshowWin.close();
    closeSlideshow();
    return;
  }

  const params = new URLSearchParams({ slideshow: '1' });
  if (whiteboardMode) params.set('whiteboard', '1');
  slideshowWin = window.open(
    location.pathname + '?' + params.toString() + location.hash,
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
  }
}

function closeSlideshow() {
  slideshowWin = null;
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
    if (msg.type === 'state') {
      // If slides are still loading, queue the message so the final
      // markSlidesReady() can apply it without racing preloadSlides.
      if (!slidesReady) {
        pendingState = msg;
        return;
      }
      applySlideshowState(msg);
    } else if (msg.type === 'video-sync') {
      if (!slidesReady) return;
      cfg?.onVideoSync?.(msg);
    }
  } else {
    if (msg.type === 'request-state') broadcastState();
  }
}

function applySlideshowState(msg) {
  // Update the mirror-only liveStroke cache *before* firing state setters,
  // so the synchronous 'slide' / 'strokes' / 'whiteboard' subscribers see
  // the fresh value on their first redraw — otherwise we'd need a second
  // redrawAll() at the end to paint it correctly.
  mirroredLiveStroke = msg.liveStroke
    ? { points: msg.liveStroke, width: msg.liveStrokeWidth ?? lineWidth, color: msg.liveStrokeColor }
    : null;

  setCurrentSlide(msg.currentSlide);
  setSlidesData(msg.slidesData);
  if (typeof msg.mode === 'string') setMode(msg.mode);
  setWhiteboardMode(!!msg.whiteboardMode);
  if (Array.isArray(msg.whiteboardSlides)) setWhiteboardSlides(msg.whiteboardSlides);
  if (typeof msg.whiteboardCurrent === 'number') setWhiteboardCurrent(msg.whiteboardCurrent);

  setLaserPoints(msg.laserPoints);
  if (getLaserPoints().length > 0) startLaserLoop();

  // If every setter above was a no-op (values unchanged) no subscriber
  // fires — ask the host to redraw once so the new mirroredLiveStroke
  // still takes effect.
  cfg?.onStateApplied?.();
}
