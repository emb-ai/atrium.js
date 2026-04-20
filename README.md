# atrium.js

A minimal, keyboard-driven slide deck with a live annotation layer — built for
lecturers who want to scribble on their slides in real time and mirror the
result to a second window for the audience.

## Idea

Slides are plain SVG files. A transparent `<canvas>` sits on top of them, and
the presenter draws freehand strokes with the mouse (or a stylus). Each
stroke is stored per-slide in coordinates normalized to the SVG's viewBox, so
annotations stick to the content under resize and across windows of different
sizes.

A second "presenter" window can be opened in the same browser; it mirrors the
current slide, all saved strokes, the in-progress stroke, and any embedded
video playback via `BroadcastChannel`. The main window keeps a speaker-notes
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
with the presenter window.

### Keyboard

| Key            | Action                                       |
| -------------- | -------------------------------------------- |
| `←` / `→`      | Previous / next slide                        |
| `V`            | Toggle drawing mode (lets you click slides)  |
| `P`            | Open / close the presenter (mirror) window   |
| `F`            | Freeze the presenter mirror at current state |
| `+` / `-`      | Increase / decrease stroke size              |
| `Ctrl+Z`       | Undo last stroke on current slide            |
| Left mouse     | Draw                                         |
| Right mouse    | Erase nearest stroke                         |

## Running locally

The app is pure static HTML/CSS/JS — serve this directory with any local
HTTP server that supports `Range` requests (needed for embedded videos to
seek correctly). For example:

```sh
npx http-server .
# or
caddy file-server --listen :8000
```

Then open <http://localhost:8000/> and press `P` to pop out the presenter
window onto your second display.
