// components/share-canvas.js — Savvey share-canvas module v1.0
//
// Wave 107c — third extracted ES module. Owns ALL canvas drawing code
// for the share overlays:
//
//   1. drawCard(sc) — result-share card (640×820 PNG with verdict pips,
//      saving headline, wit quote, brand chrome). Fired by openShareCard.
//
//   2. drawSavingsCard(total, count) — savings-counter share card.
//      Fired by shareSavingsCounter.
//
// All internal helpers (rr, roundRect, wrapText, wrapTextLines,
// guessProductEmoji, savingsCongratLine, fmtSavingsTotal) live here too.
// fmtSavingsTotal is exported because savingsShareText() in the main
// script still uses it.
//
// Caller in index.html (openShareCard / shareSavingsCounter) is now a
// thin shim that calls window.SavveyShareCanvas.drawCard(sc) etc.
// witLine and liveQuery references are passed via sc — caller pre-resolves
// before calling so the module has zero global dependencies.

// ── Helpers ──────────────────────────────────────────────────

// Rounded-rect path. Used by drawCard for badges/chips/CTA strip.
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// arcTo-based rounded rect — drawSavingsCard uses this variant.
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Word-wrap with line cap and ellipsis if truncated.
function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? (cur + ' ' + w) : w;
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length >= maxLines - 1) break;
    } else {
      cur = test;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const consumed = lines.join(' ');
  if (consumed.replace(/\s+/g, '').length < text.replace(/\s+/g, '').length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*\S*$/, '') + '…';
  }
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((ln, i) => ctx.fillText(ln, x, startY + i * lineHeight));
}

// Returns wrapped lines without drawing — drawSavingsCard wants the array.
function wrapTextLines(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let cur = '';
  words.forEach((w) => {
    const tryLine = cur ? (cur + ' ' + w) : w;
    if (ctx.measureText(tryLine).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = tryLine;
    }
  });
  if (cur) lines.push(cur);
  return lines;
}

// Picks a category emoji from the product name. Generic shopping bag if
// nothing matches — keeps the card visually consistent.
function guessProductEmoji(q) {
  const s = String(q || '').toLowerCase();
  if (/airpod|headphone|wh-1000|earbud|bose|soundbar|jbl|galaxy buds/.test(s)) return '🎧';
  if (/iphone|samsung galaxy|pixel|android|smartphone/.test(s)) return '📱';
  if (/ipad|tablet|kindle|fire tv stick/.test(s)) return '📲';
  if (/macbook|laptop|chromebook|surface/.test(s)) return '💻';
  if (/tv\b|qled|oled tv|samsung tv|lg tv|sony tv/.test(s)) return '📺';
  if (/switch|playstation|ps5|xbox|nintendo|console/.test(s)) return '🎮';
  if (/dyson|vacuum|hoover|shark/.test(s)) return '🌪️';
  if (/coffee|nespresso|kettle|toaster|microwave|air fryer|ninja foodi|instant pot/.test(s)) return '🍳';
  if (/fridge|freezer|washing machine|dishwasher/.test(s)) return '🏠';
  if (/echo|alexa|google home|nest|smart speaker/.test(s)) return '🔊';
  if (/camera|gopro|canon|nikon|sony alpha/.test(s)) return '📷';
  if (/watch|fitbit|garmin|apple watch/.test(s)) return '⌚';
  if (/ring\b|doorbell|hue|smart bulb/.test(s)) return '💡';
  if (/lego|playmobil|barbie|toy/.test(s)) return '🧸';
  if (/perfume|lipstick|skincare|moisturiser/.test(s)) return '💄';
  if (/baby|pram|stroller|nappy|nappies/.test(s)) return '👶';
  return '🛒';
}

// Honest, branded congrat copy by milestone. Used by drawSavingsCard.
function savingsCongratLine(total, count) {
  if (total < 0.5) return 'Still calibrating — every check tightens the read on what\'s a fair UK price.';
  if (total < 10)  return 'First few quid tucked in. The rest comes from never paying full sticker again.';
  if (total < 50)  return 'A round of pints, on Savvey. Keep checking — these add up.';
  if (total < 150) return 'A weekly food shop\'s worth of difference, just by checking before you tap buy.';
  if (total < 500) return 'A long weekend away — paid for by stuff you would\'ve overpaid on anyway.';
  if (total < 1500) return 'A laptop\'s worth of savvy. You\'re running this app well.';
  return 'Frankly, you\'re writing the playbook now. UK retail RRP is a suggestion, not a verdict.';
}

// Format the savings total — pence precision under £100, comma group above.
export function fmtSavingsTotal(v) {
  return v < 100 ? v.toFixed(2) : Math.round(v).toLocaleString('en-GB');
}

// ── Result-share card ────────────────────────────────────────
//
// Caller (openShareCard in index.html) pre-resolves sc.witLine + sc.query
// and ensures fonts.ready before invoking. Module assumes the canvas
// element exists and the input scenario is well-formed.
export function drawCard(sc) {
  const canvas = document.getElementById('share-canvas');
  if (!canvas || !sc) return;
  const ctx = canvas.getContext('2d');
  const W = 640, H = 820;
  canvas.width = W; canvas.height = H;

  const verdictCol = sc.spc === 'red' ? '#e03535' : sc.spc === 'amber' ? '#d4820a' : '#2a6b22';
  const verdictLt  = sc.spc === 'red' ? '#fff1f1' : sc.spc === 'amber' ? '#fff8ec' : '#edfae9';
  const verdictBd  = sc.spc === 'red' ? '#fac8c8' : sc.spc === 'amber' ? '#fce0a8' : '#c2e8bb';
  const brand = '#2a6b22';

  // Verdict emoji per state — matches the dry, witty brand voice.
  const verdictEmoji =
    sc.score === 1 ? '🚨' :
    sc.score === 2 ? '⚠️' :
    sc.score === 3 ? '👀' :
    sc.score === 4 ? '👍' :
    sc.score === 5 ? '✅' : '🛒';

  // ── Background ──
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);

  // ── Green brand header bar ──
  ctx.fillStyle = brand; ctx.fillRect(0, 0, W, 96);

  // S badge
  ctx.fillStyle = 'rgba(255,255,255,0.18)'; rr(ctx, 32, 20, 56, 56, 13); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = '900 36px "Nunito","Inter",Arial,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('S', 60, 48);

  // SAVVEY wordmark — final Y in amber for brand pop
  ctx.font = '900 28px "Nunito","Inter",Arial,sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText('SAVVE', 108, 40);
  const savveWidth = ctx.measureText('SAVVE').width;
  ctx.fillStyle = '#f5b742';
  ctx.fillText('Y', 108 + savveWidth, 40);

  // shop smart. — brighter on dark green for legibility
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = '600 14px "Nunito","Inter",Arial,sans-serif';
  ctx.fillText('shop smart.', 109, 63);

  // savvey.app top right
  ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '600 13px "Nunito","Inter",Arial,sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText('savvey.app', W - 32, 48);

  // ── Verdict colour band with emoji ──
  ctx.fillStyle = verdictLt; ctx.fillRect(0, 96, W, 96);
  ctx.fillStyle = verdictBd; ctx.fillRect(0, 191, W, 1.5);

  // Emoji on the left of the band
  ctx.font = '700 38px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Nunito","Inter",Arial,sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(verdictEmoji, 32, 144);

  // Verdict label + title (centred, after emoji space)
  ctx.fillStyle = verdictCol;
  ctx.font = '700 11px "Nunito","Inter",Arial,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('SAVE SCORE', W / 2, 124);
  ctx.font = '900 28px "Nunito","Inter",Arial,sans-serif';
  ctx.fillText(sc.vTitle || 'Result', W / 2, 160);

  // Score chip on the right of the band ("4 / 5")
  if (sc.score) {
    const chipX = W - 100, chipY = 144, chipW = 64, chipH = 32;
    ctx.fillStyle = verdictCol; rr(ctx, chipX - chipW / 2, chipY - chipH / 2, chipW, chipH, 16); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '900 16px "Nunito","Inter",Arial,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(sc.score + ' / 5', chipX, chipY + 1);
  }

  // ── Pips row ──
  const pipY = 246, pipR = 26, pipGap = 68;
  const pipStartX = W / 2 - (2 * pipGap);
  for (let i = 1; i <= 5; i++) {
    const px = pipStartX + (i - 1) * pipGap;
    ctx.beginPath(); ctx.arc(px, pipY, pipR, 0, Math.PI * 2);
    if (i === sc.score) {
      ctx.fillStyle = verdictCol; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '900 20px "Nunito","Inter",Arial,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(i, px, pipY);
    } else if (i < sc.score) {
      ctx.fillStyle = verdictBd; ctx.fill();
      ctx.fillStyle = verdictCol; ctx.font = '700 17px "Nunito","Inter",Arial,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(i, px, pipY);
    } else {
      ctx.fillStyle = '#f0f1f3'; ctx.fill();
      ctx.fillStyle = '#c8cad0'; ctx.font = '500 16px "Nunito","Inter",Arial,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(i, px, pipY);
    }
  }

  // ── Product line: emoji + name (what they searched) ──
  const productEmoji = guessProductEmoji(sc.query || '');
  const qRaw = (sc.query || 'Product');
  const q = qRaw.length > 30 ? qRaw.slice(0, 28) + '…' : qRaw;
  ctx.fillStyle = '#b0b5be'; ctx.font = '700 11px "Nunito","Inter",Arial,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('YOU SEARCHED FOR', W / 2, 302);
  ctx.fillStyle = '#0f1114';
  ctx.font = '800 24px "Nunito","Inter",Arial,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(productEmoji + '  ' + q, W / 2, 332);

  // ── Big saving / price number ──
  if (sc.spc === 'green') {
    ctx.fillStyle = brand; ctx.font = '900 96px "Nunito","Inter",Arial,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('£' + sc.bestPrice, W / 2, 432);
    ctx.fillStyle = '#3d4148'; ctx.font = '700 18px "Nunito","Inter",Arial,sans-serif';
    ctx.fillText('✓  Best price in the UK · ' + (sc.bestRetailer || 'right here'), W / 2, 492);
  } else {
    ctx.fillStyle = verdictCol; ctx.font = '900 108px "Nunito","Inter",Arial,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('£' + (sc.saving || 0), W / 2, 432);
    ctx.fillStyle = '#3d4148'; ctx.font = '700 18px "Nunito","Inter",Arial,sans-serif';
    ctx.fillText('💸  cheaper at ' + sc.bestRetailer + ' · £' + sc.bestPrice, W / 2, 492);
  }

  // ── AI wit quote ──
  // Caller pre-resolves sc.witLine before calling drawCard. Fallback if
  // somehow absent — non-empty string keeps the card from leaving a hole.
  const wit = sc.witLine || 'Worth a fresh look at the price.';
  ctx.fillStyle = verdictBd; ctx.font = '900 64px Georgia,"Times New Roman",serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('“', 48, 560);
  ctx.fillStyle = '#3d4148'; ctx.font = 'italic 600 16px Georgia,"Times New Roman",serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  wrapText(ctx, wit, W / 2, 568, W - 128, 22, 3);
  ctx.fillStyle = verdictBd; ctx.font = '900 64px Georgia,"Times New Roman",serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText('”', W - 48, 600);

  // ── CTA strip ──
  ctx.fillStyle = brand; rr(ctx, 40, 648, W - 80, 72, 18); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = '900 20px "Nunito","Inter",Arial,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (sc.spc === 'green') {
    ctx.fillText('🎯  Best UK price · savvey.app', W / 2, 684);
  } else {
    ctx.fillText('💰  Save £' + (sc.saving || 0) + ' · savvey.app', W / 2, 684);
  }

  // ── Bottom footer ──
  ctx.fillStyle = '#f5f5f7'; ctx.fillRect(0, H - 72, W, 72);
  ctx.fillStyle = '#b0b5be'; ctx.font = '500 12px "Nunito","Inter",Arial,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('Free · No account needed · UK retailers', W / 2, H - 36);
}

// ── Savings-counter share card ───────────────────────────────
export function drawSavingsCard(total, count) {
  const canvas = document.getElementById('share-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = 640, H = 820;
  canvas.width = W; canvas.height = H;
  const brand = '#2a6b22', amber = '#f5b742';

  // Full-bleed deep-green background with subtle decorative glow top-right
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#2a6b22');
  grad.addColorStop(1, '#1d5019');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  const halo = ctx.createRadialGradient(W * 0.85, H * 0.15, 40, W * 0.85, H * 0.15, 360);
  halo.addColorStop(0, 'rgba(245,183,66,0.32)');
  halo.addColorStop(1, 'rgba(245,183,66,0)');
  ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);

  // Brand wordmark
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 36px "Nunito","Inter",Arial,sans-serif';
  ctx.fillText('SAVVE', 50, 90);
  const sw = ctx.measureText('SAVVE').width;
  ctx.fillStyle = amber;
  ctx.fillText('Y', 50 + sw, 90);
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.font = '500 17px "Nunito","Inter",Arial,sans-serif';
  ctx.fillText('shop smart.', 50, 116);

  // Eyebrow label centred
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.font = '800 14px "Nunito","Inter",Arial,sans-serif';
  ctx.fillText('SAVE SCORE TOTAL', W / 2, 230);

  // Big amount — £ + total
  const totalText = fmtSavingsTotal(total < 0.5 ? 0 : total);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'right';
  ctx.font = '800 64px "Nunito","Inter",Arial,sans-serif';
  ctx.font = '900 130px "Nunito","Inter",Arial,sans-serif';
  const numWidth = ctx.measureText(totalText).width;
  ctx.font = '800 64px "Nunito","Inter",Arial,sans-serif';
  const curWidth = ctx.measureText('£').width;
  const totalWidth = curWidth + 4 + numWidth;
  const startX = (W - totalWidth) / 2;
  ctx.textAlign = 'left';
  ctx.font = '800 64px "Nunito","Inter",Arial,sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText('£', startX, 350);
  ctx.font = '900 130px "Nunito","Inter",Arial,sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(totalText, startX + curWidth + 4, 360);

  // Sub-line — count of checks
  ctx.textAlign = 'center';
  ctx.font = '600 18px "Nunito","Inter",Arial,sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  const subLine = count === 0
    ? 'spotted across your first checks'
    : count === 1
      ? 'spotted across 1 check'
      : `spotted across ${count.toLocaleString('en-GB')} checks`;
  ctx.fillText(subLine, W / 2, 405);

  // Congratulatory line — wrapped over up to 4 lines
  const congrat = savingsCongratLine(total, count);
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 22px Georgia,serif';
  const wrapped = wrapTextLines(ctx, '"' + congrat + '"', W - 110);
  let yLine = 490;
  wrapped.slice(0, 4).forEach((line) => {
    ctx.fillText(line, W / 2, yLine);
    yLine += 32;
  });

  // CTA panel near the bottom
  const panelTop = 660, panelH = 96;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, 50, panelTop, W - 100, panelH, 18);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 18px "Nunito","Inter",Arial,sans-serif';
  ctx.fillText('Try it free — savvey.app', W / 2, panelTop + 38);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '500 14px "Nunito","Inter",Arial,sans-serif';
  ctx.fillText('Scan, snap or paste · UK retailer prices in seconds', W / 2, panelTop + 66);
}

// Bridge for legacy classic-script callers in index.html.
if (typeof window !== 'undefined') {
  window.SavveyShareCanvas = { drawCard, drawSavingsCard, fmtSavingsTotal };
}
