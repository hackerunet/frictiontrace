#!/usr/bin/env node
/**
 * inspect-orderform.js — Reads VTEX's own checkout state at the shipping step.
 *
 * The shipping → payment gate hides `#btn-go-to-payment` behind a generic "Hay un error
 * de validación" while marking no field invalid, so the DOM says nothing useful about
 * what is missing. `vtexjs.checkout.orderForm` is what the checkout app itself decides
 * on — reading it turns guesswork into a diff.
 *
 * Read-only: the orderForm object is already in the page, so this adds no request. One
 * product is added to reach the step, exactly as the audit does. No order is placed.
 *
 * Usage: node scripts/tools/inspect-orderform.js --stores maxipali-cr [--headed]
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const J = require('../../lib/journey');
const { loadEnv } = require('../../lib/env');

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const HEADED = args.includes('--headed');

const STORES = require('../../config/stores.json').stores;
const store = STORES.find((s) => s.id === argVal('--stores', 'maxipali-cr'));
if (!store) { console.error('tienda desconocida'); process.exit(1); }

const env = loadEnv();
const OUT = path.resolve(argVal('--out', `/tmp/orderform-${store.id}.json`));

const TZ = { GT: 'America/Guatemala', CR: 'America/Costa_Rica', SV: 'America/El_Salvador',
  HN: 'America/Tegucigalpa', NI: 'America/Managua' };

/** The orderForm as the checkout app sees it, however this storefront exposes it. */
const READ_ORDERFORM = `(() => {
  try { if (window.vtexjs && vtexjs.checkout && vtexjs.checkout.orderForm) return vtexjs.checkout.orderForm; } catch (e) {}
  try { if (window.__RUNTIME__ && window.__RUNTIME__.orderForm) return window.__RUNTIME__.orderForm; } catch (e) {}
  return null;
})()`;

(async () => {
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: HEADED ? null : { width: 1366, height: 768 },
    locale: 'es-419',
    timezoneId: TZ[store.country] || 'America/Guatemala',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    geolocation: J.GEO_BY_COUNTRY[store.country],
    permissions: ['geolocation'],
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const base = `https://${store.domain}`;
  const log = (...a) => console.log('  ', ...a);

  console.log(`\n🔎 ${store.label} — leyendo el orderForm en el paso de envío\n`);

  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await J.acceptCookies(page);
  log('ubicación:', await J.selectDeliveryLocation(page, 4, store.country));

  await page.goto(`${base}/pollo?_q=pollo&map=ft`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  const pdps = await J.findPdpUrls(page);
  if (!pdps.length) { console.error('sin PDP'); process.exit(1); }
  await page.goto(pdps[0], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await J.clickResilient(page, J.ADD_TO_CART, J.ADD_TO_CART_TEXT);
  await J.sleep(6000);
  log('carrito:', await J.cartItemCount(page), 'ítem(s)');

  await page.goto(`${base}/login?returnUrl=/checkout/#/orderform`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await J.login(page, env.WALMART_LOGIN, env.WALMART_PASS, 25000);
  log('sesión:', await J.isLoggedIn(page));

  await page.goto(`${base}/checkout/#/cart`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});

  const DUMP_INPUTS = `Array.from(document.querySelectorAll('input,select,textarea'))
    .filter((e) => e.offsetParent !== null)
    .map((e) => ({ tag: e.tagName.toLowerCase(), id: e.id || null, name: e.name || null,
      type: e.type || null, placeholder: e.placeholder || null,
      label: (document.querySelector('label[for="' + e.id + '"]') || {}).textContent || null,
      value: (e.value || '').slice(0, 24) }))`;

  const profile = J.profileFor(store.country);
  await page.evaluate(() => { window.location.hash = '#/profile'; });
  await J.sleep(4000);
  const profileInputs = await page.evaluate(DUMP_INPUTS);
  console.log('\n────────── campos del paso PERFIL ──────────');
  for (const i of profileInputs) {
    console.log('  ' + String(i.id || i.name || '(sin id)').padEnd(28) + String(i.type).padEnd(10)
      + (i.label || i.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 40));
  }
  log('perfil:', await J.completeProfile(page, profile));
  await J.sleep(3000);

  const shipInputs = await page.evaluate(DUMP_INPUTS);
  console.log('\n────────── campos del paso ENVÍO ──────────');
  for (const i of shipInputs) {
    console.log('  ' + String(i.id || i.name || '(sin id)').padEnd(28) + String(i.type).padEnd(10)
      + (i.label || i.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 40));
  }
  // Filled inputs that never reach the orderForm mean the form was never committed,
  // so the control that commits it is what matters. List every button in play.
  const shipButtons = await page.evaluate(`Array.from(document.querySelectorAll('button,a[role="button"],input[type="submit"]'))
    .filter((e) => e.offsetParent !== null)
    .map((e) => ({ id: e.id || null, cls: (e.className || '').toString().slice(0, 40),
      text: (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      disabled: !!e.disabled }))`);
  console.log('\n────────── botones visibles en ENVÍO ──────────');
  for (const b of shipButtons) {
    console.log('  ' + String(b.id || '(sin id)').padEnd(24) + (b.disabled ? '[disabled] ' : '[activo]   ') + b.text);
  }
  // Nicaragua replaces the address selects with a geo picker behind
  // #geo-delivery-cta-btn. Open it and report what it renders.
  if (args.includes('--geo')) {
    console.log('\n────────── diálogo de dirección geo ──────────');
    const cta = page.locator('#geo-delivery-cta-btn').first();
    console.log('  cta presente:', await cta.count().catch(() => 0));
    await cta.click({ timeout: 8000 }).catch((e) => console.log('  clic falló:', e.message.split('\n')[0]));
    await J.sleep(5000);
    const inside = await page.evaluate(`(() => {
      const vis = (e) => e.offsetParent !== null;
      return {
        inputs: Array.from(document.querySelectorAll('input,select,textarea')).filter(vis)
          .map((e) => (e.id || e.name || '(sin id)') + ' [' + (e.type || e.tagName) + '] '
            + (e.placeholder || '').slice(0, 30)),
        buttons: Array.from(document.querySelectorAll('button,a[role="button"]')).filter(vis)
          .map((e) => (e.id || '(sin id)') + (e.disabled ? ' [disabled] ' : ' [activo] ')
            + (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 38)),
      };
    })()`);
    console.log('  --- campos ---');
    for (const x of inside.inputs) console.log('    ' + x);
    console.log('  --- botones ---');
    for (const x of inside.buttons) console.log('    ' + x);
  }
  const before = await page.evaluate(READ_ORDERFORM);

  // Experiment: the dump above finds btn-go-to-payment present, visible and enabled on
  // arrival. If clicking it straight away reaches #/payment, then the form-filling that
  // follows is not a prerequisite but the thing that breaks it.
  // Walks the shipping step one action at a time, reporting the state of
  // btn-go-to-payment after each. The button is present and enabled on arrival and
  // absent once completeShipping has run, so the question is which action removes it.
  if (args.includes('--trace-gate')) {
    const state = async (tag) => {
      const st = await page.evaluate(`(() => {
        const b = document.querySelector('#btn-go-to-payment');
        return { existe: !!b, visible: b ? b.offsetParent !== null : false,
                 hab: b ? !b.disabled : false, hash: location.hash };
      })()`);
      console.log('  ' + tag.padEnd(26) + 'existe=' + (st.existe ? 'sí' : 'NO ')
        + ' visible=' + (st.visible ? 'sí' : 'NO ') + ' hab=' + (st.hab ? 'sí' : 'NO ') + '  ' + st.hash);
      return st;
    };
    const click = async (sel) => page.locator(sel).first()
      .click({ timeout: 8000 }).then(() => true).catch(() => false);

    console.log('\n────────── qué acción esconde el botón ──────────');
    await state('0. al llegar');
    await click('#shipping-option-delivery'); await J.sleep(3000);
    await state('1. canal domicilio');
    for (const sel of ['#ship-state', '#ship-city', '#ship-neighborhood']) {
      const el = page.locator(sel).first();
      if (await el.count().catch(() => 0) && !(await el.inputValue().catch(() => ''))) {
        await el.selectOption({ index: 1 }, { timeout: 8000 }).catch(() => {});
        await J.sleep(2000);
      }
    }
    await state('2. selects de ubicación');
    await page.locator('#ship-street').first().fill(profile.street, { timeout: 8000 }).catch(() => {});
    await page.locator('#ship-receiverName').first()
      .fill(profile.firstName + ' ' + profile.lastName, { timeout: 8000 }).catch(() => {});
    await J.sleep(3000);
    await state('3. calle + receptor');
    const map = await J.confirmLocationOnMap(page, profile);
    await J.sleep(2000);
    await state('4. mapa (' + String(map).slice(0, 18) + ')');
    const date = await J.selectDeliveryDate(page);
    await J.sleep(2000);
    await state('5. fecha (' + String(date).slice(0, 18) + ')');
    await click('#btn-go-to-payment'); await J.sleep(6000);
    await state('6. clic en ir al pago');
  } else if (args.includes('--minimal')) {
    const btn = page.locator('#btn-go-to-payment').first();
    console.log('\n────────── intento directo ──────────');
    console.log('  existe:', await btn.count().catch(() => 0),
      '· visible:', await btn.isVisible().catch(() => false),
      '· habilitado:', await btn.isEnabled().catch(() => false));
    await btn.click({ timeout: 10000 }).catch((e) => console.log('  click falló:', e.message.split('\n')[0]));
    await J.sleep(6000);
    console.log('  hash tras el clic:', await page.evaluate(() => location.hash));
  } else {
    log('envío:', String(await J.completeShipping(page, profile)).split('|')[0].trim());
  }
  const after = await page.evaluate(READ_ORDERFORM);

  const snap = { store: store.id, url: page.url(), capturedAt: new Date().toISOString(), before, after };
  fs.writeFileSync(OUT, JSON.stringify(snap, null, 2));

  // --- What the checkout app itself says is wrong ---------------------------
  const of = after || before;
  console.log('\n────────── orderForm ──────────');
  if (!of) {
    console.log('  no se pudo leer (ni vtexjs ni __RUNTIME__)');
  } else {
    const sd = of.shippingData || {};
    const li = (sd.logisticsInfo || [])[0] || {};
    console.log('  orderFormId       :', of.orderFormId);
    console.log('  canAddOrder/allowed:', of.canEditData, '/', of.allowManualPrice);
    console.log('  items             :', (of.items || []).length);
    console.log('  clientProfileData :', Object.entries(of.clientProfileData || {})
      .filter(([k, v]) => v == null || v === '').map(([k]) => k).join(', ') || 'completo');
    console.log('  address           :', JSON.stringify(sd.address || null));
    console.log('  selectedAddresses :', (sd.selectedAddresses || []).length);
    console.log('  deliveryChannel   :', li.selectedDeliveryChannel, '· sla:', li.selectedSla);
    console.log('  slas disponibles  :', (li.slas || []).map((s) => s.id).join(' | ') || 'ninguno');
    console.log('  logisticsInfo n   :', (sd.logisticsInfo || []).length);
    console.log('  marketingData     :', JSON.stringify(of.marketingData || null));
    console.log('  messages          :');
    for (const m of (of.messages || [])) console.log('     -', m.status, '·', m.code, '·', (m.text || '').slice(0, 120));
    if (!(of.messages || []).length) console.log('     (ninguno)');
    // Address completeness is the usual culprit: VTEX refuses to advance when a field
    // its country rules require is null, without flagging it in the DOM.
    const a = sd.address || {};
    const empty = Object.entries(a).filter(([k, v]) => v === null || v === '').map(([k]) => k);
    console.log('  campos vacíos en address:', empty.join(', ') || 'ninguno');
  }
  console.log(`\n💾 ${OUT}\n`);

  await context.close().catch(() => {});
  await browser.close();
  process.exit(0);
})();
