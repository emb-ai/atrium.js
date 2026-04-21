// Keep per-video play/pause/time/rate in lockstep between the speaker
// window (authoritative) and the slideshow window (strict mirror).
//
// Each <video> is identified by (slideIdx, videoIdx) — its slide index
// plus its position within that slide. The slideshow's own programmatic
// .play()/.pause() calls would otherwise bounce back as fresh broadcasts;
// `suppressBroadcast` blocks those while a remote sync is being applied.

const SYNC_EVENTS = ['play', 'pause', 'seeked', 'ratechange', 'volumechange', 'ended'];
// Clock-drift threshold beyond which we force-align currentTime. Below
// this we let playback run without interference — a per-frame nudge would
// fight normal playback and never settle.
const DRIFT_THRESHOLD_S = 0.3;

let slides = null;
let suppressBroadcast = false;

export function initVideoSync(cfg) {
  slides = cfg.slides;

  for (const { slideIdx, videoIdx, el: v } of getAllVideos()) {
    // Both windows start muted — the lecturer's physical voice carries,
    // and playing video audio from the speaker laptop would feed back
    // through the room mic.
    v.muted = true;

    if (cfg.isSlideshow) {
      // Slideshow videos are strict mirrors — controls stripped so the
      // audience can't desync, and pointer events blocked so clicks/
      // scrubs can't interact.
      v.controls = false;
      v.removeAttribute('controls');
      v.disablePictureInPicture = true;
      v.style.pointerEvents = 'none';
    } else {
      for (const type of SYNC_EVENTS) {
        v.addEventListener(type, () => {
          if (suppressBroadcast) return;
          cfg.broadcast({
            type: 'video-sync',
            slideIdx, videoIdx,
            paused: v.paused,
            currentTime: v.currentTime,
            playbackRate: v.playbackRate,
            muted: v.muted,
            volume: v.volume,
          });
        });
      }
    }
  }
}

export function applyVideoSync(msg) {
  const v = findVideo(msg.slideIdx, msg.videoIdx);
  if (!v) return;

  suppressBroadcast = true;
  try {
    if (Math.abs(v.currentTime - msg.currentTime) > DRIFT_THRESHOLD_S) {
      v.currentTime = msg.currentTime;
    }
    v.playbackRate = msg.playbackRate;
    // Force-muted regardless of speaker's state so the slideshow doesn't
    // double up with the speaker's physical machine audio.
    v.muted = true;

    if (msg.paused && !v.paused) {
      v.pause();
    } else if (!msg.paused && v.paused) {
      // .play() returns a promise that may reject under autoplay policy.
      const p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch(err => console.warn('Slideshow video play() rejected:', err));
      }
    }
  } finally {
    // Release suppression on next tick — the programmatic changes above
    // fire sync events synchronously and we want to skip those specifically.
    setTimeout(() => { suppressBroadcast = false; }, 0);
  }
}

function getAllVideos() {
  const out = [];
  slides.forEach((slide, slideIdx) => {
    slide.querySelectorAll('video').forEach((v, videoIdx) => {
      out.push({ slideIdx, videoIdx, el: v });
    });
  });
  return out;
}

function findVideo(slideIdx, videoIdx) {
  const slide = slides[slideIdx];
  if (!slide) return null;
  return slide.querySelectorAll('video')[videoIdx] || null;
}
