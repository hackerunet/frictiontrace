#!/usr/bin/env node
/**
 * inspect-modal.js — Compares the delivery-location modal across storefronts.
 *
 * The modal clears on CR and GT but persists on HN and SV even after every select is
 * answered, which blocks every later click. This dumps its structure per store, then
 * fills the selects and reports what the accept button looks like afterwards.
 *
 * One page load per store.
 *
 * Usage: node scripts/inspect-modal.js --stores walmart-hn,walmart-sv,walmart-cr
 */

const { chromium } = require('playwright');
const J = require('../../lib/journey');

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const STORES = require('../../config/stores.json').stores;
const ids = argVal('--stores', 'walmart-hn,walmart-sv,walmart-cr').split(',').map((x) => x.trim());
const selected = STORES.filter((s) => ids.includes(s.id));

const DUMP = () => {
  const ov = [...document.querySelectorAll('div[class*="modal__overlay"]')]
    .find((e) => getComputedStyle(e).position === 'fixed');
  if (!ov) return { none: true };
  const vis = (e) => !!e.offsetParent;
  return {
    selects: [...ov.querySelectorAll('select')].map((s) => ({
      cls: (s.className || '').toString().slice(0, 40),
      value: s.value,
      selectedText: s.options[s.selectedIndex] ? s.options[s.selectedIndex].text.trim() : '',
      count: s.options.length,
      first3: [...s.options].slice(0, 3).map((o) => o.text.trim()),
    })),
    buttons: [...ov.querySelectorAll('button')].filter(vis).map((b) => ({
      txt: (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30),
      disabled: b.disabled,
      cls: (b.className || '').toString().slice(0, 70),
      ariaDisabled: b.getAttribute('aria-disabled'),
    })),
    inputs: [...ov.querySelectorAll('input')].filter(vis).map((i) => ({ type: i.type, ph: i.placeholder, cls: (i.className || '').toString().slice(0, 50) })),
    text: (ov.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 220),
  };
};

(async () => {
  const browser = await chromium.launch({ headless: true });

  for (const store of selected) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'es-419' });
    const page = await ctx.newPage();
    console.log(`\n${'='.repeat(70)}\n🏬 ${store.label} (${store.country}) — ${store.domain}`);
    try {
      await page.goto(`https://${store.domain}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
      await J.sleep(5000);

      const before = await page.evaluate(DUMP);
      if (before.none) { console.log('   (sin modal bloqueante)'); await ctx.close(); continue; }
      console.log(`   texto: ${before.text.slice(0, 150)}`);
      console.log(`   selects: ${before.selects.length}  botones: ${before.buttons.length}  inputs: ${before.inputs.length}`);
      for (const b of before.buttons) console.log(`     botón "${b.txt}" disabled=${b.disabled} aria-disabled=${b.ariaDisabled}`);
      for (const i of before.inputs) console.log(`     input type=${i.type} ph="${i.ph}" cls=${i.cls}`);

      console.log(`   --- completando la cascada ---`);
      const res = await J.selectDeliveryLocation(page);
      console.log(`   resultado: ${res}`);

      const after = await page.evaluate(DUMP);
      if (after.none) { console.log('   ✅ overlay despejado'); await ctx.close(); continue; }
      console.log(`   ❌ overlay sigue presente:`);
      after.selects.forEach((s, i) => console.log(`     select[${i}] cls=${s.cls} value="${s.value}" texto="${s.selectedText}" opciones=${s.count}`));
      for (const b of after.buttons) console.log(`     botón "${b.txt}" disabled=${b.disabled} aria-disabled=${b.ariaDisabled} cls=${b.cls}`);
      for (const i of after.inputs) console.log(`     input type=${i.type} ph="${i.ph}" cls=${i.cls}`);
      console.log(`     texto: ${after.text.slice(0, 200)}`);
    } catch (e) {
      console.log(`   ERROR: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
  }

  await browser.close();
  console.log('');
})();
