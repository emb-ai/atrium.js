// Keyboard shortcut dispatch for the speaker window. Each binding calls
// into an `actions` callback so this module doesn't need to know how each
// operation works — just which key maps to which.

export function initKeybindings(actions) {
  document.addEventListener('keydown', e => {
    // Ctrl+Z undoes regardless of mode; the action itself guards on frozen.
    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault();
      actions.undo();
      return;
    }

    // Cheatsheet toggle — `?` opens, Escape closes (only when open).
    if (e.key === '?') { e.preventDefault(); actions.help(); return; }
    if (e.key === 'Escape') { actions.closeHelp(); return; }

    switch (e.key.toLowerCase()) {
      case 'f': e.preventDefault(); actions.freeze();     break;
      case 'd': e.preventDefault(); actions.draw();       break;
      case 'l': e.preventDefault(); actions.laser();      break;
      case 'c': e.preventDefault(); actions.cursor();     break;
      case 'p': e.preventDefault(); actions.color();      break;
      case 's': e.preventDefault(); actions.slideshow();  break;
      case 'b': e.preventDefault(); actions.whiteboard(); break;
      case 'arrowright':
      case 'pagedown':
        actions.next();
        break;
      case 'arrowleft':
      case 'pageup':
        actions.prev();
        break;
      case 'home': actions.first(); break;
      case 'end':  actions.last();  break;
      case '+':
      case '=':
        e.preventDefault();
        actions.sizeUp();
        break;
      case '-':
      case '_':
        e.preventDefault();
        actions.sizeDown();
        break;
    }
  });
}
