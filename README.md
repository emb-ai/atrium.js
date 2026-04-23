# atrium.js

A presentation tool that runs in a browser. Key features:

- Supports loading slides as a PDF or a bunch of SVGs
- Tools: freehand drawing, laser pointer
- Speaker mode with notes, next slide preview and synced second window for slideshow
- Whiteboard mode with its own stack of blank pages
- Simple usage via static serving
- 100\% vibe coded

## [Demo](https://emb-ai.github.io/atrium.js/)


## Usage

Serve repository content statically with any HTTP server or service.
To seek in embedded videos it should also supports `Range` requests.
Simple server included. Run it and open <http://localhost:8000/>.

```sh
./serve.py
```

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

Embedded `<video>` elements inside SVG `foreignObject` are supported and kept
in sync with the slideshow window.

## Keybindings

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
