/**
 * pagetype.js — Journey stage label for a URL.
 *
 * Shared by the audit runners, the CSV renderer and the re-render helper so a page
 * always carries the same page_type regardless of which entry point produced it.
 */

function pageTypeOf(url) {
  let u;
  try { u = new URL(url); } catch { return 'other'; }
  const p = u.pathname, h = u.hash, q = u.search;

  if (h.includes('/cart')) return 'cart';
  if (h.includes('/email')) return 'checkout-email';
  if (h.includes('/profile')) return 'checkout-profile';
  if (h.includes('/shipping')) return 'checkout-shipping';
  if (h.includes('/payment')) return 'checkout-payment';
  if (h.includes('/orderPlaced')) return 'checkout-confirmation';
  if (h.includes('/orderform')) return 'checkout-orderform';
  if (p.startsWith('/account/login') || p.startsWith('/login')) return 'login';
  if (p === '/checkout/' || p === '/checkout') return 'checkout';
  if (/(_q=|map=ft)/.test(q) || /^\/busca/.test(p)) return 'search';
  if (/\/p$/.test(p)) return 'pdp';
  if (p === '/' || p === '') return 'homepage';
  return 'other';
}

module.exports = { pageTypeOf };
