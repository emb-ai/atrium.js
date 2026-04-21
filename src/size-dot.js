// Transient preview dot shown at the cursor after a stroke-size change.
// Size + color are supplied by the caller so this module stays free of
// state-store imports — it's a pure "blink a dot here" primitive.
//
// The dot fades out on its own after SHOW_DURATION_MS via a CSS transition
// driven by the `.fade` class; calling showSizeDot() again resets that
// timer and re-triggers the transition.

const SHOW_DURATION_MS = 350;

const sizeDot = document.createElement('div');
sizeDot.id = 'size-dot';
document.querySelector('.canvas-wrap').appendChild(sizeDot);

let hideTimer = null;

export function showSizeDot(pos, size, color) {
  const r = size / 2;

  sizeDot.style.width  = size + 'px';
  sizeDot.style.height = size + 'px';
  sizeDot.style.left   = (pos.x - r) + 'px';
  sizeDot.style.top    = (pos.y - r) + 'px';
  sizeDot.style.background = color;

  // Re-trigger the fade transition: clear the fade class, force reflow,
  // then add `.visible` so the browser animates from scratch.
  sizeDot.classList.remove('fade');
  sizeDot.classList.add('visible');
  void sizeDot.offsetWidth;

  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    sizeDot.classList.add('fade');
  }, SHOW_DURATION_MS);
}
