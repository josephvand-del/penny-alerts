/* Penny Alerts v1 harness — loads app.js in a vm with a stub DOM, feeds the
 * REAL briefing JSON, and asserts parse/filter/watch/ignore/check-link
 * behaviour. Run: node test-v1.mjs  (must end ALL PASS) */
'use strict';
import fs from 'fs';
import vm from 'vm';
import { execFileSync } from 'child_process';

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log('PASS ' + label); }
  else { failures++; console.log('FAIL ' + label + '\n  actual:   ' + a + '\n  expected: ' + e); }
}

class StubEl {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = [];
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.attributes = {};
    this.listeners = {};
    this.classList = {
      _s: new Set(),
      add: function (c) { this._s.add(c); },
      remove: function (c) { this._s.delete(c); },
      toggle: function (c, f) { if (f) this._s.add(c); else this._s.delete(c); },
      contains: function (c) { return this._s.has(c); }
    };
  }
  get options() { return this.children.filter(function (c) { return c.tagName === 'OPTION'; }); }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  appendChild(c) { this.children.push(c); return c; }
  closest() { return null; }
}

const realData = JSON.parse(fs.readFileSync('/tmp/ph-latest.json', 'utf8'));
const lsMem = {};
const notifCalls = [];
const fetchCalls = [];
let weeklyFixture = null;
function NotificationStub(title, opts) { notifCalls.push({ title: title, opts: opts }); }
NotificationStub.permission = 'granted';
NotificationStub.requestPermission = async function () { return 'granted'; };

const els = {};
const domListeners = {};
const sandbox = {
  console: console,
  setTimeout: setTimeout,
  Promise: Promise,
  JSON: JSON,
  atob: atob,
  btoa: btoa,
  document: {
    getElementById: function (id) {
      if (!els[id]) els[id] = new StubEl('div');
      return els[id];
    },
    createElement: function (tag) { return new StubEl(tag); },
    querySelectorAll: function () { return []; },
    addEventListener: function (ev, fn) { domListeners[ev] = fn; }
  },
  localStorage: {
    getItem: function (k) { return (k in lsMem) ? lsMem[k] : null; },
    setItem: function (k, v) { lsMem[k] = String(v); }
  },
  navigator: {},
  Notification: NotificationStub,
  fetch: async function (url) {
    fetchCalls.push(url);
    if (url.indexOf('feed/weekly.json') !== -1) {
      if (!weeklyFixture) throw new Error('weekly fixture not set');
      return { ok: true, json: async function () { return weeklyFixture; } };
    }
    if (url.indexOf('rocketshon.github.io') === -1) throw new Error('UNEXPECTED FETCH: ' + url);
    return { ok: true, json: async function () { return realData; } };
  },
  window: {}
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('/home/hatch/workspace/penny-alerts/app.js', 'utf8'), sandbox);

const PA = sandbox.window.PennyAlerts;

(async function main() {
  /* 1. normalize the real briefing */
  const norm = PA.normalizeBriefing(realData);
  check('deals total = 146 penny + 1644 weekly-ad', norm.deals.length, 1790);
  const pennies = norm.deals.filter(function (d) { return d.kind === 'penny'; });
  check('penny count', pennies.length, 146);
  check('all penny items have UPC', pennies.every(function (d) { return d.upc && d.upc.length >= 10; }), true);
  check('no penny item keeps dept Penny', pennies.every(function (d) { return d.dept !== 'Penny'; }), true);
  check('penny dept is classified from the name', pennies[0].dept, PA.classifyDept(pennies[0].name, 'Penny'));
  check('penny price', pennies[0].price, '$0.01');
  check('meta week', norm.meta.weekId, '2026-W40');
  check('meta generatedAt', norm.meta.generatedAt, '2026-10-03T14:36:45+00:00');

  /* 2. expiry + date math */
  check('expired weekly-ad item', PA.isExpired({ validTo: '2026-10-06' }, '2026-11-22'), true);
  check('no validTo is not expired', PA.isExpired({ validTo: '' }, '2026-11-22'), false);
  check('days since Oct 3 to Nov 22', PA.daysSince('2026-10-03', '2026-11-22'), 50);

  /* 3. departments (v9) — classifyDept splits the old "Penny" bucket
   * into real sections from the name; no deal keeps dept 'Penny'. */
  check('classifyDept: nail plate -> Tools', PA.classifyDept('1-1/2 in. x 5 in. Nail Plate Bulk (100-Pack)', 'Penny'), 'Tools');
  check('classifyDept: sparkler -> Home & Seasonal', PA.classifyDept('#8 Gold Sparkler', 'Penny'), 'Home & Seasonal');
  check('classifyDept: candy bar -> Grocery', PA.classifyDept('Abba-Zaba Candy Bar', 'Penny'), 'Grocery');
  check('classifyDept: no keywords + Penny fallback -> General', PA.classifyDept('Capri Sun Summer Blast Passion Fruit Mango 10ct', 'Penny'), 'General');
  check('classifyDept: non-Penny fallback is kept', PA.classifyDept('Some Random Thing', 'Clothing'), 'Clothing');
  check('classifyDept: soap is Health & Beauty, not Household', PA.classifyDept('Softsoap Liquid Hand Soap 11oz', 'Penny'), 'Health & Beauty');
  check('classifyDept: battery is Electronics, not Household', PA.classifyDept('AA Batteries 8-Pack', 'Penny'), 'Electronics');
  check('classifyDept: dog treats -> Pet', PA.classifyDept('Blue Buffalo Dog Treats 24lb', 'Penny'), 'Pet');
  check('classifyDept: dog food -> Grocery (food beats dog)', PA.classifyDept('Blue Buffalo Dog Food 24lb', 'Penny'), 'Grocery');
  check('classifyDept: carpet is not Auto', PA.classifyDept('Indoor Carpet Runner 6ft', 'Penny'), 'General');
  check('deriveDepartment delegates to classifyDept', PA.deriveDepartment({ kind: 'deal', name: 'Chex Mix Snack 15oz', saleStory: '' }), 'Grocery');

  /* 4. BrickSeek is gone (v7) — Joseph has no account there, so the
   * checker links and the checkLinks export were removed entirely. */
  check('checkLinks is removed from the app', typeof PA.checkLinks, 'undefined');

  /* 5. weekly feed fixture: one dup of the first briefing penny (by UPC),
   * one Home Depot penny (no UPC, WITH a list image), one Slickdeals deal
   * (no image). Merged total is
   * 1790 briefing - 2 sharing the fixture UPC (the penny + one deal) + 3
   * weekly = 1791. */
  weeklyFixture = {
    generated_at: '2026-11-22T10:00:00+00:00',
    sources: [
      { name: 'Freebie Guy — DG penny list', url: 'https://THEFREEBIEGUY.COM/DOLLAR-GENERAL-PENNY-SHOPPING-MASTER-LIST/', status: 'ok', item_count: 1 },
      { name: 'SavingK — Walmart hidden clearance', url: 'https://savingk.com/walmart-hidden-clearance-how-to-find-these-secret-deals/', status: 'link-only', item_count: 0, note: 'Guide page only' }
    ],
    items: [
      { name: pennies[0].name, upc: pennies[0].upc, price: '$0.01', was: '', retailer: 'dollar-general', department: 'Penny', source: 'thefreebieguy.com', first_seen: '2026-11-22', valid_to: '', url: '', image: '' },
      { name: 'Weekly Test HD Screw', upc: '', price: '$0.01', was: '$12.98', retailer: 'home-depot', department: 'Penny', source: 'pennyrecon.com', first_seen: '2026-11-22', valid_to: '', url: 'https://www.pennyrecon.com/item/123/', image: 'https://images.thdstatic.com/productImages/test/svn/test-screw-64_600.jpg' },
      { name: 'Weekly Test Charger', upc: '', price: '$39.99', was: '', retailer: 'amazon', department: 'Electronics', source: 'slickdeals.net', first_seen: '2026-11-22', valid_to: '2099-01-01', url: '', image: '' }
    ]
  };
  const wnorm = PA.normalizeWeekly(weeklyFixture);
  check('weekly normalize count', wnorm.deals.length, 3);
  check('weekly penny kind', wnorm.deals[0].kind, 'penny');
  check('weekly deal kind', wnorm.deals[2].kind, 'deal');
  check('weekly meta generatedAt', wnorm.meta.generatedAt, '2026-11-22T10:00:00+00:00');
  check('weekly meta sources', wnorm.meta.sources.length, 2);
  check('weekly normalize carries image', wnorm.deals[1].image, 'https://images.thdstatic.com/productImages/test/svn/test-screw-64_600.jpg');
  check('weekly normalize empty image stays empty', wnorm.deals[2].image, '');
  check('briefing normalize carries image_url', norm.deals.some(function (d) { return d.image && d.image.indexOf('f.wishabi.net') !== -1; }), true);
  check('briefing penny items have no image', norm.deals.filter(function (d) { return d.kind === 'penny'; }).every(function (d) { return d.image === ''; }), true);

  /* 6. full init() with stub DOM + stub fetch */
  domListeners['DOMContentLoaded']();
  await new Promise(function (r) { setTimeout(r, 200); });
  const st = PA._state;
  check('both feeds fetched', fetchCalls.length, 2);
  check('weekly feed fetched', fetchCalls.some(function (u) { return u.indexOf('feed/weekly.json') !== -1; }), true);
  check('state deals loaded (1790 briefing - 2 sharing fixture UPC + 3 weekly)', st.deals.length, 1791);
  check('briefing dup dropped, weekly copy kept', st.deals.some(function (d) { return d.id === 'w-' + pennies[0].upc; }) && !st.deals.some(function (d) { return d.id === 'penny-' + pennies[0].upc; }), true);
  check('weekly meta stored', st.weeklyMeta.generatedAt, '2026-11-22T10:00:00+00:00');
  check('briefing bar mentions week', els['briefingBar'].textContent.indexOf('2026-W40') !== -1, true);
  check('briefing bar mentions weekly feed date', els['briefingBar'].textContent.indexOf('2026-11-22') !== -1, true);
  check('weekly sources rendered', els['weeklySources'].innerHTML.indexOf('Freebie Guy') !== -1, true);
  check('weekly sources show link-only', els['weeklySources'].innerHTML.indexOf('link only') !== -1, true);
  check('stale bar shown (briefing 50+ days old)', els['staleBar'].hidden, false);
  check('stale bar mentions days old', els['staleBar'].textContent.indexOf(PA.daysSince('2026-10-03', PA._state.today) + ' days old') !== -1, true);
  check('stale bar mentions weekly feed', els['staleBar'].textContent.indexOf('weekly feed') !== -1, true);
  check('deal list rendered cards', (els['dealList'].innerHTML.match(/<article/g) || []).length > 0, true);
  check('retailer filter populated from weekly deals only', els['retailerFilter'].options.map(function (o) { return o.value; }).join(','), ',amazon,dollar-general,home-depot');
  check('retailer filter labels carry counts', els['retailerFilter'].options.map(function (o) { return o.textContent; }).join('|'), 'All stores|Amazon (1)|Dollar General (1)|Home Depot (1)');
  check('dept filter populated from weekly deals only', els['deptFilter'].options.map(function (o) { return o.value; }).join(','), ',Electronics,General,Tools');
  check('dept filter has no Penny option', els['deptFilter'].options.map(function (o) { return o.value; }).indexOf('Penny') === -1, true);
  check('notification fired for new deals', notifCalls.length >= 1, true);
  check('notification title mentions new deals', /new deal/.test(notifCalls[0].title), true);

  /* 7. filters: penny-only + ignore + expired */
  st.filters.pennyOnly = true;
  check('penny-only filter', PA._visibleDeals().length, 147);
  st.filters.pennyOnly = false;
  check('expired hidden by default', PA._visibleDeals().length, 148); // 145 briefing pennies + 3 weekly
  st.filters.showExpired = true;
  check('show-expired reveals all', PA._visibleDeals().length, 1791);
  st.filters.showExpired = false;
  const firstPenny = pennies[1].id; // pennies[0] was deduped out by the weekly fixture
  PA._handleAction('ignore', firstPenny);
  check('ignored item hidden', PA._visibleDeals().some(function (d) { return d.id === firstPenny; }), false);
  PA._handleAction('unignore', firstPenny);
  check('un-ignored item back', PA._visibleDeals().some(function (d) { return d.id === firstPenny; }), true);
  PA._handleAction('watch', firstPenny);
  check('watched', !!st.watch[firstPenny], true);
  PA._handleAction('ignore', firstPenny);
  check('ignoring a watched item unwatches it', !!st.watch[firstPenny], false);
  PA._handleAction('unignore', firstPenny);
  check('ignored list empty again', Object.keys(st.ignored).length, 0);

  /* 8. stores data intact */
  check('store groups', PA.STORES.length, 4);
  check('walmart store count', PA.STORES[0].items.length, 6);
  check('target store count', PA.STORES[1].items.length, 5);
  check('DG closed store flagged', PA.STORES[2].items[0].closed, true);
  check('DG active count', PA.STORES[2].items.filter(function (s) { return !s.closed; }).length, 2);
  check('home depot count', PA.STORES[3].items.length, 5);

  /* 9. background push (v3) */
  check('VAPID public key present', typeof PA.VAPID_PUBLIC_KEY, 'string');
  check('VAPID public key length (65-byte point, base64url)', PA.VAPID_PUBLIC_KEY.length, 87);
  check('VAPID public key is base64url', /^[A-Za-z0-9_-]+$/.test(PA.VAPID_PUBLIC_KEY), true);
  const keyBytes = PA.urlBase64ToUint8Array(PA.VAPID_PUBLIC_KEY);
  check('VAPID public key decodes to 65 bytes', keyBytes.length, 65);
  check('VAPID public key is an uncompressed point (0x04)', keyBytes[0], 4);
  check('urlBase64ToUint8Array handles unpadded input', PA.urlBase64ToUint8Array('BAECAw').join(','), '4,1,2,3');
  const fakeSub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint',
    getKey: function (name) {
      if (name === 'p256dh') return new Uint8Array([4, 1, 2, 3]).buffer;
      if (name === 'auth') return new Uint8Array([9, 8, 7]).buffer;
      return null;
    }
  };
  const subBody = PA.buildSubscriptionBody(fakeSub);
  check('subscription body endpoint', subBody.endpoint, 'https://fcm.googleapis.com/fcm/send/test-endpoint');
  check('subscription body p256dh base64url', subBody.p256dh, 'BAECAw');
  check('subscription body auth base64url', subBody.auth, 'CQgH');
  check('pushSupported false in stub env (no serviceWorker)', PA.pushSupported(), false);
  check('supabase URL is the shared bulk-finder project', PA.SUPABASE_URL, 'https://xwekulsnfarjibawqqih.supabase.co');
  const swText = fs.readFileSync('/home/hatch/workspace/penny-alerts/sw.js', 'utf8');
  check('sw cache bumped to v11', swText.indexOf("penny-alerts-v11") !== -1, true);
  check('sw has push handler', swText.indexOf("addEventListener('push'") !== -1, true);
  check('sw push shows a notification', swText.indexOf('showNotification') !== -1, true);
  check('sw has notificationclick handler', swText.indexOf("addEventListener('notificationclick'") !== -1, true);
  check('app.js has no VAPID private key', fs.readFileSync('/home/hatch/workspace/penny-alerts/app.js', 'utf8').indexOf('VAPID_PRIVATE_KEY') === -1, true);

  /* 10. sender dry-run with fixtures (real scripts/send-push.py) */
  const senderOld = { generated_at: '2026-11-22T10:00:00+00:00', sources: [], items: [
    { name: 'Old Penny Item', upc: '012345678901', price: '$0.01', retailer: 'dollar-general', department: 'Penny', source: 'thefreebieguy.com', first_seen: '2026-11-21', image: '' },
    { name: 'Old Named Deal', upc: '', price: '$5.00', retailer: 'amazon', department: 'General', source: 'slickdeals.net', first_seen: '2026-11-21', image: '' }
  ] };
  const senderNew = { generated_at: '2026-11-22T11:00:00+00:00', sources: [], items: senderOld.items.concat([
    { name: 'New Penny Item', upc: '012345678902', price: '$0.01', retailer: 'dollar-general', department: 'Penny', source: 'thefreebieguy.com', first_seen: '2026-11-22', image: 'https://images.openfoodfacts.org/images/products/test.jpg' },
    { name: 'Brand New Deal', upc: '', price: '$9.99', retailer: 'target', department: 'General', source: 'slickdeals.net', first_seen: '2026-11-22', image: '' }
  ]) };
  fs.writeFileSync('/tmp/pa-sender-old.json', JSON.stringify(senderOld));
  fs.writeFileSync('/tmp/pa-sender-new.json', JSON.stringify(senderNew));
  const senderPath = '/home/hatch/workspace/penny-alerts/scripts/send-push.py';
  const dryOut = execFileSync('python3', [senderPath, '--dry-run', '--feed', '/tmp/pa-sender-new.json', '--old-feed', '/tmp/pa-sender-old.json'], { encoding: 'utf8' });
  check('sender dry-run counts new items', dryOut.indexOf('2 new item(s)') !== -1, true);
  check('sender dry-run penny title', dryOut.indexOf('1 new penny deal') !== -1, true);
  check('sender dry-run names new penny', dryOut.indexOf('New Penny Item') !== -1, true);
  check('sender dry-run sends nothing', dryOut.indexOf('dry run') !== -1, true);
  const drySame = execFileSync('python3', [senderPath, '--dry-run', '--feed', '/tmp/pa-sender-old.json', '--old-feed', '/tmp/pa-sender-old.json'], { encoding: 'utf8' });
  check('sender dry-run no new items', drySame.indexOf('no new items') !== -1, true);
  /* Adding an image to an existing item is NOT a new item: the diff keys
   * on UPC / name+retailer, never on the image field. */
  const senderImgOnly = { generated_at: '2026-11-22T12:00:00+00:00', sources: [], items: [
    { name: 'Old Penny Item', upc: '012345678901', price: '$0.01', retailer: 'dollar-general', department: 'Penny', source: 'thefreebieguy.com', first_seen: '2026-11-21', image: 'https://images.openfoodfacts.org/images/products/test.jpg' },
    { name: 'Old Named Deal', upc: '', price: '$5.00', retailer: 'amazon', department: 'General', source: 'slickdeals.net', first_seen: '2026-11-21', image: '' }
  ] };
  fs.writeFileSync('/tmp/pa-sender-img.json', JSON.stringify(senderImgOnly));
  const dryImg = execFileSync('python3', [senderPath, '--dry-run', '--feed', '/tmp/pa-sender-img.json', '--old-feed', '/tmp/pa-sender-old.json'], { encoding: 'utf8' });
  check('sender: image-only change is not a new item', dryImg.indexOf('no new items') !== -1, true);

  /* 11. deal photos (v5) */
  const withImg = PA.thumbHtml({ dept: 'Penny', image: 'https://images.thdstatic.com/productImages/test/svn/test-screw-64_600.jpg' });
  check('thumb with image renders lazy img', withImg.indexOf('<img src="https://images.thdstatic.com/productImages/test/svn/test-screw-64_600.jpg" alt="" loading="lazy"') !== -1, true);
  check('thumb img has onerror fallback', withImg.indexOf('onerror="this.remove()"') !== -1, true);
  const noImg = PA.thumbHtml({ dept: 'Penny', image: '' });
  check('thumb without image renders placeholder', noImg.indexOf('deal-thumb-ph') !== -1, true);
  check('thumb without image has no img tag', noImg.indexOf('<img') === -1, true);
  check('thumb placeholder is a glyph, not a big letter', noImg.indexOf('<svg') !== -1 && noImg.indexOf('>P<') === -1, true);
  check('thumb placeholder names the department', noImg.indexOf('deal-thumb-ph-label') !== -1 && noImg.indexOf('>Penny<') !== -1, true);
  const noImgElec = PA.thumbHtml({ dept: 'Electronics', image: '' });
  check('thumb placeholder label follows dept', noImgElec.indexOf('>Electronics<') !== -1, true);
  const dealHtml = els['dealList'].innerHTML;
  check('rendered cards include the fixture HD image', dealHtml.indexOf('https://images.thdstatic.com/productImages/test/svn/test-screw-64_600.jpg') !== -1, true);
  check('rendered cards use lazy loading', dealHtml.indexOf('loading="lazy"') !== -1, true);
  check('rendered cards include placeholders', dealHtml.indexOf('deal-thumb-ph') !== -1, true);
  /* Real feed (written by the parser run): every item carries an image
   * field; every image is an absolute http(s) URL; no image points at a
   * retailer store/checker domain. PennyRecon's photos live on Home
   * Depot's image CDN (images.thdstatic.com) — the URL PennyRecon itself
   * embeds, not a scraped retailer page — so thdstatic is allowed here
   * and documented in README.md. */
  const realWeekly = JSON.parse(fs.readFileSync('/home/hatch/workspace/penny-alerts/feed/weekly.json', 'utf8'));
  check('real feed items all carry an image field', realWeekly.items.every(function (it) { return typeof it.image === 'string'; }), true);
  const RETAILER_IMG_HOSTS = ['walmart.com', 'homedepot.com', 'target.com', 'dollargeneral.com', 'brickseek.com', 'amazon.com', 'ebay.com'];
  const badImgs = realWeekly.items.filter(function (it) {
    if (!it.image) return false;
    if (!/^https?:\/\//.test(it.image)) return true;
    const host = it.image.split('/')[2] || '';
    return RETAILER_IMG_HOSTS.some(function (h) { return host === h || host.endsWith('.' + h); });
  });
  check('real feed has no retailer-store image domains', badImgs.length, 0);
  const imgCount = realWeekly.items.filter(function (it) { return !!it.image; }).length;
  console.log('COVERAGE real feed: ' + imgCount + '/' + realWeekly.items.length + ' items with images');
  const bySrc = {};
  realWeekly.items.forEach(function (it) {
    bySrc[it.source] = bySrc[it.source] || { total: 0, img: 0 };
    bySrc[it.source].total++;
    if (it.image) bySrc[it.source].img++;
  });
  Object.keys(bySrc).sort().forEach(function (s) {
    console.log('COVERAGE ' + s + ': ' + bySrc[s].img + '/' + bySrc[s].total);
  });
  check('real feed has some images', imgCount > 0, true);

  /* 12. seller links (v11) — ONE link per card: an Android intent: URL
   * (store app, Google fallback) on Android, the plain https retailer
   * URL elsewhere, Google Shopping only for unmapped stores. Home Depot
   * searches by name; Dollar General opens the app's home screen (the
   * DG app rejects /product-search deep links). Store queries are
   * PUNCTUATION-FREE (v11): every non-alphanumeric character is
   * stripped — the HD app choked on '/' (v9) and '#' (v10) even when
   * encoded, and the screw still would not open with other punctuation
   * left in the path. The Google fallback keeps the RAW name/UPC.
   * DG's fallback is a Google WEB search for "<UPC or name> Dollar
   * General" (v11), not Shopping. No BrickSeek anywhere, no modal. */
  function intentUrl(host, pathQ, pkg, deal) {
    var g = 'https://www.google.com/search?tbm=shop&q=' + encodeURIComponent(deal.upc || deal.name || '');
    return 'intent://' + host + pathQ + '#Intent;scheme=https;package=' + pkg + ';S.browser_fallback_url=' + encodeURIComponent(g) + ';end';
  }
  function intentUrlDg(deal) {
    var g = 'https://www.google.com/search?q=' + encodeURIComponent((deal.upc || deal.name || '') + ' Dollar General');
    return 'intent://www.dollargeneral.com/#Intent;scheme=https;package=com.dollargeneral.android;S.browser_fallback_url=' + encodeURIComponent(g) + ';end';
  }
  function fallbackOf(intent) {
    var m = intent.match(/;S\.browser_fallback_url=([^;]*);end$/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  sandbox.navigator.userAgent = ANDROID_UA;
  const slHdName = PA.sellerLinks({ storeId: 'home-depot', sku: '1012-308-531', upc: '', name: 'Test Screw' });
  check('seller links: HD searches by name, not SKU', slHdName[0].url, intentUrl('www.homedepot.com', '/s/Test%20Screw', 'com.thehomedepot', { upc: '', name: 'Test Screw' }));
  check('seller links: HD label is app-first', slHdName[0].label, 'Open in Home Depot app');
  check('seller links: HD is exactly one link', slHdName.length, 1);
  const slHdSkuUpc = PA.sellerLinks({ storeId: 'home-depot', sku: '1001-685-761', upc: '012345678905', name: 'Test Screw' });
  check('seller links: HD ignores SKU and UPC, uses name', slHdSkuUpc[0].url, intentUrl('www.homedepot.com', '/s/Test%20Screw', 'com.thehomedepot', { upc: '012345678905', name: 'Test Screw' }));
  const slHd = PA.sellerLinks({ storeId: 'home-depot', upc: '', name: 'Test Screw' });
  check('seller links: HD name-only searches by name', slHd[0].url, intentUrl('www.homedepot.com', '/s/Test%20Screw', 'com.thehomedepot', { upc: '', name: 'Test Screw' }));
  const slWm = PA.sellerLinks({ storeId: 'wm-ct', upc: '012345678905', name: 'Test Item' });
  check('seller links: Walmart intent URL for wm-ct + UPC', slWm[0].url, intentUrl('www.walmart.com', '/search?q=012345678905', 'com.walmart.android', { upc: '012345678905', name: 'Test Item' }));
  check('seller links: Walmart label is app-first', slWm[0].label, 'Open in Walmart app');
  check('seller links: Walmart is exactly one link', slWm.length, 1);
  const slWmNoUpc = PA.sellerLinks({ storeId: 'walmart', upc: '', name: 'Blue Widget 12oz' });
  check('seller links: Walmart without UPC searches by name', slWmNoUpc[0].url, intentUrl('www.walmart.com', '/search?q=Blue%20Widget%2012oz', 'com.walmart.android', { upc: '', name: 'Blue Widget 12oz' }));
  const slTg = PA.sellerLinks({ storeId: 'target', upc: '012345678905', name: 'Test Item' });
  check('seller links: Target intent URL', slTg[0].url, intentUrl('www.target.com', '/s?searchTerm=012345678905', 'com.target.ui', { upc: '012345678905', name: 'Test Item' }));
  check('seller links: Target label is app-first', slTg[0].label, 'Open in Target app');
  const slTgNoUpc = PA.sellerLinks({ storeId: 'target', upc: '', name: 'Blue Widget 12oz' });
  check('seller links: Target without UPC searches by name', slTgNoUpc[0].url, intentUrl('www.target.com', '/s?searchTerm=Blue%20Widget%2012oz', 'com.target.ui', { upc: '', name: 'Blue Widget 12oz' }));
  check('seller links: intent fallback is the Google Shopping URL (HD)', fallbackOf(slHdSkuUpc[0].url), 'https://www.google.com/search?tbm=shop&q=012345678905');
  check('seller links: intent fallback is the Google Shopping URL (WM)', fallbackOf(slWm[0].url), 'https://www.google.com/search?tbm=shop&q=012345678905');
  check('seller links: intent fallback is the Google Shopping URL (TG)', fallbackOf(slTg[0].url), 'https://www.google.com/search?tbm=shop&q=012345678905');
  const slDg = PA.sellerLinks({ storeId: 'dollar-general', upc: '012345678905', name: 'Test Item' });
  check('seller links: DG intent opens app home screen', slDg[0].url, intentUrlDg({ upc: '012345678905', name: 'Test Item' }));
  check('seller links: DG label is app-first', slDg[0].label, 'Open in Dollar General app');
  check('seller links: DG is exactly one link', slDg.length, 1);
  const slDgNoUpc = PA.sellerLinks({ storeId: 'dollar-general', upc: '', name: 'Blue Widget 12oz' });
  check('seller links: DG without UPC still opens app home screen', slDgNoUpc[0].url, intentUrlDg({ upc: '', name: 'Blue Widget 12oz' }));
  check('seller links: DG fallback is a Google WEB search (UPC)', fallbackOf(slDg[0].url), 'https://www.google.com/search?q=012345678905%20Dollar%20General');
  check('seller links: DG fallback is a Google WEB search (name)', fallbackOf(slDgNoUpc[0].url), 'https://www.google.com/search?q=Blue%20Widget%2012oz%20Dollar%20General');
  check('seller links: DG fallback has no tbm=shop', fallbackOf(slDg[0].url).indexOf('tbm=shop') === -1, true);
  check('seller links: no product-search anywhere', JSON.stringify([].concat(slWm, slWmNoUpc, slTg, slHdName, slHdSkuUpc, slHd, slDg, slDgNoUpc)).indexOf('product-search') === -1, true);
  check('seller links: no productSearchedMode anywhere', JSON.stringify([].concat(slWm, slWmNoUpc, slTg, slHdName, slHdSkuUpc, slHd, slDg, slDgNoUpc)).indexOf('productSearchedMode') === -1, true);
  /* v11: store queries are PUNCTUATION-FREE — every non-alphanumeric
   * character is stripped, words intact, in order. The HD app choked
   * on '/' (v9) and '#' (v10) even when encoded, and the screw still
   * would not open with other punctuation left in the path. */
  const slHdSlash = PA.sellerLinks({ storeId: 'home-depot', upc: '', name: '1-1/2 in. x 5 in. Nail Plate Bulk (100-Pack)' });
  check('seller links: HD nail plate is punctuation-free', slHdSlash[0].url, intentUrl('www.homedepot.com', '/s/1%201%202%20in%20x%205%20in%20Nail%20Plate%20Bulk%20100%20Pack', 'com.thehomedepot', { upc: '', name: '1-1/2 in. x 5 in. Nail Plate Bulk (100-Pack)' }));
  check('seller links: HD /s/ path has no %2F', slHdSlash[0].url.split('/s/')[1].split('#Intent')[0].indexOf('%2F') === -1, true);
  check('seller links: HD /s/ path has no literal slash', slHdSlash[0].url.split('/s/')[1].split('#Intent')[0].indexOf('/') === -1, true);
  check('seller links: HD /s/ path has no %28 %29 %2E %2D', ['%28', '%29', '%2E', '%2D'].every(function (p) { return slHdSlash[0].url.split('/s/')[1].split('#Intent')[0].indexOf(p) === -1; }), true);
  const slHdHash = PA.sellerLinks({ storeId: 'home-depot', upc: '', name: '#10 x 1-3/4 in. Black 6-Lobe Torx Drive Exterior Flat Head Multi-Material Screw 1 lb. -Box (106-Piece)' });
  check('seller links: HD screw URL exact, punctuation-free', slHdHash[0].url, intentUrl('www.homedepot.com', '/s/10%20x%201%203%204%20in%20Black%206%20Lobe%20Torx%20Drive%20Exterior%20Flat%20Head%20Multi%20Material%20Screw%201%20lb%20Box%20106%20Piece', 'com.thehomedepot', { upc: '', name: '#10 x 1-3/4 in. Black 6-Lobe Torx Drive Exterior Flat Head Multi-Material Screw 1 lb. -Box (106-Piece)' }));
  check('seller links: HD screw query starts with 10', slHdHash[0].url.split('#Intent')[0].indexOf('10%20x%201%203%204') !== -1, true);
  check('seller links: HD data part has no %23', slHdHash[0].url.split('#Intent')[0].indexOf('%23') === -1, true);
  check('seller links: HD data part has no literal #', slHdHash[0].url.split('#Intent')[0].indexOf('#') === -1, true);
  check('seller links: HD screw data part has no %28 %29 %2E %2D', ['%28', '%29', '%2E', '%2D'].every(function (p) { return slHdHash[0].url.split('#Intent')[0].indexOf(p) === -1; }), true);
  /* The Google fallback keeps the RAW name/UPC — punctuation still
   * present, encoded — even though the store query is stripped. */
  check('seller links: HD fallback keeps raw name with # and /', fallbackOf(slHdHash[0].url), 'https://www.google.com/search?tbm=shop&q=%2310%20x%201-3%2F4%20in.%20Black%206-Lobe%20Torx%20Drive%20Exterior%20Flat%20Head%20Multi-Material%20Screw%201%20lb.%20-Box%20(106-Piece)');
  const slHashMid = PA.sellerLinks({ storeId: 'home-depot', upc: '', name: 'Screw #10 Pack' });
  check('seller links: mid-string # stripped', slHashMid[0].url.split('#Intent')[0].indexOf('Screw%2010%20Pack') !== -1, true);
  const slWmHash = PA.sellerLinks({ storeId: 'wm-ct', upc: '', name: 'Item #5' });
  check('seller links: Walmart # stripped too', slWmHash[0].url.split('#Intent')[0].indexOf('Item%205') !== -1, true);
  const slWmPunct = PA.sellerLinks({ storeId: 'walmart', upc: '', name: 'Widget, 12-oz (2-Pack)!' });
  check('seller links: Walmart name query is punctuation-free', slWmPunct[0].url.split('/search?q=')[1].split('#Intent')[0], 'Widget%2012%20oz%202%20Pack');
  const slTgPunct = PA.sellerLinks({ storeId: 'target', upc: '', name: 'Widget, 12-oz (2-Pack)!' });
  check('seller links: Target name query is punctuation-free', slTgPunct[0].url.split('searchTerm=')[1].split('#Intent')[0], 'Widget%2012%20oz%202%20Pack');
  check('seller links: unknown retailer gets only the Google link', PA.sellerLinks({ storeId: 'amazon', upc: '012345678905', name: 'X' }).length, 1);
  check('seller links: no buy language anywhere', JSON.stringify([].concat(slWm, slTg, slHd, slHdName, slDg)).toLowerCase().indexOf('buy') === -1, true);
  check('seller links: no utm params in any link', JSON.stringify([].concat(slWm, slWmNoUpc, slTg, slHdName, slHdSkuUpc, slHd, slDg, slDgNoUpc)).indexOf('utm_') === -1, true);
  check('seller links: Android links are intent: URLs', [].concat(slWm, slWmNoUpc, slTg, slHdName, slHdSkuUpc, slHd, slDg, slDgNoUpc).every(function (l) { return l.url.indexOf('intent://') === 0; }), true);
  /* Non-Android: same deals return the plain https retailer URLs (v6 behavior). */
  sandbox.navigator.userAgent = IPHONE_UA;
  check('seller links: non-Android Walmart is plain https', PA.sellerLinks({ storeId: 'wm-ct', upc: '012345678905', name: 'Test Item' })[0].url, 'https://www.walmart.com/search?q=012345678905');
  check('seller links: non-Android HD is plain https by name', PA.sellerLinks({ storeId: 'home-depot', sku: '1012-308-531', upc: '', name: 'Test Screw' })[0].url, 'https://www.homedepot.com/s/Test%20Screw');
  check('seller links: non-Android Target is plain https', PA.sellerLinks({ storeId: 'target', upc: '012345678905', name: 'Test Item' })[0].url, 'https://www.target.com/s?searchTerm=012345678905');
  check('seller links: non-Android DG is plain https home screen', PA.sellerLinks({ storeId: 'dollar-general', upc: '012345678905', name: 'Test Item' })[0].url, 'https://www.dollargeneral.com/');
  check('seller links: non-Android HD is punctuation-free', PA.sellerLinks({ storeId: 'home-depot', upc: '', name: '1-1/2 in. x 5 in. Nail Plate Bulk (100-Pack)' })[0].url, 'https://www.homedepot.com/s/1%201%202%20in%20x%205%20in%20Nail%20Plate%20Bulk%20100%20Pack');
  check('seller links: non-Android HD plain URL has no %2F', PA.sellerLinks({ storeId: 'home-depot', upc: '', name: '1-1/2 in. x 5 in. Nail Plate Bulk (100-Pack)' })[0].url.indexOf('%2F') === -1, true);
  check('seller links: non-Android HD screw is punctuation-free', PA.sellerLinks({ storeId: 'home-depot', upc: '', name: '#10 x 1-3/4 in. Black Screw' })[0].url, 'https://www.homedepot.com/s/10%20x%201%203%204%20in%20Black%20Screw');
  sandbox.navigator.userAgent = '';
  const realHd = realWeekly.items.filter(function (it) { return it.retailer === 'home-depot'; })[0];
  const realHdNorm = realHd ? PA.normalizeWeekly({ items: [realHd] }).deals[0] : null;
  check('real feed: HD link searches by product name', realHdNorm ? PA.sellerLinks(realHdNorm)[0].url : '', realHdNorm ? 'https://www.homedepot.com/s/' + encodeURIComponent(realHdNorm.name.replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()) : '');
  check('real feed: HD link does not contain the SKU', realHdNorm ? PA.sellerLinks(realHdNorm)[0].url.indexOf(realHdNorm.sku.replace(/-/g, '')) === -1 : false, true);
  check('rendered cards include Google Shopping links', dealHtml.indexOf('google.com/search?tbm=shop') !== -1, true);
  const appText = fs.readFileSync('/home/hatch/workspace/penny-alerts/app.js', 'utf8');
  const htmlText = fs.readFileSync('/home/hatch/workspace/penny-alerts/index.html', 'utf8');
  const cssText = fs.readFileSync('/home/hatch/workspace/penny-alerts/styles.css', 'utf8');
  check('no modal code in app.js', appText.toLowerCase().indexOf('modal') === -1, true);
  check('no brickseek string anywhere in app.js', appText.toLowerCase().indexOf('brickseek') === -1, true);
  check('no Check on BrickSeek label anywhere in app.js', appText.indexOf('Check on BrickSeek') === -1, true);
  check('no modal markup in index.html', htmlText.toLowerCase().indexOf('modal') === -1, true);
  check('no modal styles in styles.css', cssText.toLowerCase().indexOf('modal') === -1, true);

  /* 13. store filter options (v9) — weekly deals only, counts, most first. */
  const sfoTwo = PA.storeFilterOptions([
    { storeId: 'home-depot' }, { storeId: 'dollar-general' }, { storeId: 'home-depot' }
  ]);
  check('store filter: counts sorted desc with Name (N) labels', JSON.stringify(sfoTwo), JSON.stringify([
    { value: '', label: 'All stores' },
    { value: 'home-depot', label: 'Home Depot (2)' },
    { value: 'dollar-general', label: 'Dollar General (1)' }
  ]));
  check('store filter: unknown id falls back to title-cased id', PA.storeFilterOptions([{ storeId: 'some-new-shop' }])[1].label, 'Some New Shop (1)');
  check('store filter: empty deals give only All stores', PA.storeFilterOptions([]).length, 1);
  check('store filter: null deals give only All stores', PA.storeFilterOptions(null).length, 1);
  check('store filter: rendered select matches weekly deals', els['retailerFilter'].options.map(function (o) { return o.value; }).join(','), PA.storeFilterOptions(st.weeklyDeals).map(function (o) { return o.value; }).join(','));
  check('store filter: rendered labels carry counts', els['retailerFilter'].options.map(function (o) { return o.textContent; }).join('|'), PA.storeFilterOptions(st.weeklyDeals).map(function (o) { return o.label; }).join('|'));

  /* 14. department filter options (v9) — classified depts, counts, no Penny. */
  const dfoFix = PA.deptFilterOptions([
    { dept: 'Tools' }, { dept: 'Grocery' }, { dept: 'Tools' }, { dept: 'General' }
  ]);
  check('dept filter: counts sorted desc with Name (N) labels', JSON.stringify(dfoFix), JSON.stringify([
    { value: '', label: 'All departments' },
    { value: 'Tools', label: 'Tools (2)' },
    { value: 'General', label: 'General (1)' },
    { value: 'Grocery', label: 'Grocery (1)' }
  ]));
  check('dept filter: empty deals give only All departments', PA.deptFilterOptions([]).length, 1);
  check('dept filter: null deals give only All departments', PA.deptFilterOptions(null).length, 1);
  check('dept filter: rendered select has no Penny option', els['deptFilter'].options.map(function (o) { return o.value; }).indexOf('Penny') === -1, true);
  check('dept filter: rendered select matches weekly deals', els['deptFilter'].options.map(function (o) { return o.value; }).join(','), PA.deptFilterOptions(st.weeklyDeals).map(function (o) { return o.value; }).join(','));
  check('dept filter: All departments first', els['deptFilter'].options[0].value, '');

  /* 15. copy button + version footer (v11). */
  /* Every rendered deal card carries a Copy button next to the name,
   * carrying the deal's full raw name in data-name. The fixture
   * weekly deal is one of the first rendered cards. */
  check('deal cards carry a Copy button', dealHtml.indexOf('data-action="copy"') !== -1, true);
  check('deal Copy button carries the raw name', dealHtml.indexOf('data-name="Weekly Test HD Screw"') !== -1, true);
  check('deal Copy button reads Copy', dealHtml.indexOf('>Copy</button>') !== -1, true);
  /* The copy handler writes exactly the raw name (punctuation intact)
   * to the stubbed clipboard and flips the button to "Copied". */
  const written = [];
  sandbox.navigator.clipboard = { writeText: function (t) { written.push(t); return Promise.resolve(); } };
  const copyBtn = new StubEl('button');
  copyBtn.textContent = 'Copy';
  const rawName = '#10 x 1-3/4 in. Black 6-Lobe Torx Drive Exterior Flat Head Multi-Material Screw 1 lb. -Box (106-Piece)';
  await PA.copyDealName(rawName, copyBtn);
  check('copy handler writes the exact raw name', written, [rawName]);
  check('copy button flips to Copied', copyBtn.textContent, 'Copied');
  /* Without the clipboard API the handler falls back (no stub body in
   * this env, so it returns null) and never throws. */
  delete sandbox.navigator.clipboard;
  const copyBtn2 = new StubEl('button');
  copyBtn2.textContent = 'Copy';
  check('copy without clipboard API returns null', await PA.copyDealName('Some Item', copyBtn2), null);
  check('copy without clipboard API leaves button alone', copyBtn2.textContent, 'Copy');
  /* Watchlist cards carry the same Copy button. */
  PA._handleAction('watch', firstPenny);
  const watchHtml = els['watchList'].innerHTML;
  check('watchlist cards carry a Copy button', watchHtml.indexOf('data-action="copy"') !== -1, true);
  check('watchlist Copy button carries the raw name', watchHtml.indexOf('data-name="' + pennies[1].name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') + '"') !== -1, true);
  PA._handleAction('unwatch', firstPenny);
  /* Version footer: APP_VERSION is v11, the page footer reads
   * "Penny Alerts v11", and init() set the rendered element. */
  check('APP_VERSION is v11', PA.APP_VERSION, 'v11');
  check('index.html footer reads Penny Alerts v11', htmlText.indexOf('Penny Alerts v11') !== -1, true);
  check('rendered version footer reads Penny Alerts v11', els['appVersion'].textContent, 'Penny Alerts v11');

  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})().catch(function (e) { console.error('HARNESS ERROR', e); process.exit(1); });
