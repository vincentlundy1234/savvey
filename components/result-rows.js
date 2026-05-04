// components/result-rows.js — Savvey result-rows module v2.0
// v2.9 panel-locked deep-link upgrade:
//  - Renders <a target="_top" rel="external"> for HTTPS links so iOS/Android
//    intercept Amazon/eBay native-app deep links cleanly.
//  - Static 3-word verification badges (no tooltip — panel cut).
//  - "Wrong product?" link → user_flagged_error PostHog event.

const RETAILER_KEY = (n = '') => {
  const s = String(n).toLowerCase();
  if (/amazon/.test(s)) return 'amazon';
  if (/argos/.test(s)) return 'argos';
  if (/john\s*lewis/.test(s)) return 'johnlewis';
  if (/currys/.test(s)) return 'currys';
  if (/tesco/.test(s)) return 'tesco';
  if (/sainsbury/.test(s)) return 'sainsburys';
  if (/very/.test(s)) return 'very';
  if (/^ao\b|appliances\s*direct/.test(s)) return 'ao';
  if (/screwfix/.test(s)) return 'screwfix';
  if (/toolstation/.test(s)) return 'toolstation';
  if (/b\s*&\s*q|diy\.com/.test(s)) return 'bq';
  if (/wickes/.test(s)) return 'wickes';
  if (/lakeland/.test(s)) return 'lakeland';
  if (/ebay/.test(s)) return 'ebay';
  return s.split(/\s+/)[0] || 'unknown';
};

const isHttpsLink = (link) => typeof link === 'string' && /^https:\/\//i.test(link.trim());

function badgeForItem(item) {
  if (!item.badgeKind) return null;
  if (item.badgeKind === 'unconfirmed') return { label: '⟳ Price Unconfirmed', cls: 'badge-unconfirmed' };
  if (item.badgeKind === 'variant') {
    const r = item.variantReason;
    if (r === 'kit')  return { label: '⚠ Kit Variant',     cls: 'badge-variant' };
    if (r === 'tier') return { label: '⚠ Different Tier', cls: 'badge-variant' };
    if (r === 'year') return { label: '⚠ Older Model',    cls: 'badge-variant' };
    return                  { label: '⚠ Variant Match',    cls: 'badge-variant' };
  }
  if (item.badgeKind === 'exact') return { label: '✓ Exact Match', cls: 'badge-exact' };
  return null;
}

export function renderRetailerList(items, onRowClick) {
  const fragment = document.createDocumentFragment();
  if (!Array.isArray(items)) return fragment;

  items.forEach((item, idx) => {
    const link = item.link || '';
    const useAnchor = isHttpsLink(link);
    const row = document.createElement(useAnchor ? 'a' : 'div');
    row.className = 'ret-row' + (item.isBest ? ' best' : '');
    if (item.brandKey) row.setAttribute('data-brand', item.brandKey);

    if (useAnchor) {
      row.setAttribute('href', link);
      row.setAttribute('target', '_top');
      row.setAttribute('rel', 'external noopener');
      row.setAttribute('data-retailer', RETAILER_KEY(item.name || ''));
      row.setAttribute('data-price', String(item.priceNumeric != null ? item.priceNumeric : ''));
      row.setAttribute('data-best',  item.isBest ? '1' : '0');
      row.setAttribute('data-asin',  item.asin || '');
      row.style.textDecoration = 'none';
      row.style.color = 'inherit';
      row.style.display = 'flex';
    }

    row.style.animationDelay = Math.min(idx * 40, 280) + 'ms';

    const nameWrap = document.createElement('div');
    nameWrap.className = 'ret-name-wrap';

    const nameEl = document.createElement('div');
    nameEl.className = 'ret-name';
    nameEl.textContent = item.name || '';
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

    const vbadge = badgeForItem(item);
    if (vbadge) {
      const b = document.createElement('span');
      b.className = 'ret-verify-badge ' + vbadge.cls;
      b.textContent = vbadge.label;
      nameWrap.appendChild(b);
    }

    if (item.inStock === true) {
      const sb = document.createElement('span');
      sb.className = 'stock-badge in';
      sb.textContent = 'In stock';
      nameWrap.appendChild(sb);
    } else if (item.inStock === false) {
      const sb = document.createElement('span');
      sb.className = 'stock-badge out';
      sb.textContent = 'Out of stock';
      nameWrap.appendChild(sb);
    }

    row.appendChild(nameWrap);

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

    if (!useAnchor) {
      row.addEventListener('click', () => {
        if (typeof onRowClick === 'function') onRowClick(item.name, item.link);
      });
    }

    fragment.appendChild(row);

    const fbWrap = document.createElement('div');
    fbWrap.className = 'ret-feedback';
    const fbBtn = document.createElement('button');
    fbBtn.type = 'button';
    fbBtn.className = 'ret-feedback-btn';
    fbBtn.textContent = 'Wrong product?';
    fbBtn.setAttribute('data-feedback-row', RETAILER_KEY(item.name || ''));
    fbBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (window.posthog && typeof window.posthog.capture === 'function') {
          const v = window._lastVisionResult || {};
          window.posthog.capture('user_flagged_error', {
            reason: 'wrong_product',
            retailer: RETAILER_KEY(item.name || ''),
            price_shown: item.priceNumeric != null ? item.priceNumeric : null,
            parsed_brand: v.brand || null,
            parsed_product: ((v.family || '') + ' ' + (v.model || '')).trim() || null,
          });
        }
      } catch (_) { /* never block UI */ }
      fbBtn.textContent = 'Thanks — noted';
      fbBtn.disabled = true;
      fbBtn.classList.add('thanks');
    });
    fbWrap.appendChild(fbBtn);
    fragment.appendChild(fbWrap);
  });

  return fragment;
}

if (typeof window !== 'undefined') {
  window.SavveyResultRows = { renderRetailerList };
}
