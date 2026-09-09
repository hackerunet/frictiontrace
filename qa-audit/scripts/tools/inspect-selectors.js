#!/usr/bin/env node
/**
 * inspect-selectors.js — Interrogates the live DOM for the two interactive steps the
 * authenticated journey depends on: adding a product on the PDP, and the login form.
 *
 * Reports, per candidate selector, how many nodes match and whether they are visible /
 * enabled / in the viewport, then drives the login past the email step to reveal wha
 * the second factor actually is (password vs emailed access code).
 *
 * Usage: node scripts/inspect-selectors.js --store walmart-cr
 */

const { chromium } = require('playwright');
const { loadEnv } = require('../../lib/env');

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const STORES = require('../../config/stores.json').stores;
const store = STORES.find((s) => s.id === argVal('--store', 'walmart-cr'));
const env = loadEnv();
const base = `https://${store.domain}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = [
  'div[class*="vtex-add-to-cart__pdp"] button',
  'div[class*="vtex-add-to-cart"] button',
  '[class*="add-to-cart"] button',
];

async function report(page, sel) {
  const loc = page.locator(sel);
  const n = await loc.count().catch(() => 0);
  if (!n) { console.log(`   ${sel}  → 0 matches`); return; }
  console.log(`   ${sel}  → ${n} matches`);
  for (let i = 0; i < Math.min(n, 4); i++) {
    const el = loc.nth(i);
    const vis = await el.isVisible().catch(() => false);
    const en = await el.isEnabled().catch(() => false);
    const txt = (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 30);
    const box = await el.boundingBox().catch(() => null);
    console.log(`      [${i}] "${txt}" visible=${vis} enabled=${en} box=${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}` : 'null'}`);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'es-419' });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  // --- PDP ---
  await page.goto(`${base}/pollo?_q=pollo&map=ft`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  const pdp = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a[href]')].map((x) => x.href).filter((h) => /\/p(\?|#|$)/.test(h));
    return a[0] || null;
  });
  console.log(`\n=== PDP ${pdp}`);
  await page.goto(pdp, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await sleep(5000);

  console.log('\n--- candidatos add-to-cart ---');
  for (const sel of CANDIDATES) await report(page, sel);

  console.log('\n--- intento de clic real ---');
  const target = page.locator('div[class*="vtex-add-to-cart__pdp"] button').first();
  if (await target.count().catch(() => 0)) {
    await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch((e) => console.log('   scroll falló:', e.message.split('\n')[0]));
    const r = await target.click({ timeout: 12000 }).then(() => 'OK').catch((e) => 'FALLÓ: ' + e.message.split('\n')[0]);
    console.log('   click →', r);
    await sleep(5000);
    const items = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/checkout/pub/orderForm', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const j = await res.json();
        return (j.items || []).length;
      } catch (e) { return 'error: ' + e.message; }
    });
    console.log('   items en orderForm →', items);
  }

  // --- Login ---
  await page.goto(`${base}/login?returnUrl=/checkout/#/orderform`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await sleep(4000);
  console.log(`\n=== LOGIN ${page.url().slice(0, 80)}`);

  const emailEl = page.locator('#email, input[class*="-x-email"]').first();
  console.log('   email input matches:', await emailEl.count().catch(() => 0));
  await emailEl.fill(env.WALMART_LOGIN).catch((e) => console.log('   fill falló:', e.message.split('\n')[0]));
  await sleep(1000);

  const cont = page.locator('button[class*="btnLogin"], button:has-text("Continuar")').first();
  console.log('   botón Continuar matches:', await cont.count().catch(() => 0));
  const clicked = await cont.click({ timeout: 10000 }).then(() => 'OK').catch((e) => 'FALLÓ: ' + e.message.split('\n')[0]);
  console.log('   click Continuar →', clicked);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await sleep(6000);

  console.log(`\n--- estado tras Continuar (url: ${page.url().slice(0, 80)}) ---`);
  const after = await page.evaluate(() => {
    const vis = (e) => !!e.offsetParent;
    return {
      inputs: [...document.querySelectorAll('input')].filter(vis).map((e) => ({
        type: e.type, name: e.name, id: e.id, ph: e.placeholder,
        cls: (e.className || '').toString().slice(0, 80),
      })),
      buttons: [...document.querySelectorAll('button')].filter(vis)
        .map((e) => ({ txt: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 35), cls: (e.className || '').toString().slice(0, 70) }))
        .filter((b) => b.txt),
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  });
  console.log('   INPUTS visibles:');
  for (const i of after.inputs) console.log(`     type=${i.type} name=${i.name} id=${i.id} ph="${i.ph}" cls=${i.cls}`);
  console.log('   BOTONES visibles:');
  for (const b of after.buttons) console.log(`     "${b.txt}"  cls=${b.cls}`);
  console.log(`   TEXTO: ${after.bodyText.slice(0, 350)}`);

  await browser.close();
  console.log('');
})();
