# atrium.js

A presentation tool that runs in a browser. Key features:

- Supports loading slides as a PDF or a bunch of SVGs
- Tools: freehand drawing, laser pointer
- Speaker mode with notes, next slide preview and synced second window for slideshow
- Whiteboard mode with its own stack of blank pages
- Simple usage via static serving
- 100\% vibe coded

## Usage
### Demo


### Serving

Serve repository content with any HTTP server that supports `Range` requests
(needed for embedded videos to seek correctly). Simple server included:

```sh
./serve.py
```
Then open <http://localhost:8000/>.

### Self-contained web page

List SVGs in `index.html`, or load them at runtime via the toolbar (a
multi-selection of SVGs, or a single PDF):

```html
<div id="slides">
  <div class="slide" data-src="slides/1.svg" data-notes="Intro.&#10;Key goals."></div>
  <div class="slide" data-src="slides/2.svg"></div>
</div>
```

- `data-src` — path to the SVG.
- `data-notes` — optional speaker notes (use `&#10;` for newlines).

Embedded `<video>` elements inside the SVGs are supported and kept in
sync with the slideshow window.

### Keyboard

| Group        | Key              | Action                                                |
| ------------ | ---------------- | ------------------------------------------------------|
| Navigation   | `←` / `PgUp`     | Previous slide                                        |
|              | `→` / `PgDn`     | Next slide                                            |
|              | `Home`           | First slide                                           |
|              | `End`            | Last slide                                            |
| Presentation | `S`              | Toggle speaker mode                                   |
|              | `F`              | Freeze the slideshow window at current slide          |
|              | `B`              | Toggle whiteboard (blank pages)<br>add new page with `→` when current page is non-empty|
|              | `?`              | Toggle keyboard shortcuts cheatsheet                  |
| Tools        | `D`              | Draw                                                  |
|              | `L`              | Laser pointer (short-living trace)                    |
|              | `C`              | Cursor                                                |
| Drawing      | Left mouse       | Draw                                                  |
|              | Right mouse      | Erase nearest stroke                                  |
|              | `P`              | Color & size picker                                   |
|              | `+` / `-`        | Stroke size                                           |
|              | `Ctrl+Z`         | Undo last stroke on current slide                     |
