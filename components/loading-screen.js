// components/loading-screen.js — Savvey loading-screen module v1.0
//
// Wave 107 — first extracted ES module. The loading-screen logic was
// previously scattered across 4 sites in index.html (start, two resets,
// teardown). Now it's one module with two exports: start() and stop().
//
// Why this is the canary component (per Gemini architectural advice):
//  • One entry — fetchPrices() calls start() when a search begins.
//  • One exit — processSearchResponse() / globalReset() / errors call stop().
//  • No shared state — owns its own chipTimers + currentGen internally.
//  • Visual-only failure — if this module fails to load, search still works,
//    user just sees a less-animated loading screen.
//
// Bridge pattern: the module also assigns window.SavveyLoader so the
// classic <script> tag in index.html that has all the inline event
// handlers can call start/stop without the rest of the file becoming
// a module too. ES module → window-bridge → classic caller.

let chipTimers = [];
let currentGen = 0;
const PILL_COUNT = 16;

export function start({ query, generation }) {
  stop();
  currentGen = generation;

  const productEl = document.getElementById('searching-product');
  if (productEl && query) productEl.textContent = query;

  // Wave 61 — counter copy resets each search, then pill timers update it
  // with the live retailer name being checked.
  const counterEl = document.getElementById('srch-counter-num');
  if (counterEl) counterEl.textContent = 'Sweeping prices…';

  // Force the progress ring's CSS keyframe to restart by toggling animation
  // off + reflow + on. Without this it runs only on first mount.
  const ringEl = document.querySelector('.srch-ring-progress');
  if (ringEl) {
    ringEl.style.animation = 'none';
    void ringEl.offsetWidth;
    ringEl.style.animation = '';
  }

  // Wave 27 — pills cycle pending → lit → done. Random shuffle so it
  // doesn't feel mechanical. Wave 61 — 90ms apart × 16 = 1.44s so
  // animation feels alive end-to-end even when results land in 1-2s.
  const pillOrder = Array.from({ length: PILL_COUNT }, (_, i) => i);
  for (let i = pillOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pillOrder[i], pillOrder[j]] = [pillOrder[j], pillOrder[i]];
  }

  const myGen = generation;
  pillOrder.forEach((rcIndex, position) => {
    const litAt = 100 + position * 90;
    const doneAt = litAt + 480;
    chipTimers.push(setTimeout(() => {
      if (currentGen !== myGen) return;
      const c = document.getElementById('rc-' + rcIndex);
      if (!c) return;
      c.classList.add('lit');
      const cnt = document.getElementById('srch-counter-num');
      const logo = c.querySelector('.srch-brand-logo');
      if (cnt && logo) cnt.textContent = 'Checking ' + logo.textContent;
    }, litAt));
    chipTimers.push(setTimeout(() => {
      if (currentGen !== myGen) return;
      const c = document.getElementById('rc-' + rcIndex);
      if (c) { c.classList.remove('lit'); c.classList.add('done'); }
    }, doneAt));
  });
}

// Cancel all pending pill animations + reset DOM state to the at-rest
// pre-search look. Called on globalReset(), search completion, and at the
// top of every new start().
export function stop() {
  chipTimers.forEach(clearTimeout);
  chipTimers = [];
}

// Full teardown — also wipes lit/done classes off pill DOM so the next
// search starts from a clean visual state, not whatever the previous
// one left behind. Called by globalReset().
export function reset() {
  stop();
  for (let i = 0; i < PILL_COUNT; i++) {
    const c = document.getElementById('rc-' + i);
    if (c) { c.classList.remove('lit'); c.classList.remove('done'); }
  }
  const counterEl = document.getElementById('srch-counter-num');
  if (counterEl) counterEl.textContent = 'Sweeping prices…';
}

// Wave 107 bridge — the rest of index.html is still a classic <script>
// tag. Expose the module's API on window so it can call us without
// importing. Once the rest of the file is modularised this assignment
// can go away.
if (typeof window !== 'undefined') {
  window.SavveyLoader = { start, stop, reset };
}
