// Deck loading indicator (#loading-indicator).
//
// Centered overlay shown while the slide deck is being fetched/rendered:
// initial SVG preload at boot, and user-initiated deck loads (SVGs or PDF).
// PDF imports report per-page progress via updateLoading().
//
// Visibility is driven by the `is-loading` class on <body>, so CSS owns the
// transition — showLoading() can be called repeatedly without glitches.

const el = document.getElementById('loading-indicator');
const label = el?.querySelector('.loading-label');

export function showLoading(text = 'Loading deck') {
  if (!el) return;
  label.textContent = text;
  el.setAttribute('aria-hidden', 'false');
  document.body.classList.add('is-loading');
}

export function updateLoading(text) {
  if (!el) return;
  label.textContent = text;
}

export function hideLoading() {
  if (!el) return;
  el.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('is-loading');
}
