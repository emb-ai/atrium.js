// Deck lifecycle: the initial SVG preload, user-picked decks (multi-SVG or
// single PDF), and the mirror-side rebuild when the speaker broadcasts a new
// deck. Owns the `slides` NodeList so the rest of the app reads it through
// getSlides() and automatically picks up reassignments on deck change.

import { showLoading, updateLoading, hideLoading } from './ui/loading.js';
import { setCurrentSlide, setSlidesData } from './state.js';
import {
  broadcastDeck,
  getSlideshowScreenWidthPx,
  SLIDESHOW_AWAITS_DECK,
} from './sync/speaker.js';

let slides = document.querySelectorAll('.slide');
let afterDeckChange = () => {};

export function getSlides() {
  return slides;
}

// `onDeckChange` runs after every deck swap (initial preload and later
// rebuilds) so main.js can refresh the active-slide class, resize canvases,
// and re-wire <video> listeners in one place.
export function initSlides({ onDeckChange }) {
  afterDeckChange = onDeckChange;
  setSlidesData(Array.from(slides).map(() => [])); // one empty stroke list per slide
}

function injectSvg(slide, svgText) {
  const svgDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  slide.innerHTML = '';
  slide.appendChild(svgDoc.documentElement);
}

export async function preloadSlides() {
  // A slideshow window whose speaker already has a deck starts empty rather
  // than fetching index.html's demo slides: the deck message is moments away
  // and the demo slides would be the only thing on screen until it lands.
  if (SLIDESHOW_AWAITS_DECK) {
    document.getElementById('slides').innerHTML = '';
    slides = document.querySelectorAll('.slide');
    setSlidesData([]);
    afterDeckChange();
    return;
  }

  const fetchable = [...slides].filter(s => s.dataset.src);
  if (fetchable.length) showLoading('Loading deck');
  const promises = [...slides].map(async (slide, index) => {
    const src = slide.dataset.src;
    if (!src) return;
    try {
      const response = await fetch(src);
      const svgText = await response.text();
      injectSvg(slide, svgText);
    } catch (err) {
      console.error(`Failed to load slide ${index + 1}:`, err);
      slide.textContent = `⚠️ Failed to load ${src}`;
    }
  });
  await Promise.all(promises);
  hideLoading();
  afterDeckChange();
}

// Two accepted inputs from one button: either a multi-selection of SVG files
// (ordinal filenames map to slide order) or a single PDF. PDF pages are
// rasterized and wrapped in minimal SVGs so the existing slide pipeline
// (viewBox-based normalization, broadcasting) works unchanged.
export function pickDeck() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.svg,.pdf,image/svg+xml,application/pdf';
  input.multiple = true;
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    if (files.length) loadDeckFromFiles(files);
  });
  input.click();
}

async function loadDeckFromFiles(files) {
  const pdf = files.find(f => f.name.toLowerCase().endsWith('.pdf'));
  showLoading(pdf ? 'Rendering PDF' : 'Loading deck');
  try {
    const sources = pdf
      ? await sourcesFromPdf(pdf)
      : await sourcesFromSvgs(files);
    if (!sources?.length) return;

    // Broadcast before local rebuild: rebuilding locally triggers a state
    // broadcast (via setSlidesData), and the slideshow needs the new deck in
    // place before it applies that state.
    broadcastDeck(sources);
    rebuildSlidesFromSources(sources);
    // Fresh speaker-side deck load starts at page 1. The slideshow side skips
    // this reset — the `state` message that follows the `deck` message is
    // authoritative, and resetting here would briefly flash slide 0 before
    // the speaker's actual current slide is applied.
    setCurrentSlide(0);
  } finally {
    hideLoading();
  }
}

async function sourcesFromSvgs(files) {
  const svgs = files
    .filter(f => f.name.toLowerCase().endsWith('.svg'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!svgs.length) return [];
  const texts = await Promise.all(svgs.map(f => f.text()));
  return svgs.map((file, i) => ({ name: file.name, svgText: texts[i] }));
}

// pdf.js is loaded on demand so the app stays dependency-free for the common
// SVG path. Each page is rasterized to a canvas, kept as an image Blob, and
// wrapped at display time in a tiny SVG whose viewBox matches the page's PDF
// units — that's what getReferenceBox() keys off for stroke normalization.
//
// Scale is derived from a target output width in pixels rather than being a
// fixed multiple of the page's own units, because those units vary wildly by
// producer: PowerPoint's 16:9 page is 960pt wide, Beamer's is 453pt. A
// constant multiplier therefore over-renders some decks and leaves others too
// soft for a 4K projector. The multiplier is capped so unusually small page
// boxes don't blow up render time and memory.
const PDFJS_BASE = new URL('./pdfjs/', import.meta.url).href;
const PDF_MAX_TARGET_WIDTH_PX = 3840;
const PDF_MIN_TARGET_WIDTH_PX = 1920;
const PDF_MAX_SCALE = 8;
// Encodes allowed to run concurrently with rasterization. Each pending encode
// pins its source canvas — ~33 MB at 4K — so this also bounds the canvas pool.
const PDF_MAX_INFLIGHT_ENCODES = 3;
let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(/* @vite-ignore */ `${PDFJS_BASE}pdf.mjs`).then(mod => {
      mod.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.mjs`;
      return mod;
    });
  }
  return pdfjsPromise;
}

// Pages are shown in both windows, so target whichever screen is larger. Until
// a slideshow window announces itself the audience display is unknown, and
// under-rendering for a projector that connects later can't be undone without
// re-importing the deck — so assume 4K in that case.
function pdfTargetWidthPx() {
  const mirror = getSlideshowScreenWidthPx();
  if (!mirror) return PDF_MAX_TARGET_WIDTH_PX;
  const own = Math.round(screen.width * devicePixelRatio);
  return Math.min(
    PDF_MAX_TARGET_WIDTH_PX,
    Math.max(PDF_MIN_TARGET_WIDTH_PX, own, mirror),
  );
}

// Canvases are recycled across pages: a fresh 4K canvas per page is ~33 MB of
// allocation and GC churn for nothing, and pages in a deck are nearly always
// the same size. No clearing is needed — pdf.js fills the whole canvas with
// the page background before drawing.
function acquireCanvas(pool, width, height) {
  const canvas = pool.pop() || document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// PNG, despite the size: measured on 4K pages, Chrome's PNG encoder beats
// both WebP (3-15x slower, lossy at any quality below 1) and JPEG on typical
// slide content, and it's the only lossless option that stays fast. WebP only
// wins on bytes, and bytes aren't the bottleneck — Blobs move between windows
// by handle, not by copy.
function encodeCanvas(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function sourcesFromPdf(file) {
  let pdfjs;
  try {
    pdfjs = await loadPdfJs();
  } catch (err) {
    console.error('Failed to load pdf.js', err);
    return [];
  }
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const targetWidthPx = pdfTargetWidthPx();
  const sources = new Array(doc.numPages);
  const canvasPool = [];
  const inflight = new Set();
  // Page fetches are pipelined: the worker parses page i+1 while the main
  // thread rasterizes page i.
  let nextPage = doc.getPage(1);
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      updateLoading(`Rendering PDF ${i}/${doc.numPages}`);
      const page = await nextPage;
      nextPage = i < doc.numPages ? doc.getPage(i + 1) : null;

      const widthPt = page.view[2] - page.view[0];
      const heightPt = page.view[3] - page.view[1];
      const scale = Math.min(PDF_MAX_SCALE, targetWidthPx / widthPt);
      const viewport = page.getViewport({ scale });

      // Wait for a canvas to come back from the pool before starting the next
      // page, so memory stays bounded no matter how long the deck is.
      if (inflight.size >= PDF_MAX_INFLIGHT_ENCODES) await Promise.race(inflight);
      const canvas = acquireCanvas(
        canvasPool,
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      page.cleanup();

      // Deliberately not awaited: the browser encodes off the main thread, so
      // letting it overlap the next page's rasterization is close to free.
      const encode = encodeCanvas(canvas).then(blob => {
        canvasPool.push(canvas);
        inflight.delete(encode);
        if (!blob) {
          console.error(`Failed to rasterize PDF page ${i}`);
          return;
        }
        sources[i - 1] = {
          name: `${file.name}#${i}`,
          imageBlob: blob,
          width: widthPt,
          height: heightPt,
        };
      });
      inflight.add(encode);
    }
    await Promise.all(inflight);
  } finally {
    doc.destroy();
  }
  return sources.filter(Boolean);
}

// Object URLs minted for the deck currently in the DOM. Revoked on the next
// rebuild, once the nodes referencing them have been discarded.
let deckObjectUrls = [];

function releaseDeckObjectUrls() {
  deckObjectUrls.forEach(url => URL.revokeObjectURL(url));
  deckObjectUrls = [];
}

// A source carries either raw SVG text (SVG and HTML decks) or a rasterized
// page image (PDF decks). Page images travel as Blobs rather than base64 data
// URLs on purpose: a Blob structured-clones to the slideshow window as a
// handle with no byte copy, and it keeps this SVG wrapper small enough that
// the DOMParser in injectSvg stays cheap. Inlining a multi-megabyte data URI
// made both costs scale with deck size and froze the slideshow window for
// seconds on every deck change.
function svgTextForSource(src) {
  if (src.svgText != null) return src.svgText;
  const url = URL.createObjectURL(src.imageBlob);
  deckObjectUrls.push(url);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `viewBox="0 0 ${src.width} ${src.height}" preserveAspectRatio="xMidYMid meet">` +
    `<image href="${url}" xlink:href="${url}" width="${src.width}" height="${src.height}"/>` +
    `</svg>`
  );
}

// Also used on the slideshow side when a 'deck' message arrives, so the
// mirror can rebuild its #slides container to match the speaker's.
export function rebuildSlidesFromSources(sources) {
  const container = document.getElementById('slides');
  container.innerHTML = '';
  releaseDeckObjectUrls();
  sources.forEach(src => {
    const div = document.createElement('div');
    div.className = 'slide';
    div.dataset.src = src.name;
    injectSvg(div, svgTextForSource(src));
    container.appendChild(div);
  });

  slides = document.querySelectorAll('.slide');
  setSlidesData(Array.from(slides).map(() => [])); // emits 'strokes' → redraw + toolbar sync
  afterDeckChange();
}
