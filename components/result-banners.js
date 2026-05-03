// components/result-banners.js — Savvey result-banner module v1.0
//
// Wave 107b — second extracted ES module. Owns the two mutually-exclusive
// "explainer banners" that sit above the hero verdict card:
//
//   1. Snap-generic banner (Wave 38): "We couldn't lock onto a specific
//      model" — shown when the Snap mode resolved to a generic category
//      rather than a specific product.
//
//   2. Top-picks banner (Wave 102): "Top picks for X" — shown when the
//      Wave 100 fan-out fired and the retailer rows are for DIFFERENT
//      products in the category, not the same product.
//
// They share CSS class .snap-generic-banner so the visual treatment is
// consistent. They're mutually exclusive — at most one can render at a
// time. Module always removes any existing banner before deciding what
// to render so call-sites don't have to manage cleanup.

const escapeHtml = (s) =>
  String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

const SVG_INFO   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>';
const SVG_STAR   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l2.39 6.96L22 10l-5.5 4.74L18 22l-6-3.5L6 22l1.5-7.26L2 10l7.61-1.04L12 2z"/></svg>';

// Render the appropriate banner for this scenario state. Always removes
// any prior banner first. Returns the banner element rendered, or null.
export function render(heroCardEl, sc) {
  if (!heroCardEl) return null;

  // Always clean — both banner classes are removed before we decide
  // which (if any) to add. Belt-and-braces: the .top-picks-banner
  // selector also matches snap-generic-banner since they share class,
  // but explicit removal of both is harmless and defensive.
  const existing1 = heroCardEl.querySelector('.snap-generic-banner');
  if (existing1) existing1.remove();
  const existing2 = heroCardEl.querySelector('.top-picks-banner');
  if (existing2) existing2.remove();

  if (!sc) return null;

  // Snap generic-match banner takes precedence when both could fire
  // (rare — would mean Snap mode + category fan-out, but defensive).
  if (sc.snapMatch && sc.snapMatch.isGenericMatch) {
    const banner = document.createElement('div');
    banner.className = 'snap-generic-banner';
    const product = escapeHtml(sc.snapMatch.cleanedProduct || sc.query || 'this product');
    banner.innerHTML =
      SVG_INFO +
      '<div class="snap-generic-text">' +
        '<div class="snap-generic-title">Generic match</div>' +
        '<div class="snap-generic-sub">We couldn\'t lock onto a specific model. Comparing <strong>' + product + '</strong> against similar UK products.</div>' +
      '</div>';
    heroCardEl.insertBefore(banner, heroCardEl.firstChild);
    return banner;
  }

  if (Array.isArray(sc.categoryProducts) && sc.categoryProducts.length > 0) {
    const banner = document.createElement('div');
    banner.className = 'snap-generic-banner top-picks-banner';
    const safeQuery = escapeHtml(sc.query || (typeof window !== 'undefined' && window.liveQuery) || 'this category');
    const lis = sc.categoryProducts
      .slice(0, 3)
      .map((p) => '<li>' + escapeHtml(p) + '</li>')
      .join('');
    banner.innerHTML =
      SVG_STAR +
      '<div class="snap-generic-text">' +
        '<div class="snap-generic-title">Top picks for ' + safeQuery + '</div>' +
        '<div class="snap-generic-sub">Different popular UK products in this category — prices below are for these specific items, not the same product across retailers.</div>' +
        '<ul class="top-picks-list" style="margin:8px 0 0;padding:0 0 0 18px;font-size:13px;line-height:1.5;">' + lis + '</ul>' +
      '</div>';
    heroCardEl.insertBefore(banner, heroCardEl.firstChild);
    return banner;
  }

  return null;
}

// Remove any active banner. Used when transitioning out of a result
// state (e.g. globalReset()). Render() also removes before drawing so
// this is rarely needed externally.
export function clear(heroCardEl) {
  if (!heroCardEl) return;
  const b1 = heroCardEl.querySelector('.snap-generic-banner');
  if (b1) b1.remove();
  const b2 = heroCardEl.querySelector('.top-picks-banner');
  if (b2) b2.remove();
}

// Bridge for legacy classic-script callers in index.html.
if (typeof window !== 'undefined') {
  window.SavveyResultBanners = { render, clear };
}
