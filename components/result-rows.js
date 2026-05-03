// components/result-rows.js — Savvey result-rows module v1.0
//
// Wave 107d — fourth extracted ES module. Owns per-retailer row
// rendering on the results screen. Replaces the previous
// `list.innerHTML = items.map(...)` template-string approach with a
// safer pattern recommended by external review:
//
//   • createElement + textContent for retailer name + sub-line
//     (zero string-injection surface — works even if a retailer name
//      contains an apostrophe, e.g. "Sainsbury's")
//   • addEventListener instead of inline onclick (no global handler
//     dependency, listener scope is the module)
//   • DocumentFragment so all rows are appended in a single layout
//     pass instead of N reflows
//
// Caller provides the callback for click. The module never reaches
// into window for handlers. Brand-rail colour is still data-driven by
// the data-brand attribute (CSS owns the colour, the module just sets
// the attribute). Callers compute brandKey + subLine and pass the
// pre-resolved item objects so the module is data-shape agnostic.

const escAttr = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;');

// items: [{ name, brandKey, sub, price, diff, isBest, isHigh, link }]
// onRowClick(name, link): callback fired on row tap.
// Returns a DocumentFragment ready to appendChild.
export function renderRetailerList(items, onRowClick) {
  const fragment = document.createDocumentFragment();
  if (!Array.isArray(items)) return fragment;

  items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'ret-row' + (item.isBest ? ' best' : '');
    if (item.brandKey) row.setAttribute('data-brand', item.brandKey);
    // Wave 75 — staggered animation. Cap delay at 280ms so late rows
    // don't feel laggy.
    const delay = Math.min(idx * 40, 280);
    row.style.animationDelay = delay + 'ms';

    // ── Left side: name + sub + best-price badge ──
    const nameWrap = document.createElement('div');
    nameWrap.className = 'ret-name-wrap';

    const nameEl = document.createElement('div');
    nameEl.className = 'ret-name';
    nameEl.textContent = item.name || '';   // safe — no innerHTML
    nameWrap.appendChild(nameEl);

    const subEl = document.createElement('div');
    subEl.className = 'ret-sub';
    subEl.textContent = item.sub || '';
    nameWrap.appendChild(subEl);

    if (item.isBest) {
      const badge = document.createElement('div');
      badge.className = 'ret-best-badge';
      badge.textContent = '✓ Best price';
      nameWrap.appendChild(badge);
    }

    row.appendChild(nameWrap);

    // ── Right side: price + diff ──
    const right = document.createElement('div');
    right.style.textAlign = 'right';

    const priceEl = document.createElement('div');
    priceEl.className = 'ret-price ' + (item.isBest ? 'best' : item.isHigh ? 'high' : 'mid');
    priceEl.textContent = item.price || '';
    right.appendChild(priceEl);

    if (item.diff) {
      const diffEl = document.createElement('div');
      diffEl.className = 'ret-diff' + (item.isHigh ? ' over' : '');
      diffEl.textContent = item.diff;
      right.appendChild(diffEl);
    }

    row.appendChild(right);

    // ── Click handler — module-scoped, no inline JS ──
    row.addEventListener('click', () => {
      if (typeof onRowClick === 'function') onRowClick(item.name, item.link);
    });

    fragment.appendChild(row);
  });

  return fragment;
}

// Bridge for legacy classic-script callers.
if (typeof window !== 'undefined') {
  window.SavveyResultRows = { renderRetailerList };
}
