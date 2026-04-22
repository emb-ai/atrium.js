// Keybinding cheatsheet overlay. Toggled via `?` (or a click on the
// backdrop). Speaker window only — CSS hides it in the slideshow window
// so there's no state to guard here.

let overlay = null;

function sync() {
  const open = document.body.classList.contains('help-open');
  overlay?.setAttribute('aria-hidden', open ? 'false' : 'true');
}

export function initHelp() {
  overlay = document.getElementById('help-overlay');
  if (!overlay) return;
  // Click outside the panel closes; clicks on the panel itself shouldn't.
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeHelp();
  });
  sync();
}

export function toggleHelp() {
  document.body.classList.toggle('help-open');
  sync();
}

export function closeHelp() {
  if (!document.body.classList.contains('help-open')) return;
  document.body.classList.remove('help-open');
  sync();
}
