/**
 * journey.js — Interaction primitives for the CAM storefronts.
 *
 * Every selector here was read off the live DOM (see scripts/inspect-selectors.js),
 * not guessed. The two non-obvious gates these handle:
 *
 *  1. A mandatory delivery-location modal opens on first visit, covering the page a
 *     z-index 10000. It has no close button and ignores Escape and outside clicks, so
 *     it must be completed — otherwise every click times out while the target still
 *     reports visible and enabled.
 *  2. Login is a Walmart-specific two-step component, not the stock VTEX ID form:
 *     email → Continuar → password → Continuar.
 */

/**
 * Deliberate waiting, accounted for.
 *
 * Every sleep here is the script being cautious, not the storefront being slow. Because
 * a step's duration is measured around the whole action, those pauses were landing
 * inside the published figure: the profile step read 4.0s on all thirteen storefronts
 * because 4.0s of it was this function. A number no real site could produce that
 * consistently was the giveaway.
 *
 * The total is accumulated so the capture can subtract it, giving a page time that
 * belongs to the page. `navigationTimeMs` keeps its original meaning — padding included
 * — so the July and August series stay comparable with each other.
 */
let padMs = 0;
const sleep = (ms) => { padMs += ms; return new Promise((r) => setTimeout(r, ms)); };

/** Reads the deliberate-wait total accumulated since the last call, and clears it. */
function takePad() { const v = padMs; padMs = 0; return v; }

/**
 * Waits for a real signal instead of the clock, falling back to a bounded pause.
 *
 * Only the fallback counts as padding: when the predicate resolves, the time spent is
 * the page actually doing the work, which is what we set out to measure.
 */
async function settle(page, predicate, { timeout = 8000, fallback = 1500 } = {}) {
  try {
    await page.waitForFunction(predicate, null, { timeout, polling: 200 });
    return true;
  } catch {
    await sleep(fallback);
    return false;
  }
}

const OVERLAY_SEL = 'div[class*="modal__overlay"]';

// The PDP button lives inside `vtex-add-to-cart__pdp`; scoping to that container
// avoids the identical "Agregar" buttons in the sponsored-product carousels.
const ADD_TO_CART = [
  'div[class*="vtex-add-to-cart__pdp"] button',
  'div[class*="vtex-add-to-cart"] button',
  'button.vtex-add-to-cart-button-0-x-buttonText',
  '[class*="add-to-cart"] button',
  'button[class*="addToCart"]',
];
const ADD_TO_CART_TEXT = ['Agregar', 'Añadir', 'Add to cart', 'Comprar'];

/**
 * Add-to-cart button by accessible name.
 *
 * Deliberately a substring match, not an exact one: the label is not consistent across
 * storefronts — Walmart CR renders "Agregar", Walmart HN renders "+ Agregar". Anchoring
 * to `^Agregar$` silently skipped every product on the stores that use the prefixed
 * form, which looked exactly like an out-of-stock catalogue.
 *
 * The negative lookahead keeps wishlist controls ("Agregar a mi lista") out.
 */
const ADD_TO_CART_RE = /(?:agregar|añadir|add to cart)(?!\s*a\s*(?:mi\s*)?lista)/i;

function addToCartButton(page) {
  return page.getByRole('button', { name: ADD_TO_CART_RE }).first();
}

const EMAIL_INPUTS = [
  'input[class*="-x-email"]',
  '#email',
  'input[name="email"]',
  'input[type="email"]',
  'input[placeholder*="mail" i]',
];
const PASS_INPUTS = [
  'input[class*="-x-password"]',
  'input[type="password"]',
  'input[name="password"]',
  '#password',
];
const CONTINUE_BUTTONS = [
  'button[class*="btnLogin"]',
  'button:has-text("Continuar")',
  'button[type="submit"]',
  'button:has-text("Entrar")',
  'button:has-text("Ingresar")',
];
const COOKIE_ACCEPT = [
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  'button[id*="CookiebotDialogBodyButtonAccept"]',
];

async function clickFirst(page, selectors, timeout = 8000) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
      if (await el.click({ timeout }).then(() => true).catch(() => false)) return sel;
    }
  }
  return null;
}

async function fillFirst(page, selectors, value) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
      if (await el.fill(value, { timeout: 8000 }).then(() => true).catch(() => false)) return sel;
    }
  }
  return null;
}

/** Clicks through a residual overlay if one somehow survived dismissal. */
async function clickResilient(page, selectors, textFallbacks = []) {
  const via = await clickFirst(page, selectors);
  if (via) return via;
  if (textFallbacks.length) {
    const el = addToCartButton(page);
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
      if (await el.click({ timeout: 6000 }).then(() => true).catch(() => false)) return 'texto:agregar';
      if (await el.click({ timeout: 6000, force: true }).then(() => true).catch(() => false)) return 'texto:agregar (force)';
    }
  }
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
      if (await el.click({ timeout: 6000, force: true }).then(() => true).catch(() => false)) return sel + ' (force)';
    }
  }
  return null;
}

async function acceptCookies(page) {
  for (const sel of COOKIE_ACCEPT) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
      if (await el.isDisabled().catch(() => false)) continue;
      if (await el.click({ timeout: 5000 }).then(() => true).catch(() => false)) return sel;
    }
  }
  return null;
}

/** True when a fixed, page-covering overlay is still swallowing pointer events. */
async function overlayBlocking(page) {
  return page.evaluate((sel) => [...document.querySelectorAll(sel)].some((e) => {
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden' || s.pointerEvents === 'none') return false;
    if (s.position !== 'fixed') return false;
    const b = e.getBoundingClientRect();
    return b.width > innerWidth * 0.5 && b.height > innerHeight * 0.4;
  }), OVERLAY_SEL).catch(() => false);
}

/**
 * Confirms the location modal.
 *
 * The label is not stable across countries: CR and GT render "Aceptar" on a delivery
 * address picker, while HN and SV render "Buscar tienda" on a store finder. Matching
 * on text left HN and SV blocked with the button sitting there enabled. So: prefer a
 * known label, but fall back to whatever single button in the overlay is enabled.
 */
async function confirmLocationModal(page) {
  const overlay = page.locator(OVERLAY_SEL).first();
  const labelled = page.locator(
    `${OVERLAY_SEL} button:has-text("Aceptar"), ${OVERLAY_SEL} button:has-text("Buscar tienda"), ` +
    `${OVERLAY_SEL} button:has-text("Confirmar"), ${OVERLAY_SEL} button:has-text("Continuar"), ` +
    `${OVERLAY_SEL} button:has-text("Guardar")`
  ).first();

  if (await labelled.count().catch(() => 0) && !(await labelled.isDisabled().catch(() => true))) {
    if (await labelled.click({ timeout: 8000 }).then(() => true).catch(() => false)) return true;
  }

  const buttons = overlay.locator('button');
  const n = await buttons.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    if (!(await b.isVisible().catch(() => false))) continue;
    if (await b.isDisabled().catch(() => true)) continue;
    if (await b.click({ timeout: 6000 }).then(() => true).catch(() => false)) return true;
  }
  return false;
}

/**
 * HN and SV run a two-stage modal: pick a location, press "Buscar tienda", then choose
 * one of the suggested stores before "Aceptar" enables. The store options are radios
 * styled with `opacity:0` over a custom control, so they are checked with force —
 * a plain click lands on the invisible input and does nothing.
 */
async function pickStoreFromResults(page) {
  const radios = page.locator(`${OVERLAY_SEL} input[type="radio"]`);
  const n = await radios.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const r = radios.nth(i);
    const ok = await r.check({ timeout: 5000, force: true }).then(() => true).catch(() => false);
    if (ok && await r.isChecked().catch(() => false)) { await sleep(2000); return true; }
  }

  // Fallback for storefronts that render the options as buttons or list rows.
  const rows = page.locator(`${OVERLAY_SEL} li button, ${OVERLAY_SEL} [class*="store"] button`);
  const m = await rows.count().catch(() => 0);
  for (let i = 0; i < m; i++) {
    const el = rows.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    if (await el.click({ timeout: 5000 }).then(() => true).catch(() => false)) { await sleep(2000); return true; }
  }
  return false;
}

/**
 * Completes the blocking location modal by taking the first real option of each
 * select. The number of levels varies by country (three in CR/SV, two in HN), and
 * choosing one level can reveal another, so this re-scans and retries until the
 * overlay actually clears rather than assuming a fixed shape.
 */
async function selectDeliveryLocation(page, rounds = 4, country = null) {
  if (!(await overlayBlocking(page))) return 'sin modal';

  const preferred = MAJOR_LOCATIONS[country] || [];

  /**
   * Picks the metropolitan option when the modal offers one, falling back to the
   * first real entry. Taking whatever came first alphabetically landed us in
   * Ahuachapan (SV) and La Ceiba (HN) — regional stores that carry none of the
   * searched catalogue, so no product ever showed an add-to-cart button.
   */
  async function chooseOption(sel) {
    const opts = await sel.locator('option').allInnerTexts().catch(() => []);
    if (opts.length <= 1) return null;
    for (const re of preferred) {
      const idx = opts.findIndex((t, i) => i > 0 && re.test(t.trim()));
      if (idx > 0) {
        if (await sel.selectOption({ index: idx }, { timeout: 8000 }).then(() => true).catch(() => false)) {
          return opts[idx].trim();
        }
      }
    }
    if (await sel.selectOption({ index: 1 }, { timeout: 8000 }).then(() => true).catch(() => false)) {
      return opts[1].trim();
    }
    return null;
  }

  const chosen = [];
  for (let round = 0; round < rounds; round++) {
    const selects = page.locator(`${OVERLAY_SEL} select`);
    const n = await selects.count().catch(() => 0);
    if (!n) break;

    let progressed = false;
    for (let i = 0; i < n; i++) {
      const sel = selects.nth(i);
      // Skip levels already answered.
      const current = await sel.inputValue().catch(() => '');
      if (current && current !== '' && current !== '0') continue;

      for (let attempt = 0; attempt < 12; attempt++) {
        if (await sel.locator('option').count().catch(() => 0) > 1) break;
        await sleep(600); // the previous choice is still populating this one
      }
      const picked = await chooseOption(sel);
      if (!picked) continue;
      chosen.push(picked);
      progressed = true;
      await sleep(1800);
    }

    if (await confirmLocationModal(page)) await sleep(3500);
    if (!(await overlayBlocking(page))) break;

    // A store finder may now be showing results that still need one to be chosen.
    if (await pickStoreFromResults(page)) {
      await confirmLocationModal(page);
      await sleep(3000);
    }
    if (!(await overlayBlocking(page))) break;
    if (!progressed) await sleep(1500);
  }

  const stillBlocked = await overlayBlocking(page);
  return `${chosen.join(' / ') || 'sin selección'}${stillBlocked ? ' — ⚠ overlay persiste' : ''}`;
}

/**
 * Product-detail links on a search page, in order; scrolls to trigger lazy grids.
 *
 * Several are returned because availability is per store: the selected location may
 * not stock the first result, and VTEX then renders no add-to-cart button at all.
 */
async function findPdpUrls(page, limit = 6) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const urls = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href]')].map((x) => x.href).filter((h) => /\/p(\?|#|$)/.test(h));
      return [...new Set(links)];
    }).catch(() => []);
    if (urls.length) return urls.slice(0, limit);
    await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
    await sleep(2000);
  }
  return [];
}

/** Backwards-compatible single-result helper. */
async function findPdpUrl(page) {
  return (await findPdpUrls(page, 1))[0] || null;
}

/**
 * True when this PDP is offering an add-to-cart control at all.
 *
 * Must check the button text as well as the class names: Más x Menos renders a working
 * "Agregar" button with no `add-to-cart` class anywhere on the page. Gating only on the
 * class made every product look unpurchasable and skipped the click entirely, which
 * looked like an out-of-stock catalogue but was a selector gap.
 */
async function hasAddToCart(page) {
  for (const sel of ADD_TO_CART) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) return true;
  }
  const byText = addToCartButton(page);
  if (await byText.count().catch(() => 0) && await byText.isVisible().catch(() => false)) return true;
  return false;
}

/**
 * Authoritative auth check via VTEX ID's own endpoint. Sniffing header text is
 * unreliable — "Mis pedidos" renders for anonymous visitors too and produced false
 * positives.
 */
async function isLoggedIn(page) {
  return page.evaluate(async () => {
    try {
      const r = await fetch('/api/vtexid/pub/authenticated/user', { credentials: 'include' });
      if (!r.ok) return false;
      const j = await r.json();
      return !!(j && (j.user || j.userId));
    } catch { return false; }
  }).catch(() => false);
}

/** Number of items currently in the session's orderForm, or -1 if unreadable. */
async function cartItemCount(page) {
  return page.evaluate(async () => {
    try {
      const r = await fetch('/api/checkout/pub/orderForm', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const j = await r.json();
      return (j.items || []).length;
    } catch { return -1; }
  }).catch(() => -1);
}

/** Two-step login: email → Continuar → password → Continuar. */
async function login(page, email, password, settleTimeout = 25000) {
  await acceptCookies(page);
  await selectDeliveryLocation(page);

  if (!(await fillFirst(page, EMAIL_INPUTS, email))) throw new Error('no se encontró el campo de email');
  await clickResilient(page, CONTINUE_BUTTONS, ['Continuar']);

  await page.waitForSelector(PASS_INPUTS.join(', '), { state: 'visible', timeout: 20000 })
    .catch(() => { throw new Error('el campo de contraseña no apareció tras Continuar'); });

  if (!(await fillFirst(page, PASS_INPUTS, password))) throw new Error('no se pudo completar la contraseña');

  if (!(await clickResilient(page, CONTINUE_BUTTONS, ['Continuar', 'Entrar', 'Ingresar']))) {
    await page.keyboard.press('Enter').catch(() => {});
  }
  await page.waitForLoadState('networkidle', { timeout: settleTimeout }).catch(() => {});
  await sleep(6000);
}

/**
 * Fictional shopper used to unblock the checkout profile step. VTEX parks a logged-in
 * user at #/profile until name and phone exist on the account, and refuses to advance
 * to shipping or payment — so without this the last two funnel stages are unmeasurable.
 * Test account only; no order is ever placed.
 */
const TEST_PROFILE = {
  firstName: 'QA',
  lastName: 'Diagnostico',
  phone: '88888888',
  street: 'Calle 1',
};

/**
 * VTEX validates the phone against the store's country format, and a number tha
 * passes in one country fails in another — 88888888 is a valid Costa Rican mobile bu
 * Guatemala rejects it ("Introduzca un número de teléfono válido"), which stalls the
 * funnel at #/profile before shipping ever renders.
 *
 * Mobile prefixes: CR 6/7/8 · GT 3/4/5 · SV 6/7 · HN 3/8/9 · NI 5/7/8.
 */
const PHONE_BY_COUNTRY = {
  CR: '88776655',
  GT: '55512345',
  SV: '71234567',
  HN: '98765432',
  NI: '88123456',
};

/**
 * National ID per country, in the shape each checkout expects.
 *
 * The orderForm carries `documentType: "cedulaCRI"` with `document` empty, but dumping
 * the profile form showed it renders no document input at all on these themes — so this
 * is not what blocks shipping → payment, and filling it is simply skipped. Kept because
 * a theme that does render the field should have it filled rather than left blank.
 *
 * Lengths follow each country's format so the field's own mask accepts them:
 * CR cédula 9, GT DPI 13, SV DUI 9, HN 13, NI cédula 14. These identify a test
 * account, nothing more.
 */
const DOCUMENT_BY_COUNTRY = {
  CR: '112345678',
  GT: '2547896540101',
  SV: '045123456',
  HN: '0801199012345',
  NI: '0012110900012P',
};

function profileFor(country) {
  return {
    ...TEST_PROFILE,
    phone: PHONE_BY_COUNTRY[country] || TEST_PROFILE.phone,
    document: DOCUMENT_BY_COUNTRY[country] || '',
  };
}

/**
 * Metropolitan areas to prefer in the location modal, most-central first.
 *
 * Catalogue availability is per store. Defaulting to the first option alphabetically
 * put the session in Ahuachapan (SV) and La Ceiba (HN), where none of the six searched
 * products was purchasable — so the journey could never reach checkout. These are also
 * where the traffic actually is, which makes them the more representative measurement.
 */
/**
 * Coordinates fed to the browser's geolocation API, one metro centre per country.
 *
 * The shipping step's map dialog will only enable its confirm button when the pin sits
 * inside the store's delivery geofence. Searching an address dropped pins that were
 * often outside it; handing the page a real metropolitan coordinate and letting it use
 * "Utilizar ubicacion actual" puts the pin somewhere the store actually delivers.
 */
const GEO_BY_COUNTRY = {
  GT: { latitude: 14.6349, longitude: -90.5069 }, // Ciudad de Guatemala
  CR: { latitude: 9.9281, longitude: -84.0907 },  // San José
  SV: { latitude: 13.6929, longitude: -89.2182 }, // San Salvador
  HN: { latitude: 14.0723, longitude: -87.1921 }, // Tegucigalpa
  NI: { latitude: 12.1150, longitude: -86.2362 }, // Managua
};

const MAJOR_LOCATIONS = {
  CR: [/san jos[ée]/i, /heredia/i, /alajuela/i],
  GT: [/^guatemala/i, /ciudad de guatemala/i, /mixco/i],
  SV: [/san salvador/i, /la libertad/i, /santa ana/i],
  HN: [/tegucigalpa|francisco morazan/i, /san pedro sula|cortes/i],
  NI: [/managua/i, /le[óo]n/i],
};

/**
 * Fills the checkout profile form and advances to shipping.
 * Returns a short status string; never throws.
 */
async function completeProfile(page, profile = TEST_PROFILE, { timeout = 20000 } = {}) {
  /**
   * Give the form time to mount before deciding it is absent.
   *
   * Reporting "sin formulario de perfil" the instant a query comes back empty conflated
   * two very different things: a checkout that does not ask for a profile, and one that
   * simply had not finished rendering. On 2026-09-09 both Nicaragua storefronts were
   * logged as the former while being the latter.
   */
  const aparecio = await page.waitForSelector(
    '#client-first-name, #client-last-name, #client-phone, #client-email',
    { state: 'visible', timeout },
  ).then(() => true).catch(() => false);

  const fields = [
    ['#client-first-name', profile.firstName],
    ['#client-last-name', profile.lastName],
    ['#client-phone', profile.phone],
    // The national ID. Absent from this list until 2026-08-21, which left
    // clientProfileData.document empty and the checkout refusing to advance.
    ['#client-document', profile.document],
  ];

  let filled = 0;
  const skipped = [];
  for (const [sel, value] of fields) {
    if (!value) { skipped.push(sel + ':sin-valor'); continue; }
    const el = page.locator(sel).first();
    if (!(await el.count().catch(() => 0)) || !(await el.isVisible().catch(() => false))) {
      skipped.push(sel + ':no-existe');
      continue;
    }
    if (await el.inputValue().catch(() => '')) { filled++; continue; } // already on the accoun
    if (await el.fill(value, { timeout: 8000 }).then(() => true).catch(() => false)) filled++;
  }
  if (!filled) {
    return aparecio
      ? 'formulario presente pero ningún campo se pudo llenar'
      : `el formulario de perfil no apareció en ${timeout / 1000}s`;
  }

  await sleep(1200);
  const go = page.locator('#go-to-shipping, button:has-text("Ir para la Entrega")').first();
  if (await go.count().catch(() => 0)) {
    await go.click({ timeout: 10000 }).catch(() => {});
    await sleep(5000);
  }
  const missing = skipped.length ? ` (sin valor: ${skipped.join(',')})` : '';
  return `${filled} campo(s)${missing} — hash ahora ${await page.evaluate(() => location.hash).catch(() => '?')}`;
}

/**
 * Fills the shipping step (delivery channel, address, receiver) and advances to
 * payment. VTEX will not render the payment step until shipping validates, so this
 * is what makes the final funnel stage measurable at all.
 *
 * Chooses home delivery rather than pickup, since that is the path with the address
 * form and the shipping-rate calls we want to measure.
 */
/**
 * Satisfies Walmart's map-pin confirmation on the shipping step.
 *
 * Opens the map dialog and accepts the pin the site already placed from the address.
 * Returns a short status, or null when the storefront does not ask for it.
 */
/**
 * The map dialog comes in two flavours across these storefronts, same behaviour behind
 * different ids.
 *
 * Costa Rica, Guatemala and Honduras render #show-map-gcp with #confirm. Nicaragua
 * drops the address selects entirely and puts everything behind #geo-delivery-cta-btn
 * with #geo-confirm-btn — which is why the NI runs reported "calle=ausente" and never
 * advanced: the code was filling selects that do not exist on those themes.
 *
 * In both, the confirm button starts disabled and only enables once the pin is inside
 * the delivery geofence, which is what makes it usable as the validity signal.
 */
const MAP_FAMILIES = [
  { name: 'gcp', trigger: '#show-map-gcp', confirm: '#confirm', useCurrent: '#location-btn', addr: '#address', search: '#search-btn' },
  { name: 'geo', trigger: '#geo-delivery-cta-btn', confirm: '#geo-confirm-btn', useCurrent: '#geo-location-btn', addr: '#geo-address-input', search: '#geo-search-btn' },
];

async function confirmLocationOnMap(page, profile = TEST_PROFILE) {
  let fam = null;
  for (const candidate of MAP_FAMILIES) {
    const t = page.locator(candidate.trigger).first();
    if (await t.count().catch(() => 0) && await t.isVisible().catch(() => false)) { fam = candidate; break; }
  }
  if (!fam) return null;

  const trigger = page.locator(fam.trigger).first();
  // Scroll it into view and fall back to a forced click. The plain click succeeded when
  // the dialog was opened straight after arriving at the step, and failed once the
  // channel selection had re-rendered the panel around it — the control is there either
  // way, it just stops being the topmost element at that point.
  await trigger.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  let opened = await trigger.click({ timeout: 8000 }).then(() => true).catch(() => false);
  if (!opened) opened = await trigger.click({ timeout: 6000, force: true }).then(() => true).catch(() => false);
  if (!opened) return `no-abrió (${fam.name})`;
  await sleep(4000);

  // The confirm button stays disabled until the pin lands inside the delivery geofence,
  // so it doubles as the validity signal. Scope every lookup to the dialog: an earlier
  // version searched the whole page and "confirmed" by clicking an unrelated button
  // elsewhere, which is why the step reported success and never moved.
  const confirm = page.locator(fam.confirm).first();
  const enabled = async () => (await confirm.count().catch(() => 0))
    && !(await confirm.isDisabled().catch(() => true));

  // Preferred: let the page read the geolocation we handed the browser.
  const useCurrent = page.locator(fam.useCurrent).first();
  if (await useCurrent.count().catch(() => 0) && await useCurrent.isVisible().catch(() => false)) {
    await useCurrent.click({ timeout: 8000 }).catch(() => {});
    for (let i = 0; i < 12 && !(await enabled()); i++) await sleep(1000);
  }

  // Fallback: search the address and let the map geocode it.
  if (!(await enabled())) {
    const addr = page.locator(fam.addr).first();
    if (await addr.count().catch(() => 0) && await addr.isVisible().catch(() => false)) {
      const city = String(await page.locator('#ship-city').first().inputValue().catch(() => '')).split('___')[0];
      const state = await page.locator('#ship-state').first().inputValue().catch(() => '');
      await addr.fill([profile.street || 'Calle 1', city, state].filter(Boolean).join(', '), { timeout: 6000 }).catch(() => {});
      await sleep(800);
      await page.locator(fam.search).first().click({ timeout: 6000 }).catch(() => {});
      for (let i = 0; i < 12 && !(await enabled()); i++) await sleep(1000);
    }
  }

  if (!(await enabled())) return `pin fuera de la geocerca (${fam.name}: confirmar sigue deshabilitado)`;
  if (!(await confirm.click({ timeout: 8000 }).then(() => true).catch(() => false))) return 'no-se-pudo-confirmar';
  await sleep(5000);

  // Confirming the pin opens a last panel — street and complement plus an "Aceptar"
  // button. Until that is submitted the step keeps reporting "Confirma tu ubicación en
  // el mapa", which is what made the whole flow look like an unpassable bot challenge.
  for (const [sel, value] of [
    ['#input-street', profile.street || 'Calle 1'],
    ['#input-complement', 'Casa'],
  ]) {
    const el = page.locator(sel).first();
    if (!(await el.count().catch(() => 0)) || !(await el.isVisible().catch(() => false))) continue;
    if (await el.inputValue().catch(() => '')) continue;
    await el.fill(value, { timeout: 6000 }).catch(() => {});
  }
  // Fall back to whatever empty text inputs the panel rendered without ids.
  const blanks = page.locator('input[type="text"]:visible, input:not([type]):visible');
  const bn = await blanks.count().catch(() => 0);
  for (let i = 0; i < bn; i++) {
    const el = blanks.nth(i);
    const id = await el.getAttribute('id').catch(() => null);
    if (id && /ship-|address|search|clear/.test(id)) continue; // leave the outer form alone
    if (await el.inputValue().catch(() => 'x')) continue;
    await el.fill(profile.street || 'Calle 1', { timeout: 4000 }).catch(() => {});
  }
  await sleep(1200);

  const accept = page.locator('input[value="Aceptar"], button:has-text("Aceptar")').first();
  if (await accept.count().catch(() => 0) && await accept.isVisible().catch(() => false)
      && !(await accept.isDisabled().catch(() => true))) {
    await accept.click({ timeout: 8000 }).catch(() => {});
    await sleep(5000);
    return 'confirmado + dirección aceptada';
  }
  return 'confirmado (sin panel de dirección)';
}

/**
 * Picks a delivery slot. Scheduled delivery leaves "Ir para el pago" inert until a date
 * is chosen from the react-datepicker the shipping step renders.
 */
/** logisticsInfo[0].deliveryWindow as the checkout itself holds it, or undefined. */
const READ_WINDOW = `(() => {
  try {
    const li = vtexjs.checkout.orderForm.shippingData.logisticsInfo[0];
    return li ? (li.deliveryWindow || null) : null;
  } catch (e) { return undefined; }
})()`;

/**
 * Picks a delivery window and confirms it landed in the orderForm.
 *
 * Costa Rica's "Entrega a domicilio" is a *scheduled* SLA: it advertises availableDelivery-
 * Windows and the checkout refuses to move to payment until one is committed. Reading the
 * orderForm at the gate showed the cause the DOM never revealed — `deliveryWindow: null`
 * beside an SLA offering fourteen of them. Clicking a day in the datepicker changes what
 * is on screen; it does not necessarily commit the window.
 *
 * So success is judged against `logisticsInfo[0].deliveryWindow`, not against the click
 * having happened. An earlier version returned "fecha elegida" the moment a day was
 * clicked, which is why every run reported the date as chosen while the gate stayed shut.
 */
async function selectDeliveryDate(page) {
  const already = await page.evaluate(READ_WINDOW).catch(() => undefined);
  if (already) return 'ventana ya fijada';

  const opener = page.locator('[id^="scheduled-delivery-choose"], .react-datepicker__input-container input, .shp-datepicker-button, [class*="dateLink"], [class*="scheduledDelivery"] button').first();
  if (!(await opener.count().catch(() => 0))) {
    const inDom = await page.evaluate(() => document.querySelectorAll(
      '.react-datepicker-wrapper, [class*="scheduledDelivery"]').length).catch(() => 0);
    return inDom ? `selector-de-fecha en DOM pero sin control visible (${inDom} nodos)` : null;
  }
  if (!(await opener.isVisible().catch(() => false))) return 'selector-de-fecha oculto';
  await opener.click({ timeout: 8000 }).catch(() => {});
  await sleep(2500);

  const day = page.locator('.react-datepicker__day:not(.react-datepicker__day--disabled):not(.react-datepicker__day--outside-month), .shp-datepicker-day:not(.disabled)').first();
  if (!(await day.count().catch(() => 0))) return 'sin-días-disponibles';
  if (!(await day.click({ timeout: 6000 }).then(() => true).catch(() => false))) return 'no-se-pudo-elegir-día';
  await sleep(2500);

  // Time slot. Radios are often visually replaced and report zero size, so they are
  // checked with force rather than skipped for being "not visible".
  const slotSels = [
    '[class*="deliveryWindow"] input[type="radio"]',
    '[class*="scheduledDelivery"] input[type="radio"]',
    '[class*="shipping-window"] input[type="radio"]',
    '.shp-delivery-window input[type="radio"]',
    'input[type="radio"][name*="window" i]',
  ];
  let slot = null;
  for (const sel of slotSels) {
    const c = page.locator(sel).first();
    if (await c.count().catch(() => 0)) { slot = c; break; }
  }
  if (slot) {
    await slot.check({ timeout: 5000, force: true }).catch(() => {});
    await sleep(2000);
  }

  // Commit. The panel's own confirm button is whatever enabled button it renders that
  // is not the funnel's "go to payment" — matching by label alone missed storefronts
  // that word it differently.
  const confirm = page.locator(
    '[class*="scheduledDelivery"] button:not([disabled]), [class*="deliveryWindow"] button:not([disabled]), '
    + '.shp-delivery-window button:not([disabled]), button:has-text("Confirmar"):not([disabled]), '
    + 'button:has-text("Aceptar"):not([disabled]), button:has-text("Guardar"):not([disabled])'
  ).filter({ hasNotText: /pago|payment/i }).first();
  if (await confirm.count().catch(() => 0)) {
    await confirm.click({ timeout: 6000 }).catch(() => {});
    await sleep(3000);
  }

  // Ground truth. Poll briefly: the commit is a round trip to the checkout API.
  for (let i = 0; i < 8; i++) {
    const w = await page.evaluate(READ_WINDOW).catch(() => undefined);
    if (w) return `ventana fijada ${w.startDateUtc ? String(w.startDateUtc).slice(0, 16) : ''}`.trim();
    await sleep(1500);
  }
  const w = await page.evaluate(READ_WINDOW).catch(() => undefined);
  return w === undefined
    ? 'día elegido — orderForm no legible para verificar'
    : `día elegido pero deliveryWindow sigue null${slot ? '' : ' (sin control de franja horaria)'}`;
}

async function completeShipping(page, profile = TEST_PROFILE, { advance = true } = {}) {
  const did = [];

  // The step renders asynchronously after profile is submitted; filling before the
  // address form exists silently does nothing.
  const appeared = await page.waitForSelector('#ship-street, select.shipping-state, #shipping-option-delivery', { state: 'visible', timeout: 25000 })
    .then(() => true).catch(() => false);

  if (!appeared) {
    // Report what IS on screen, so the mismatch is diagnosable from the run log
    // instead of requiring another scripted round-trip to production.
    const seen = await page.evaluate(() => {
      const vis = (e) => !!e.offsetParent;
      const msgs = [...document.querySelectorAll('[class*="vtex-front-messages"], .alert, [role="alert"], [class*="error"]')]
        .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t && t.length > 3);
      return {
        hash: location.hash,
        ids: [...document.querySelectorAll('input,select,button')].filter(vis)
          .map((e) => e.id || `${e.tagName.toLowerCase()}.${(e.className || '').toString().split(/\s+/)[0]}`)
          .filter(Boolean).slice(0, 18),
        messages: [...new Set(msgs)].slice(0, 4),
        // Skip the persistent cart summary and show what follows it.
        tail: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(160, 520),
      };
    }).catch(() => null);
    did.push(`form no apareció [${seen ? seen.hash + ' | ' + seen.ids.join(',') : 'sin DOM'}]`);
    if (seen && seen.messages.length) did.push(`MENSAJES: ${seen.messages.join(' || ').slice(0, 220)}`);
    if (seen) did.push(`txt2="${seen.tail.slice(0, 200)}"`);
  }

  // 1. Delivery channel (home delivery — the path with the address form and the
  //    shipping-rate calls we want to measure).
  const delivery = page.locator('#shipping-option-delivery').first();
  if (await delivery.count().catch(() => 0) && await delivery.isVisible().catch(() => false)) {
    if (await delivery.click({ timeout: 8000 }).then(() => true).catch(() => false)) did.push('canal=domicilio');
    await sleep(3000);
  }

  // 2. Cascading location selects — each populates the next. Both id and class forms
  //    appear across storefronts (#ship-state here, .shipping-state there).
  for (const cls of ['#ship-state, select.shipping-state', '#ship-city, select.shipping-city',
                     '#ship-neighborhood, select.shipping-neighborhood']) {
    const sel = page.locator(cls).first();
    if (!(await sel.count().catch(() => 0))) continue;
    const tag = cls.split(',')[0].replace(/[#.]/, '');
    if (await sel.inputValue().catch(() => '')) { did.push(tag + '=ya'); continue; }
    for (let attempt = 0; attempt < 15; attempt++) {
      if (await sel.locator('option').count().catch(() => 0) > 1) break;
      await sleep(600);
    }
    if (await sel.locator('option').count().catch(() => 0) <= 1) { did.push(tag + '=vacío'); continue; }
    if (await sel.selectOption({ index: 1 }, { timeout: 8000 }).then(() => true).catch(() => false)) did.push(tag + '=ok');
    await sleep(2000);
  }

  // 3. Street and receiver.
  for (const [sel, value, tag] of [['#ship-street', 'Calle 1', 'calle'], ['#ship-receiverName', `${profile.firstName} ${profile.lastName}`, 'receptor']]) {
    const el = page.locator(sel).first();
    if (!(await el.count().catch(() => 0)) || !(await el.isVisible().catch(() => false))) { did.push(tag + '=ausente'); continue; }
    if (await el.inputValue().catch(() => '')) { did.push(tag + '=ya'); continue; }
    if (await el.fill(value, { timeout: 8000 }).then(() => true).catch(() => false)) did.push(tag + '=ok');
  }
  await sleep(3000);

  // 4. Confirm the pin on the map. Walmart adds this gate on top of stock VTEX
  //     shipping ("Confirma tu ubicacion en el mapa", #show-map-gcp) and leaves
  //     "Ir para el pago" hidden until it is satisfied — which is why the step looked
  //     like a reCAPTCHA failure for so long.
  const mapStatus = await confirmLocationOnMap(page, profile);
  if (mapStatus) did.push(`mapa=${mapStatus}`);

  // 5. Only now pick the delivery date: the scheduler renders after the map pin is
  //    accepted, so asking for it earlier finds nothing.
  const dateStatus = await selectDeliveryDate(page);
  if (dateStatus) did.push(`fecha=${dateStatus}`);

  // The map flow re-renders the outer form, which can blank fields filled before it.
  for (const [sel, value, tag] of [['#ship-receiverName', `${profile.firstName} ${profile.lastName}`, 'receptor'],
                                   ['#ship-street', profile.street || 'Calle 1', 'calle']]) {
    const el = page.locator(sel).first();
    if (!(await el.count().catch(() => 0)) || !(await el.isVisible().catch(() => false))) continue;
    if (await el.inputValue().catch(() => 'x')) continue;
    if (await el.fill(value, { timeout: 6000 }).then(() => true).catch(() => false)) did.push(tag + '=rellenado');
  }

  // Fill anything the map step just revealed as required.
  //
  // Only what is genuinely empty. This loop used to re-select the neighbourhood
  // unconditionally, and that single line was the gate: by this point shipping has
  // already been calculated for the chosen address, and changing the select re-opens
  // the calculation. The checkout answers "La verificación ha expirado. Verifique
  // nuevamente el campo." and refuses to advance — with no field marked invalid, which
  // is why it read for weeks as an unexplained validation error. Stepping through the
  // form one action at a time, skipping this re-selection, reached #/payment.
  for (const sel of ['#cloned-ship-neighborhood', '#ship-neighborhood']) {
    const el = page.locator(sel).first();
    if (!(await el.count().catch(() => 0)) || !(await el.isVisible().catch(() => false))) continue;
    const tag = await el.evaluate((n) => n.tagName.toLowerCase()).catch(() => '');
    if (tag === 'select') {
      if (await el.inputValue().catch(() => '')) { did.push('barrio=ya'); continue; }
      if (await el.locator('option').count().catch(() => 0) > 1) {
        await el.selectOption({ index: 1 }, { timeout: 6000 }).catch(() => {});
        did.push('barrio=ok');
      }
    } else if (!(await el.inputValue().catch(() => ''))) {
      await el.fill('Centro', { timeout: 6000 }).catch(() => {});
      did.push('barrio=ok');
    }
    await sleep(1500);
  }

  // 6. Advance, sharing advanceToPayment so both the automated and handoff paths
  //     report the same diagnosis when the step refuses to move on.
  const outcome = await advanceToPayment(page);
  return `${did.join(', ') || 'nada que completar'} → ${outcome}`;
}

/**
 * Waits for a human to clear the reCAPTCHA on the shipping step.
 *
 * Detected by reading the token reCAPTCHA writes into its hidden textarea, rather than
 * by asking the operator to confirm on a terminal: the person is looking at the browser,
 * and the browser already knows the answer. Polling it also keeps the measurement clean,
 * because the click that follows is ours and is timed from a standing start.
 *
 * Returns 'sin-captcha' when no widget is present (nothing to solve), 'resuelto' once a
 * token appears, or 'timeout' if the wait elapses.
 */
async function waitForCaptcha(page, timeoutMs = 300000, onTick = null) {
  const present = await page.evaluate(() => !!document.querySelector(
    '.g-recaptcha, iframe[src*="recaptcha"], #g-recaptcha-response, textarea[name="g-recaptcha-response"]'
  )).catch(() => false);
  if (!present) return 'sin-captcha';

  const solved = () => page.evaluate(() => [...document.querySelectorAll(
    '#g-recaptcha-response, textarea[name="g-recaptcha-response"]'
  )].some((e) => e.value && e.value.length > 20)).catch(() => false);

  if (await solved()) return 'resuelto';

  const start = Date.now();
  let lastTick = 0;
  while (Date.now() - start < timeoutMs) {
    await sleep(2000);
    if (await solved()) return 'resuelto';
    const secs = Math.round((Date.now() - start) / 1000);
    if (onTick && secs - lastTick >= 20) { lastTick = secs; onTick(secs); }
  }
  return 'timeout';
}

/**
 * Waits for the operator to reach the payment-method screen by hand.
 *
 * Used when the shipping → payment gate refuses to yield to automation. The elapsed
 * time therefore includes human interaction and is NOT a page-load measurement — the
 * value of the window is the network and trace activity the payment screen produces.
 * Callers must mark the resulting step as operator-assisted.
 */
async function waitForPaymentStep(page, timeoutMs = 300000, onTick = null) {
  const start = Date.now();
  let lastTick = 0;
  while (Date.now() - start < timeoutMs) {
    const hash = await page.evaluate(() => location.hash).catch(() => '');
    if (hash.includes('payment')) {
      await sleep(4000); // let the payment screen settle before we stop recording
      return `alcanzado en ${Math.round((Date.now() - start) / 1000)}s`;
    }
    await sleep(1500);
    const secs = Math.round((Date.now() - start) / 1000);
    if (onTick && secs - lastTick >= 20) { lastTick = secs; onTick(secs); }
  }
  return 'timeout';
}

/**
 * Clicks "Ir para el pago" and reports what happened.
 *
 * Reports the button's state and any on-screen validation message when it fails to
 * advance, because a silent "still on #/shipping" is indistinguishable between a
 * missing button, a disabled button, and a rejected form.
 */
/**
 * Waits for the payment screen to be usable, and never touches it.
 *
 * This is the last thing a shopper waits for before choosing how to pay, and until now
 * nothing measured it: the funnel never reached the screen. Strictly read-only — no
 * method is selected and nothing is submitted, because the order must never be placed.
 */
async function waitForPaymentOptions(page, timeout = 30000) {
  const SEL = '#payment-group-creditCardPaymentGroup, [id^="payment-group-"], '
    + '.payment-group-item, [class*="PaymentGroup"], [class*="payment-method"]';
  const ok = await page.waitForSelector(SEL, { state: 'visible', timeout })
    .then(() => true).catch(() => false);
  if (!ok) return 'pantalla de pago sin opciones visibles';
  const groups = await page.evaluate((sel) => document.querySelectorAll(sel).length, SEL).catch(() => 0);
  return `${groups} opción(es) de pago visibles`;
}

async function advanceToPayment(page) {
  // Resolve the id on its own first.
  //
  // The previous locator was '#btn-go-to-payment, button:has-text("Ir para el pago")'
  // with .first(), and a comma-separated selector picks the first match in DOM order —
  // not the first alternative listed. Where the storefront renders another element
  // carrying that text ahead of the real control, .first() returned the wrong one:
  // stepping through the page reported #btn-go-to-payment as visible at the exact
  // moment this function reported visible=false, which is the contradiction that gave
  // it away. Clicking the phantom did nothing and the funnel silently stayed put.
  let go = page.locator('#btn-go-to-payment').first();
  let count = await go.count().catch(() => 0);
  if (!count) {
    go = page.locator('button:has-text("Ir para el pago")').first();
    count = await go.count().catch(() => 0);
  }
  if (!count) return 'botón "Ir para el pago" no está en la página';

  const disabled = await go.isDisabled().catch(() => false);
  await go.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  const visible = await go.isVisible().catch(() => false);
  if (!(await go.click({ timeout: 10000 }).then(() => true).catch(() => false))) {
    // Hidden behind a collapsed container rather than genuinely absent.
    await go.click({ timeout: 6000, force: true }).catch(() => {});
  }
  await page.waitForFunction(() => location.hash.includes('payment'), null, { timeout: 25000 })
    .catch(() => {});
  await sleep(3000);

  const hash = await page.evaluate(() => location.hash).catch(() => '?');
  if (hash.includes('payment')) return `ok → ${hash}`;

  const state = await page.evaluate(() => {
    const vis = (e) => !!e.offsetParent;
    const msgs = [...document.querySelectorAll('[class*="front-messages"], .alert, [role="alert"], [class*="error"]')]
      .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim()).filter((t) => t.length > 3);
    return {
      msgs: [...new Set(msgs)].slice(0, 3),
      inputs: [...document.querySelectorAll('input,select')].filter(vis)
        .map((e) => e.id || e.name || (e.className || '').toString().split(/\s+/)[0]).filter(Boolean).slice(0, 12),
      invalid: [...document.querySelectorAll('.error, .has-error, [aria-invalid="true"]')].filter(vis)
        .map((e) => e.id || (e.className || '').toString().slice(0, 40)).slice(0, 6),
    };
  }).catch(() => null);

  return `no avanzó (visible=${visible} disabled=${disabled}) → ${hash}` +
    (state ? ` | campos: ${state.inputs.join(',')} | inválidos: ${state.invalid.join(',') || 'ninguno'}` +
      (state.msgs.length ? ` | MENSAJES: ${state.msgs.join(' || ').slice(0, 200)}` : '') : '');
}

module.exports = {
  sleep, takePad, settle, OVERLAY_SEL, TEST_PROFILE, PHONE_BY_COUNTRY, DOCUMENT_BY_COUNTRY, profileFor, completeProfile, completeShipping,
  advanceToPayment, waitForPaymentOptions, waitForCaptcha, waitForPaymentStep, confirmLocationOnMap, selectDeliveryDate, GEO_BY_COUNTRY, findPdpUrls, hasAddToCart, confirmLocationModal, pickStoreFromResults,
  ADD_TO_CART, ADD_TO_CART_TEXT, EMAIL_INPUTS, PASS_INPUTS, CONTINUE_BUTTONS, COOKIE_ACCEPT,
  clickFirst, fillFirst, clickResilient, acceptCookies,
  overlayBlocking, selectDeliveryLocation, findPdpUrl,
  isLoggedIn, cartItemCount, login,
};
