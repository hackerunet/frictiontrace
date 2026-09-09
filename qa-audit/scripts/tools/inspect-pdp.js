#!/usr/bin/env node
/**
 * inspect-pdp.js — Why does a PDP offer no add-to-cart control?
 *
 * Walks search → PDP with the delivery location resolved, then reports what the page
 * actually shows: availability wording, price, seller, and every visible button. Run i
 * on a store that works and one that does not to isolate the cause.
 *
 * Usage: node scripts/inspect-pdp.js --stores walmart-cr,masxmenos-cr
 */

const { chromium } = require('playwright');
const J = require('../../lib/journey');

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const STORES = require('../../config/stores.json').stores;
const ids = argVal('--stores', 'walmart-cr,masxmenos-cr').split(',').map((x) => x.trim());
const selected = STORES.filter((s) => ids.includes(s.id));

const DUMP = () => {
  const vis = (e) => !!e.offsetParent;
  const txt = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
  const grab = (re) => { const m = txt.match(re); return m ? m[0] : null; };
  return {
    title: document.title.slice(0, 60),
    unavailable: /no disponible|agotado|sin stock|fuera de stock|no hay stock|indisponible/i.test(txt),
    notifyMe: /avísame|avisame|notif[ií]came/i.test(txt),
    price: grab(/[₡$Q L]\s?[\d.,]{2,12}/),
    buttons: [...document.querySelectorAll('button')].filter(vis)
      .map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean).slice(0, 14),
    addToCartNodes: document.querySelectorAll('[class*="add-to-cart"], [class*="addToCart"]').length,
    buyButtonNodes: document.querySelectorAll('[class*="buy-button"], [class*="buyButton"]').length,
    snippet: txt.slice(0, 260),
  };
};

(async () => {
  const browser = await chromium.launch({ headless: true });

  for (const store of selected) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'es-419' });
    const page = await ctx.newPage();
    console.log(`\n${'='.repeat(72)}\n🏬 ${store.label} — ${store.domain}`);
    try {
      await page.goto(`https://${store.domain}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
      await J.acceptCookies(page);
      console.log('   ubicación:', await J.selectDeliveryLocation(page, 4, store.country));

      await page.goto(`https://${store.domain}/pollo?_q=pollo&map=ft`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
      const urls = await J.findPdpUrls(page, 3);
      console.log(`   productos hallados: ${urls.length}`);

      for (const u of urls.slice(0, 2)) {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
        await J.selectDeliveryLocation(page, 2, store.country);
        await J.sleep(4000);
        const d = await page.evaluate(DUMP);
        console.log(`\n   ── ${u.split('/').slice(-2)[0].slice(0, 55)}`);
        console.log(`      agotado=${d.unavailable}  avisarme=${d.notifyMe}  precio=${d.price}`);
        console.log(`      nodos add-to-cart=${d.addToCartNodes}  buy-button=${d.buyButtonNodes}`);
        console.log(`      botones: ${d.buttons.join(' | ').slice(0, 170)}`);
        console.log(`      texto: ${d.snippet.slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`   ERROR: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
  }

  await browser.close();
  console.log('');
})();
