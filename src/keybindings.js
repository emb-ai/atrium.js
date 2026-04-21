// Keyboard shortcut dispatch for the speaker window. Each binding calls
// into an `actions` callback so this module doesn't need to know how each
// operation works — just which key maps to which.
//
// Escape is special-cased to close the color picker (and only then) so the
// browser's native Escape handling (e.g. exit fullscreen) still fires when
// the picker isn't open.

import { isColorPickerOpen, closeColorPicker } from './color-picker.js';

export function initKeybindings(actions) {
  document.addEventListener('keydown', e => {
    // Ctrl+Z undoes regardless of mode; the action itself guards on frozen.
    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault();
      actions.undo();
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'f': e.preventDefault(); actions.freeze();     break;
      case 'p': e.preventDefault(); actions.draw();       break;
      case 'l': e.preventDefault(); actions.laser();      break;
      case 'm': e.preventDefault(); actions.cursor();     break;
      case 'c': e.preventDefault(); actions.color();      break;
      case 's': e.preventDefault(); actions.slideshow();  break;
      case 'b': e.preventDefault(); actions.whiteboard(); break;
      case 'arrowright': actions.next(); break;
      case 'arrowleft':  actions.prev(); break;
      case 'escape':
        if (isColorPickerOpen()) {
          e.preventDefault();
          closeColorPicker();
        }
        break;
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
