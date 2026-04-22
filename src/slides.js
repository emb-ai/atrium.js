// Deck lifecycle: the initial SVG preload, user-picked decks (multi-SVG or
// single PDF), and the mirror-side rebuild when the speaker broadcasts a new
// deck. Owns the `slides` NodeList so the rest of the app reads it through
// getSlides() and automatically picks up reassignments on deck change.

import { showLoading, updateLoading, hideLoading } from './ui/loading.js';
import { setCurrentSlide, setSlidesData } from './state.js';
import { broadcastDeck } from './sync/speaker.js';

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

// pdf.js is loaded on demand from vendor/ so the app stays dependency-free for
// the common SVG path. Each page is rendered to a canvas at PDF_RENDER_SCALE
// (relative to PDF's native 72dpi) then embedded as a PNG inside a tiny SVG
// wrapper whose viewBox matches the page's PDF units — that's what
// getReferenceBox() keys off for stroke normalization. Higher scale = crisper
// on large displays at the cost of upfront render time and broadcast payload.
const PDFJS_BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
const PDF_RENDER_SCALE = 6;
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
    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const png = canvas.toDataURL('image/png');
    const w = page.view[2] - page.view[0];
    const h = page.view[3] - page.view[1];
    const svgText =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">` +
      `<image href="${png}" xlink:href="${png}" width="${w}" height="${h}"/>` +
      `</svg>`;
    sources.push({ name: `${file.name}#${i}`, svgText });
  }
  return sources;
}

// Also used on the slideshow side when a 'deck' message arrives, so the
// mirror can rebuild its #slides container to match the speaker's.
export function rebuildSlidesFromSources(sources) {
  const container = document.getElementById('slides');
  container.innerHTML = '';
  sources.forEach(src => {
    const div = document.createElement('div');
    div.className = 'slide';
    div.dataset.src = src.name;
    injectSvg(div, src.svgText);
    container.appendChild(div);
  });

  slides = document.querySelectorAll('.slide');
  setCurrentSlide(0);
  setSlidesData(Array.from(slides).map(() => [])); // emits 'strokes' → redraw + toolbar sync
  afterDeckChange();
}
