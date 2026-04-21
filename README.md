# atrium.js

A minimal, keyboard-driven slide deck with a live annotation layer — built for
lecturers who want to scribble on their slides in real time and mirror the
result to a second window for the audience.

## Idea

Slides are plain SVG files. A transparent `<canvas>` sits on top of them, and
the speaker draws freehand strokes with the mouse (or a stylus). Each
stroke is stored per-slide in coordinates normalized to the SVG's viewBox, so
annotations stick to the content under resize and across windows of different
sizes.

A second "slideshow" window can be opened in the same browser; it mirrors the
current slide, all saved strokes, the in-progress stroke, and any embedded
video playback via `BroadcastChannel`. The speaker window keeps a speaker-notes
sidebar that is hidden in the mirror.

## Usage

### Slides

Put SVG files somewhere reachable (e.g. `slides/`) and list them in
`index.html`:

```html
<div id="slides">
  <div class="slide" data-src="slides/1.svg" data-notes="Intro.&#10;Key goals."></div>
  <div class="slide" data-src="slides/2.svg"></div>
</div>
```

- `data-src` — path to the SVG.
- `data-notes` — optional speaker notes (use `&#10;` for newlines).

Embedded `<video>` elements inside the SVGs are supported and kept in sync
with the slideshow window.

### Keyboard

| Key            | Action                                       |
| -------------- | -------------------------------------------- |
| `←` / `→`      | Previous / next slide                        |
| `P`            | Toggle pencil (drawing) mode                 |
| `B`            | Toggle whiteboard mode (blank pages)         |
| `L`            | Toggle laser pointer (short-living trace)    |
| `S`            | Open / close the slideshow (mirror) window   |
| `F`            | Freeze the slideshow mirror at current state |
| `C`            | Toggle stroke color picker (in drawing mode) |
| `+` / `-`      | Increase / decrease stroke size              |
| `Ctrl+Z`       | Undo last stroke on current slide            |
| Left mouse     | Draw                                         |
| Right mouse    | Erase nearest stroke                         |

### Whiteboard mode

Press `B` to hide the current slide deck and switch to a stack of blank
white pages, sized and letterboxed the same as a slide. Drawing, the color
picker, the laser pointer, undo, and the slideshow mirror all work as
usual — strokes are just stored against the whiteboard page instead of the
underlying slide.

- `←` / `→` navigate between whiteboard pages.
- You start on page 1. Pressing `→` from the last page appends a new blank
  page, but only if the current page has something drawn on it — so empty
  pages don't pile up.
- Press `B` again to return to the slide deck. Whiteboard strokes persist
  for the session; so do your slide annotations.

## Running locally

The app is pure static HTML/CSS/JS — serve this directory with any local
HTTP server that supports `Range` requests (needed for embedded videos to
seek correctly). For example:

```sh
npx http-server .
# or
caddy file-server --listen :8000
```

Then open <http://localhost:8000/> and press `S` to pop out the slideshow
window onto your second display.
