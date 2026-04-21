// The color + size picker popover: six preset swatches, a native
// <input type="color"> fallback for custom colors, and three preset
// size dots that render at their actual stroke diameter.
//
// Self-subscribes to the 'style' state event so swatch/size selection
// indicators stay in lockstep with the store. Open/close is driven by
// `body.color-picker-open` so CSS owns the visibility transition.

import { on, strokeColor, setStrokeColor, lineWidth, setLineWidth } from './state.js';

const HIDE_DELAY_MS = 700;
const COLOR_PALETTE = ['#168afe', '#dc2626', '#16a34a', '#f59e0b', '#a855f7', '#ffffff', '#000000'];
// Size presets shown as three dots in the picker. Each dot renders at its
// actual stroke diameter so the button is a preview of the result.
const LINE_WIDTH_PRESETS = [3, 5, 9];

const colorPicker     = document.getElementById('color-picker');
const swatchContainer = colorPicker.querySelector('.cp-swatches');
const colorInput      = colorPicker.querySelector('.cp-input');
const customWrap      = colorPicker.querySelector('.cp-custom');
const sizeContainer   = colorPicker.querySelector('.cp-sizes');

let hideTimer = null;
// `hideArmed` tracks whether the auto-hide countdown has been started
// (i.e. the user selected something). Mouseleave only (re)starts the
// countdown if it was already armed — so merely hovering and leaving
// without a selection doesn't auto-dismiss the picker.
let hideArmed = false;
let hovered = false;

export function buildColorPicker() {
  COLOR_PALETTE.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cp-swatch';
    b.style.setProperty('--c', c);
    b.dataset.color = c;
    b.setAttribute('aria-label', `Color ${c}`);
    b.addEventListener('click', () => selectColor(c));
    swatchContainer.appendChild(b);
  });
  colorInput.value = strokeColor;
  colorInput.addEventListener('input', e => selectColor(e.target.value));

  LINE_WIDTH_PRESETS.forEach(w => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cp-size';
    b.dataset.size = String(w);
    b.setAttribute('aria-label', `Stroke size ${w}`);
    const dot = document.createElement('span');
    dot.className = 'cp-size-dot';
    dot.style.width = w + 'px';
    dot.style.height = w + 'px';
    b.appendChild(dot);
    b.addEventListener('click', () => selectSize(w));
    sizeContainer.appendChild(b);
  });

  // Hovering the picker pauses the auto-hide countdown; leaving it restarts
  // it (but only if a color was selected, i.e. auto-hide was armed).
  colorPicker.addEventListener('mouseenter', () => {
    hovered = true;
    clearTimeout(hideTimer);
    hideTimer = null;
  });
  colorPicker.addEventListener('mouseleave', () => {
    hovered = false;
    if (hideArmed) scheduleHide();
  });

  on('style', syncSelection);
  syncSelection();
}

function syncSelection() {
  const isPreset = COLOR_PALETTE.includes(strokeColor);
  swatchContainer.querySelectorAll('.cp-swatch').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.color === strokeColor);
  });
  customWrap.classList.toggle('selected', !isPreset);
  if (!isPreset) colorInput.value = strokeColor;

  // Size dots inherit the current stroke color so each button previews
  // exactly what that preset will draw.
  sizeContainer.querySelectorAll('.cp-size').forEach(btn => {
    btn.classList.toggle('selected', Number(btn.dataset.size) === lineWidth);
    const dot = btn.querySelector('.cp-size-dot');
    if (dot) dot.style.setProperty('--dot', strokeColor);
  });
}

function selectColor(c) {
  setStrokeColor(c);
  scheduleHide();
}

function selectSize(w) {
  setLineWidth(w);
  scheduleHide();
}

function scheduleHide() {
  hideArmed = true;
  // Pause the countdown while the mouse is over the picker; mouseleave will
  // re-invoke this to start it.
  if (hovered) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    closeColorPicker();
  }, HIDE_DELAY_MS);
}

export function isColorPickerOpen() {
  return document.body.classList.contains('color-picker-open');
}

export function openColorPicker() {
  hideArmed = false;
  document.body.classList.add('color-picker-open');
  colorPicker.setAttribute('aria-hidden', 'false');
}

export function closeColorPicker() {
  clearTimeout(hideTimer);
  hideTimer = null;
  hideArmed = false;
  document.body.classList.remove('color-picker-open');
  colorPicker.setAttribute('aria-hidden', 'true');
}

export function toggleColorPicker() {
  if (isColorPickerOpen()) closeColorPicker();
  else openColorPicker();
}
