# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**atrium.js** — a static HTML/CSS/JS slide deck with a transparent drawing
canvas on top, plus a mirrored "slideshow" window the speaker drives from
the main "speaker" window. No build step, no runtime npm deps (pdf.js is
vendored at `vendor/pdfjs/` and loaded on demand). Entry point is
`index.html` → `src/main.js`, which wires together focused ES modules
under `src/`: the state bus (`state.js`), canvas helpers (`canvas.js`),
geometry (`geometry.js`), deck lifecycle (`slides.js`), drawing
(`drawing/input.js`, `drawing/renderer.js`, `drawing/laser.js`), window
sync (`sync/speaker.js`, `sync/video.js`), and UI (`ui/toolbar.js`,
`ui/keybindings.js`, `ui/notes.js`, `ui/progress.js`,
`ui/color-picker.js`, `ui/stroke-size.js`, `ui/help.js`,
`ui/loading.js`). Sample slides live in `slides/` as SVG files, but the
deck can also be loaded at runtime (SVGs or a single PDF).

## Running locally

Serve the directory with any static server that supports HTTP `Range`
requests (needed for embedded `<video>` seeking). The included
`serve.py` is a simple option (`./serve.py`); `npx http-server .` or
`caddy file-server --listen :8000` work too. Then open
<http://localhost:8000/>.

There are no tests, no linter, no build.

## Architecture

### Slide rendering
`index.html` ships with an empty `#slides` container. Decks are loaded
either by pre-populating `#slides` with `.slide` divs that have
`data-src="slides/N.svg"` (and optional `data-notes="..."` — literal
newlines via `&#10;`), or at runtime via the toolbar's "Load deck"
button. `preloadSlides()` fetches each `data-src` SVG and injects it;
only the slide with class `active` is shown. With no deck loaded, the
speaker window shows the `#empty-deck-cta` button and `body.no-deck`
is set; whiteboard mode still works. Runtime loading accepts either a
multi-selection of SVG files (sorted with numeric-aware filename
order) or a single PDF — see *PDF decks* below.

### PDF decks
When the user picks a PDF, `src/slides.js` imports pdf.js from
`vendor/pdfjs/` on demand, rasterizes each page to a canvas at
`PDF_RENDER_SCALE` (multiplier over PDF's native 72dpi), and embeds
the PNG in a minimal `<svg>` wrapper whose `viewBox` matches the
page's PDF units. The rest of the SVG pipeline — normalization,
broadcasting, whiteboard toggling — handles it unchanged. Bumping
`PDF_RENDER_SCALE` improves crispness at the cost of render time and
broadcast payload.

### Drawing layer — the normalization trick
A transparent `<canvas id="c">` is absolutely positioned over the
slides. Every stroke is stored **normalized to the active SVG's
viewBox**, not in screen pixels. The pipeline:

1. `getReferenceBox()` computes the on-screen rectangle the SVG's
   viewBox occupies, replicating SVG's `preserveAspectRatio` math
   (meet/slice, xMid/xMax/YMid/YMax alignments). In whiteboard mode
   the underlying slide is hidden, but the active slide's SVG is still
   used as the reference — so the blank "page" occupies the exact same
   letterbox.
2. `normalizePoint` / `denormalizePoint` convert between canvas CSS
   pixels and viewBox-relative `[0,1]` coordinates.
3. `redrawAll()` walks the active stroke list (`getStrokes()` — either
   `slidesData[currentSlide]` or `whiteboardSlides[whiteboardCurrent]`)
   and re-projects every stroke on each resize / slide change.
4. Drawing is clipped to the reference box via `clipToRect()` (from
   `src/canvas.js`), so strokes can't bleed into the letterbox margin
   even if the pointer wanders outside.

This is what makes annotations stick to SVG content across resizes
**and** across two windows of different sizes (speaker ↔ slideshow).
If you add a new slide source type (e.g. PNG, PDF page), you must
extend `getReferenceBox()` to derive a reference box from that medium
(e.g. `img.naturalWidth` / `naturalHeight`) or normalization breaks.

A second in-memory `<canvas>` (`tmp`, `tctx`) is used to paint only the
newest quadratic-curve segment during live drawing, avoiding a full
`redrawAll()` on every `pointermove`. The same `tmp` canvas is reused
as the laser pointer overlay (the two modes are mutually exclusive).
`finalizeDrawing()` commits the stroke to the active stroke list on
mouseup.

### Interaction modes (mutually exclusive)
One of three values held in `mode` (in `src/state.js`): `'draw'`,
`'laser'`, `'cursor'`. Changed only via `setMode()`, which emits a
`'mode'` event; `src/main.js` owns the body-class/laser-loop/toolbar
side-effects, and `src/drawing/input.js` owns the cursor-class and
color-picker close — each module subscribes from its own init.

- **Draw** (`D`) — pencil cursor, left-click draws, right-click erases.
- **Laser** (`L`) — red tapered ribbon trail that fades over
  `LASER_TTL` (200 ms). Points are smoothed with an EMA and rendered
  as filled quads with shared normals so joins don't jag. Each point
  carries a `Date.now()` timestamp so speaker and slideshow fade the
  trail independently without tick-synced messages.
- **Cursor** (`C`) — neutral resting state; canvas is transparent to
  pointer events so the audience/presenter can just point with the OS
  cursor. Disabling draw or laser falls back to cursor mode, not to an
  "everything off" state.

Canvas pointer capture is on whenever `mode !== 'cursor'` (both draw
and laser need it). The `body.drawing-enabled` / `body.drawing-disabled`
classes (and matching classes on `#c` / `#tmp`) mirror that — CSS
keys off those classes to toggle `pointer-events`.

### Whiteboard mode (`B`)
A separate stack of blank pages with independent stroke arrays
(`whiteboardSlides`, `whiteboardCurrent`). Entering whiteboard mode
adds `body.whiteboard-mode`, which hides the active slide's SVG and
reveals `#whiteboard-page`. JS positions `#whiteboard-page` every
redraw to match `getReferenceBox()` exactly — so the blank page
letterboxes identically to the underlying slide.

- `←`/`→` navigate whiteboard pages. Right-arrow from the last page
  appends a new blank page, but only if the current page has ink —
  prevents piling up empties.
- Whiteboard and slide strokes coexist in memory; toggling `B` swaps
  between them without loss.
- The slideshow window accepts `?whiteboard=1` and `?slide=N` in
  addition to `?slideshow=1` so it can boot straight into whiteboard
  mode and/or onto the speaker's current slide, avoiding a flash of
  slide 0 before the first `state` broadcast arrives.

### Speaker mode
Opening the same URL with `?slideshow=1` puts the page in mirror mode
(`IS_SLIDESHOW = true`). The two windows communicate via
`BroadcastChannel('slides-speaker-mode')`:

- **Speaker → slideshow**: `state` (current slide, all strokes,
  in-progress live stroke, current `mode`, laser points, whiteboard
  mode/slides/current), `video-sync` (per-video `paused` /
  `currentTime` / `playbackRate` / `muted` / `volume`), and `deck`
  (for runtime-loaded decks — a list of `{name, svgText}` the
  slideshow rebuilds its `#slides` container from, sent via
  `broadcastDeck()` in `sync/speaker.js`).
- **Slideshow → speaker**: a single `request-state` on boot; the
  speaker replies with `deck` (if a runtime deck is in use) followed
  by `state`, so the mirror rebuilds its container before applying
  strokes sized to the new slide count.

The slideshow window disables input (`pointer-events: none` on the
canvases), hides its notes panel / toolbar / freeze indicator via
`body.is-slideshow`, force-mutes videos and hides their controls, and
never broadcasts back. `suppressVideoBroadcast` prevents sync echo
when the slideshow's own programmatic `.play()`/`.pause()` fires
events.

`frozen` (toggled with `F`) pauses outbound broadcasts so the speaker
window can preview changes without showing them to the audience;
unfreezing re-broadcasts current state. While frozen, `#freeze-indicator`
shows a pulsing pill at the top of the speaker window. Freeze
auto-clears if the slideshow window closed.

### Speaker toolbar
`#toolbar` (speaker window only) mirrors every keyboard shortcut as a
clickable button so features are discoverable. `syncToolbar()` keeps
the active/disabled state of each button in lockstep with the
underlying flags. The bar auto-hides after `TOOLBAR_HIDE_DELAY` (1 s)
and reappears when the mouse enters the bottom `TOOLBAR_REVEAL_ZONE`
(120 px) of the viewport. It's rendered with `pointer-events: none` on
the container so dragging the pointer between buttons passes through
to the canvas (drawing/laser keep working); individual buttons
re-enable pointer events.

### Notes panel
Visible only in the speaker window, only while a slideshow window is
open (`toggleSpeakerMode` calls `showNotes`, closing calls
`hideNotes`). A `setInterval` polls `slideshowWin.closed` to catch
external closes. `showNotes`/`hideNotes` call `setupCanvas()` because
the sidebar resizes the canvas flex child and the DPR-scaled backing
store must be rebuilt. `#notes-resizer` is a drag handle that writes
`--notes-width` on `<body>`; the canvas `ResizeObserver` picks up the
reflow automatically. A `#notes-toggle` button on the resizer
collapses the panel entirely (`body.notes-collapsed`). The panel also
shows a `#next-preview` thumbnail of the following slide (cloned from
that slide's `<svg>`), hidden on the last slide and in whiteboard
mode.

### Help overlay
`#help-overlay` is a keybinding cheatsheet toggled with `?` (or by
clicking the backdrop). Speaker window only — CSS hides it in the
slideshow window, so `src/ui/help.js` has no role guard.

### Progress indicator
`#progress-indicator` is anchored to the bottom-right of the reference
box (not the canvas-wrap) and shows `current/total`. JS positions it
every redraw. Shown in the speaker window when a slideshow is open
*or* whiteboard mode is on (the whiteboard has a dynamic page count,
so the presenter benefits from seeing it locally too).

### Key input (speaker window only)
`←`/`PgUp` and `→`/`PgDn` navigate, `Home`/`End` jump to first/last,
`D` toggles drawing, `L` toggles laser, `C` toggles cursor mode, `B`
toggles whiteboard, `S` toggles the slideshow window, `F` toggles
freeze, `P` toggles the color and size picker (drawing mode only),
`+`/`-` change stroke size, `Ctrl+Z` undoes the last stroke on the
active page, `?` toggles the help overlay, right-click erases the
nearest stroke within `ERASE_THRESHOLD` (20 CSS px). Fullscreen has
no key — it's on the toolbar. Browser-level F11 fullscreen is
detected via a `display-mode: fullscreen` media query so the toolbar
reflects the state (and disables the button since F11 can't be
exited programmatically).

## Conventions

- Stroke color is chosen via the `P` color picker (6 presets in
  `COLOR_PALETTE` plus a native `<input type="color">` for full RGB).
  Stroke size is picked in the same popover (three preset dots sized
  to match the actual stroke diameter) or with `+`/`-`. Each stored
  stroke carries its own `color` and `width` so later tweaks only
  affect new strokes. A transient `#size-dot` previews the current
  brush at the cursor after a size change.
- Cursor images (`pencil.svg`, `eraser.svg`) are referenced from
  `style.css` with fixed hotspots — keep filenames stable.
  `cursor.svg` is a toolbar icon (not a cursor), shown on the cursor-
  mode button.
- DPR handling: canvases are sized `cssWidth * dpr` with
  `ctx.scale(dpr, dpr)` so all drawing code works in CSS pixels.
- There is no persistence — strokes (both slide and whiteboard) and
  runtime-loaded decks live in memory for the session only.

## TODO file

`TODO` tracks planned work (currently: speaker-mode timer, notes
overlay mode, documentation tasks). Consult it before proposing large
new features — they may already be listed there with context.
