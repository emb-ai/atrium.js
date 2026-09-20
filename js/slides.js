// Deck lifecycle: the initial SVG preload, user-picked decks (multi-SVG or
// single PDF), and the mirror-side rebuild when the speaker broadcasts a new
// deck. Owns the `slides` NodeList so the rest of the app reads it through
// getSlides() and automatically picks up reassignments on deck change.

import { showLoading, updateLoading, hideLoading } from './ui/loading.js';
import { setCurrentSlide, setSlidesData } from './state.js';
import { broadcastDeck, SLIDESHOW_AWAITS_DECK } from './sync/speaker.js';

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
// SVG path. Each page is rasterized to a canvas, kept as a PNG Blob, and
// wrapped at display time in a tiny SVG whose viewBox matches the page's PDF
// units — that's what getReferenceBox() keys off for stroke normalization.
//
// Scale is derived from a target output width in pixels rather than being a
// fixed multiple of the page's own units, because those units vary wildly by
// producer: PowerPoint's 16:9 page is 960pt wide, Beamer's is 453pt. A
// constant multiplier therefore over-renders some decks and leaves others too
// soft for a 4K projector. The audience display is unknown at import time (the
// slideshow window may not exist yet), so target 4K and cap the multiplier so
// unusually small page boxes don't blow up render time and memory.
const PDFJS_BASE = new URL('./pdfjs/', import.meta.url).href;
const PDF_TARGET_WIDTH_PX = 3840;
const PDF_MAX_SCALE = 8;
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
  const sources = [];
  for (let i = 1; i <= doc.numPages; i++) {
    updateLoading(`Rendering PDF ${i}/${doc.numPages}`);
    const page = await doc.getPage(i);
    const pageWidthPt = page.view[2] - page.view[0];
    const scale = Math.min(PDF_MAX_SCALE, PDF_TARGET_WIDTH_PX / pageWidthPt);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      console.error(`Failed to rasterize PDF page ${i}`);
      continue;
    }
    sources.push({
      name: `${file.name}#${i}`,
      imageBlob: blob,
      width: page.view[2] - page.view[0],
      height: page.view[3] - page.view[1],
    });
  }
  return sources;
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
