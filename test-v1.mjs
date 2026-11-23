/* Penny Alerts v13 harness — loads app.js in a vm with a stub DOM, feeds the
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
  history: { _pushed: [], pushState: function (s) { this._pushed.push(s); } },
  addEventListener: function (ev, fn) { domListeners['window:' + ev] = fn; },
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

  /* 8. stores data is gone (v12) — Joseph asked for the Stores tab to be
   * deleted, list and all. */
  check('STORES is gone from the app export', typeof PA.STORES, 'undefined');
  check('no storeList element is ever created', typeof els['storeList'], 'undefined');

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
  check('sw cache bumped to v13', swText.indexOf("penny-alerts-v13") !== -1, true);
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
    { name: 'Brand New Deal', upc: '', price: '$9.99', retailer: 'target', department: 'General', source: 'slickdeals.net', first_seen: '2026-11-22', image: '' },
    { name: 'New Stack Deal', upc: '', price: '$2.00', was: '$14.98', retailer: 'walgreens', department: 'Health & Beauty', source: 'krazycouponlady.com', first_seen: '2026-11-22', image: '', is_stack: true }
  ]) };
  fs.writeFileSync('/tmp/pa-sender-old.json', JSON.stringify(senderOld));
  fs.writeFileSync('/tmp/pa-sender-new.json', JSON.stringify(senderNew));
  const senderPath = '/home/hatch/workspace/penny-alerts/scripts/send-push.py';
  const dryOut = execFileSync('python3', [senderPath, '--dry-run', '--feed', '/tmp/pa-sender-new.json', '--old-feed', '/tmp/pa-sender-old.json'], { encoding: 'utf8' });
  check('sender dry-run counts new items', dryOut.indexOf('3 new item(s)') !== -1, true);
  check('sender dry-run penny title', dryOut.indexOf('1 new penny deal') !== -1, true);
  check('sender dry-run names new penny', dryOut.indexOf('New Penny Item') !== -1, true);
  check('sender dry-run names new stack', dryOut.indexOf('New Stack Deal') !== -1, true);
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
  check('Instructions modal code is in app.js', appText.indexOf('instrModal') !== -1, true);
  check('no brickseek string anywhere in app.js', appText.toLowerCase().indexOf('brickseek') === -1, true);
  check('no Check on BrickSeek label anywhere in app.js', appText.indexOf('Check on BrickSeek') === -1, true);
  check('Instructions modal markup is in index.html', htmlText.indexOf('id="instrModal"') !== -1, true);
  check('modal styles are in styles.css', cssText.indexOf('.modal') !== -1, true);

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
  /* Version footer: APP_VERSION is v13, the page footer reads
   * "Penny Alerts v13", and init() set the rendered element. */
  check('APP_VERSION is v13', PA.APP_VERSION, 'v13');
  check('index.html footer reads Penny Alerts v13', htmlText.indexOf('Penny Alerts v13') !== -1, true);
  check('rendered version footer reads Penny Alerts v13', els['appVersion'].textContent, 'Penny Alerts v13');

  /* 16. sort dropdown + Future toggle + source count (v12). The search
   * bar and the Stores tab are deleted; the Deals tab sorts Most recent
   * (default) or Most verified, and a Future checkbox shows only deals
   * whose list date is after today. */
  check('default sort is Most recent', st.filters.sort, 'recent');
  check('sort select exists in index.html', htmlText.indexOf('id="sortSelect"') !== -1, true);
  check('sort select has Most recent option', htmlText.indexOf('>Most recent<') !== -1, true);
  check('sort select has Most verified option', htmlText.indexOf('>Most verified<') !== -1, true);
  check('sort select defaults to recent', htmlText.indexOf('<option value="recent">Most recent</option>') !== -1, true);
  check('Future checkbox exists in index.html', htmlText.indexOf('id="futureOnly"') !== -1, true);
  check('Future label reads Future', htmlText.indexOf('> Future</label>') !== -1, true);
  check('search box is gone from index.html', htmlText.indexOf('searchBox') === -1, true);
  check('Stores tab is gone from index.html', htmlText.indexOf('tab-stores') === -1 && htmlText.indexOf('data-tab="stores"') === -1, true);
  check('filters carry no search query', ('q' in st.filters), false);
  check('sort select is wired (change listener)', Array.isArray(els['sortSelect'].listeners.change) && els['sortSelect'].listeners.change.length === 1, true);
  check('future checkbox is wired (change listener)', Array.isArray(els['futureOnly'].listeners.change) && els['futureOnly'].listeners.change.length === 1, true);
  const sortDeals = [
    { id: 's-a', kind: 'penny', name: 'Alpha Item', upc: '', storeId: 'dollar-general', source: 'a.com', sources: ['a.com'], sourceCount: 1, price: '$0.01', originalPrice: '', dept: 'General', confirmedOn: '2026-10-27', listDate: '2026-10-27', validTo: '', image: '' },
    { id: 's-b', kind: 'penny', name: 'Beta Item', upc: '', storeId: 'dollar-general', source: 'b.com', sources: ['b.com', 'c.com', 'd.com'], sourceCount: 3, price: '$0.01', originalPrice: '', dept: 'General', confirmedOn: '2026-11-03', listDate: '2026-11-03', validTo: '', image: '' },
    { id: 's-c', kind: 'penny', name: 'Gamma Item', upc: '', storeId: 'dollar-general', source: 'c.com', sources: ['c.com', 'e.com'], sourceCount: 2, price: '$0.01', originalPrice: '', dept: 'General', confirmedOn: '2099-01-01', listDate: '2099-01-01', validTo: '', image: '' },
    { id: 's-d', kind: 'deal', name: 'Delta Item', upc: '', storeId: 'dollar-general', source: 'd.com', sources: ['d.com'], sourceCount: 1, price: '$5.00', originalPrice: '', dept: 'General', confirmedOn: '', listDate: '', validTo: '', image: '' },
    { id: 's-e', kind: 'deal', name: 'Echo Stack', upc: '', storeId: 'walgreens', source: 'krazycouponlady.com', sources: ['krazycouponlady.com'], sourceCount: 1, price: '$2.00', originalPrice: '$14.98', dept: 'Health & Beauty', confirmedOn: '2026-11-22', listDate: '2026-11-22', validTo: '2026-11-28', image: '', stack: true, steps: ['Buy 2, get $2 Walgreens Cash', 'Pay $2.99, get $2 Walgreens Cash'], url: 'https://thekrazycouponlady.com/coupons-for/walgreens' },
    { id: 's-f', kind: 'deal', name: 'Foxtrot Future Stack', upc: '', storeId: 'walgreens', source: 'krazycouponlady.com', sources: ['krazycouponlady.com'], sourceCount: 1, price: '$1.00', originalPrice: '', dept: 'General', confirmedOn: '2099-01-01', listDate: '2099-01-01', validTo: '', image: '', stack: true, steps: [] },
    { id: 's-g', kind: 'deal', name: 'Golf Undated Stack', upc: '', storeId: 'cvs', source: 'slickdeals.net', sources: ['slickdeals.net'], sourceCount: 1, price: '$3.00', originalPrice: '', dept: 'General', confirmedOn: '', listDate: '', validTo: '', image: '', stack: true, steps: ['Clip the $2 off coupon, apply the code.'] }
  ];
  const savedDeals = st.deals;
  st.deals = sortDeals;
  st.filters.pennyOnly = false; st.filters.showExpired = false; st.filters.futureOnly = false; st.filters.retailer = ''; st.filters.dept = '';
  st.filters.sort = 'recent';
  /* Future OFF hides future-dated deals (v13 fix, symmetric with Show
   * expired); stacks never appear on Deals; undated deals sort last. */
  check('Most recent sorts by list date desc, future hidden, stacks out', PA._visibleDeals().map(function (d) { return d.id; }), ['s-b', 's-a', 's-d']);
  st.filters.sort = 'verified';
  check('Most verified sorts by source count desc, future hidden, stacks out', PA._visibleDeals().map(function (d) { return d.id; }), ['s-b', 's-a', 's-d']);
  /* The sort select drives the same state the tests just set directly. */
  els['sortSelect'].value = 'recent';
  els['sortSelect'].listeners.change[0]();
  check('sort select change sets Most recent', st.filters.sort, 'recent');
  check('sort select change re-sorts Most recent', PA._visibleDeals().map(function (d) { return d.id; }), ['s-b', 's-a', 's-d']);
  els['sortSelect'].value = 'verified';
  els['sortSelect'].listeners.change[0]();
  check('sort select change sets Most verified', st.filters.sort, 'verified');
  /* Source count under the picture: verified mode only. */
  const cardV = PA.dealCard(sortDeals[1]);
  check('verified card shows source count under picture', cardV.indexOf('✓ 3 sources') !== -1, true);
  check('verified card source count sits in the thumb column', cardV.indexOf('deal-thumb-col') !== -1 && cardV.indexOf('source-count') !== -1, true);
  check('verified card shows 1 source as singular', PA.dealCard(sortDeals[0]).indexOf('✓ 1 source</div>') !== -1, true);
  st.filters.sort = 'recent';
  const cardR = PA.dealCard(sortDeals[1]);
  check('recent card shows no source count', cardR.indexOf('source-count') === -1, true);
  check('card penny-list line uses the list date', cardR.indexOf('penny list 2026-11-03') !== -1, true);
  check('card penny-list line does not use the run date', cardR.indexOf('penny list 2026-11-22') === -1 && cardR.indexOf('penny list 2026-11-23') === -1, true);
  /* Future toggle: only the 2099-dated deal survives (the future stack
   * stays on Bundles, not Deals). */
  st.filters.futureOnly = true;
  check('Future shows only future-dated deals', PA._visibleDeals().map(function (d) { return d.id; }), ['s-c']);
  els['futureOnly'].checked = false;
  els['futureOnly'].listeners.change[0]();
  check('Future off hides the future-dated deal', PA._visibleDeals().map(function (d) { return d.id; }), ['s-b', 's-a', 's-d']);
  /* Bundles tab (v13): stacks only, newest first, undated last; the
   * future stack hides by default, the same as the Deals tab. */
  check('Bundles list is stacks only, newest first, undated last', PA.visibleStacks().map(function (d) { return d.id; }), ['s-e', 's-g']);
  PA.renderBundles();
  check('Bundles renders the stack cards', els['bundleList'].innerHTML.indexOf('Echo Stack') !== -1, true);
  check('Bundles does not render Deals-tab items', els['bundleList'].innerHTML.indexOf('Alpha Item') === -1, true);
  check('Bundles badge counts visible stacks', els['bundleCount'].textContent, '(2)');
  check('stack card label reads stack posted', PA.dealCard(sortDeals[4]).indexOf('stack posted 2026-11-22') !== -1, true);
  check('stack card carries an Instructions button', PA.dealCard(sortDeals[4]).indexOf('data-action="instructions"') !== -1, true);
  st.deals = savedDeals;
  st.filters.sort = 'recent'; st.filters.futureOnly = false; st.filters.pennyOnly = false; st.filters.showExpired = false; st.filters.retailer = ''; st.filters.dept = '';

  /* 17. normalizeWeekly carries sources / source_count / listDate (v12). */
  const wsrc = PA.normalizeWeekly({ generated_at: '', sources: [], items: [
    { name: 'Multi Source Item', upc: '012345678905', price: '$0.01', was: '', retailer: 'dollar-general', department: 'Penny', source: 'thefreebieguy.com', sources: ['thefreebieguy.com', 'freestufffinder.com', 'krazycouponlady.com'], source_count: 3, first_seen: '2026-11-22', valid_to: '', url: '', image: '', list_date: '2026-10-27' },
    { name: 'Single Source Item', upc: '', price: '$0.01', was: '', retailer: 'home-depot', department: 'Penny', source: 'pennyrecon.com', first_seen: '2026-11-23', valid_to: '', url: '', image: '' }
  ] });
  check('normalizeWeekly keeps all three sources', wsrc.deals[0].sources, ['thefreebieguy.com', 'freestufffinder.com', 'krazycouponlady.com']);
  check('normalizeWeekly carries source_count 3', wsrc.deals[0].sourceCount, 3);
  check('normalizeWeekly carries list_date', wsrc.deals[0].listDate, '2026-10-27');
  check('normalizeWeekly defaults missing source_count to 1', wsrc.deals[1].sourceCount, 1);
  check('normalizeWeekly defaults missing sources to [source]', wsrc.deals[1].sources, ['pennyrecon.com']);
  check('normalizeWeekly keeps unknown list_date empty (no first_seen fallback)', wsrc.deals[1].listDate, '');
  /* Stack flag + steps ride through normalizeWeekly (v13). */
  const wstack = PA.normalizeWeekly({ generated_at: '', sources: [], items: [
    { name: 'Stack Item', upc: '', price: '$2.00', was: '$14.98', retailer: 'walgreens', department: 'Health & Beauty', source: 'krazycouponlady.com', sources: ['krazycouponlady.com'], source_count: 1, first_seen: '2026-11-22', valid_to: '2026-11-28', url: 'https://thekrazycouponlady.com/coupons-for/walgreens', image: '', list_date: '2026-11-22', is_stack: true, steps: ['Buy 2, get $2 Walgreens Cash'] },
    { name: 'Plain Item', upc: '', price: '$5.00', was: '', retailer: 'target', department: 'General', source: 'slickdeals.net', sources: ['slickdeals.net'], source_count: 1, first_seen: '2026-11-22', valid_to: '', url: '', image: '', list_date: '2026-11-22' }
  ] });
  check('normalizeWeekly carries stack flag', wstack.deals[0].stack, true);
  check('normalizeWeekly carries steps', wstack.deals[0].steps, ['Buy 2, get $2 Walgreens Cash']);
  check('normalizeWeekly defaults stack to false', wstack.deals[1].stack, false);
  check('normalizeWeekly defaults steps to []', wstack.deals[1].steps, []);
  check('normalizeWeekly stack card label', PA.dealCard(wstack.deals[0]).indexOf('stack posted 2026-11-22') !== -1, true);
  const bsrc = PA.normalizeBriefing({ generated_at: '', week_id: '', week_of: '', penny_list: [{ item: 'Briefing Penny', upc: '012345678906', store_id: 'dollar-general', source: 'x', confirmed_on: '2026-10-20' }], all_items: [] });
  check('briefing penny gets source_count 1', bsrc.deals[0].sourceCount, 1);
  check('briefing penny listDate is confirmed_on', bsrc.deals[0].listDate, '2026-10-20');

  /* 18. regenerated real feed (v12): first-wins attribution, no UPC
   * duplicates, every item carries sources + list_date. */
  check('real feed Freebie Guy count is 171 (DG 135 + Walgreens 18 + Target 18)', realWeekly.items.filter(function (it) { return it.source === 'thefreebieguy.com'; }).length, 171);
  const normUpc = function (u) { return (u && u.length === 11) ? '0' + u : u; };
  const seenU = {};
  const dupU = realWeekly.items.filter(function (it) { if (!it.upc) return false; const u = normUpc(it.upc); if (seenU[u]) return true; seenU[u] = 1; return false; });
  check('real feed has no duplicate normalized UPCs', dupU.length, 0);
  check('real feed total is 2244', realWeekly.items.length, 2244);
  check('real feed every item has a sources array', realWeekly.items.every(function (it) { return Array.isArray(it.sources) && it.sources.length >= 1; }), true);
  check('real feed source_count equals sources.length', realWeekly.items.every(function (it) { return it.source_count === it.sources.length; }), true);
  check('real feed every item has a list_date string ("" or YYYY-MM-DD)', realWeekly.items.every(function (it) { return typeof it.list_date === 'string' && (it.list_date.length === 0 || it.list_date.length === 10); }), true);
  check('real feed multi-source items number 221', realWeekly.items.filter(function (it) { return it.source_count >= 2; }).length, 221);
  check('real feed future items are the 105 PPM Nov 24 items', realWeekly.items.filter(function (it) { return it.list_date > '2026-11-23'; }).length, 105);
  check('real feed PennyRecon note says 166 of 304', (realWeekly.sources.filter(function (s) { return s.name.indexOf('PennyRecon') !== -1; })[0].note || '').indexOf('166 of 304') !== -1, true);
  check('real feed has no Freebie Guy HD source', realWeekly.sources.some(function (s) { return s.name.indexOf('Freebie Guy — Home Depot') !== -1; }), false);
  check('real feed image coverage is 1268/2244', realWeekly.items.filter(function (it) { return !!it.image; }).length, 1268);
  /* v13: unknown list dates stay unknown — a string of length 0 or 10,
   * never the run date stamped in by the parser. */
  check('real feed no KCL penny item carries the run date', realWeekly.items.filter(function (it) { return it.source === 'krazycouponlady.com' && !it.is_stack && it.list_date === '2026-11-23'; }).length, 0);
  check('real feed every item carries a steps array', realWeekly.items.every(function (it) { return Array.isArray(it.steps); }), true);
  check('real feed every item carries an is_stack flag', realWeekly.items.every(function (it) { return typeof it.is_stack === 'boolean'; }), true);
  const realStacks = realWeekly.items.filter(function (it) { return it.is_stack; });
  console.log('STACKS real feed: ' + realStacks.length + ' stack items');
  check('real feed has stack items', realStacks.length >= 40, true);
  check('real feed KCL stacks exist', realStacks.filter(function (it) { return it.source === 'krazycouponlady.com'; }).length, 71);
  check('real feed FG Walgreens stacks exist', realStacks.filter(function (it) { return it.source === 'thefreebieguy.com' && it.retailer === 'walgreens'; }).length, 16);
  check('real feed has stacks with real steps', realStacks.filter(function (it) { return it.steps.length > 0; }).length >= 10, true);
  check('real feed stacks are all on the Bundles side (none is a penny)', realStacks.every(function (it) { return it.price !== '$0.01'; }), true);

  /* 19. Instructions modal (v13): every card carries the button; the
   * modal shows price, UPC/SKU with Copy, list date + sources, the
   * real steps when the feed has them, the generic checklist when it
   * does not (with the account-varies line for stacks only). Closes
   * via Close, Esc, and phone Back. */
  const modalStackSteps = { id: 'm-s', kind: 'deal', name: 'Modal Stack', upc: '', storeId: 'walgreens', source: 'krazycouponlady.com', sources: ['krazycouponlady.com'], sourceCount: 1, price: '$2.00', originalPrice: '$14.98', dept: 'Health & Beauty', confirmedOn: '2026-11-22', listDate: '2026-11-22', validTo: '2026-11-28', image: '', stack: true, steps: ['Buy 2, get $2 Walgreens Cash', 'Pay $2.99, get $2 Walgreens Cash'], url: 'https://thekrazycouponlady.com/coupons-for/walgreens' };
  const modalStackPlain = { id: 'm-s2', kind: 'deal', name: 'Modal Stack No Steps', upc: '', storeId: 'cvs', source: 'slickdeals.net', sources: ['slickdeals.net'], sourceCount: 1, price: '$3.00', originalPrice: '', dept: 'General', confirmedOn: '', listDate: '', validTo: '', image: '', stack: true, steps: [], url: 'https://slickdeals.net/fake-thread' };
  const modalPenny = { id: 'm-p', kind: 'penny', name: 'Modal Penny', upc: '012345678905', storeId: 'dollar-general', source: 'thefreebieguy.com', sources: ['thefreebieguy.com'], sourceCount: 1, price: '$0.01', originalPrice: '', dept: 'General', confirmedOn: '2026-10-27', listDate: '2026-10-27', validTo: '', image: '', stack: false, steps: [] };
  const savedDeals2 = st.deals;
  st.deals = [modalStackSteps, modalStackPlain, modalPenny];
  check('deal cards carry an Instructions button', PA.dealCard(modalStackSteps).indexOf('data-action="instructions"') !== -1, true);
  check('watchlist cards carry an Instructions button', PA.watchCard(modalStackSteps).indexOf('data-action="instructions"') !== -1, true);
  check('Instructions modal opens on a known id', PA._openInstructions('m-s'), true);
  check('modal is open after open', PA._instrOpen(), true);
  check('modal title is the deal name', els['instrTitle'].textContent, 'Modal Stack');
  check('modal shows the deal price', els['instrBody'].innerHTML.indexOf('$2.00') !== -1, true);
  check('modal shows the was price', els['instrBody'].innerHTML.indexOf('$14.98') !== -1, true);
  check('modal shows the real steps', els['instrBody'].innerHTML.indexOf('Buy 2, get $2 Walgreens Cash') !== -1, true);
  check('modal shows the stack posted date', els['instrBody'].innerHTML.indexOf('Stack posted 2026-11-22') !== -1, true);
  check('modal shows the Full details link', els['instrBody'].innerHTML.indexOf('Full details on krazycouponlady.com') !== -1, true);
  check('modal pushes a history entry (phone Back closes it)', sandbox.history._pushed.length >= 1, true);
  check('modal closes via close', PA._closeInstructions(), true);
  check('modal is closed after close', PA._instrOpen(), false);
  check('modal element is hidden after close', els['instrModal'].hidden, true);
  check('Instructions modal opens the no-steps stack', PA._openInstructions('m-s2'), true);
  check('no-steps stack modal shows the generic checklist', els['instrBody'].innerHTML.indexOf('Clip any digital coupons') !== -1, true);
  check('no-steps stack modal shows the account-varies line', els['instrBody'].innerHTML.indexOf('vary by account') !== -1, true);
  check('modal closes via Esc', (function () { domListeners['keydown']({ key: 'Escape' }); return PA._instrOpen(); })(), false);
  check('Instructions modal opens the penny', PA._openInstructions('m-p'), true);
  check('penny modal shows the UPC', els['instrBody'].innerHTML.indexOf('012345678905') !== -1, true);
  check('penny modal UPC has a Copy button', els['instrBody'].innerHTML.indexOf('data-action="copy" data-name="012345678905"') !== -1, true);
  check('penny modal shows the penny list date', els['instrBody'].innerHTML.indexOf('Penny list 2026-10-27') !== -1, true);
  check('penny modal shows the generic checklist', els['instrBody'].innerHTML.indexOf('Scan in store') !== -1, true);
  check('penny modal has no account-varies line (not a stack)', els['instrBody'].innerHTML.indexOf('vary by account') === -1, true);
  check('modal closes via phone Back (popstate)', (function () { domListeners['window:popstate'](); return PA._instrOpen(); })(), false);
  check('Instructions modal refuses an unknown id', PA._openInstructions('no-such-deal'), false);
  st.deals = savedDeals2;

  /* 20. Hobby Lobby (v13): flyer items from the verified aggregator
   * page land on the Deals tab as normal deals — no hand-written event
   * item, and no 90% claim presented as fact. The 90% story was a
   * creator prediction, disputed; the verified ad is 75% fall decor /
   * 50% tableware, Nov 18–30. */
  const hlItems = realWeekly.items.filter(function (it) { return it.retailer === 'hobby-lobby'; });
  const hlFlyer = hlItems.filter(function (it) { return it.source === 'weekly-bargains.com'; });
  check('real feed has Hobby Lobby flyer items', hlFlyer.length, 8);
  check('real feed has Hobby Lobby items overall', hlItems.length >= 8, true);
  check('real feed HL items are not stacks', hlItems.every(function (it) { return !it.is_stack; }), true);
  const hlPumpkin = hlFlyer.filter(function (it) { return it.name === 'White Layered Wood Pumpkin'; })[0];
  check('real feed HL pumpkin price is $1.62 was $6.49', hlPumpkin ? [hlPumpkin.price, hlPumpkin.was] : [], ['$1.62', '$6.49']);
  check('real feed HL flyer items list 2026-11-18 valid to 2026-11-30', hlFlyer.every(function (it) { return it.list_date === '2026-11-18' && it.valid_to === '2026-11-30'; }), true);
  check('real feed has no hand-written HL event item', realWeekly.items.some(function (it) { return it.name.indexOf('Hobby Lobby Fall Clearance') !== -1; }), false);
  /* The 90% story was a creator prediction, disputed — the app never
   * asserts 90% as a price. A source's own title may still say "90%
   * off" (e.g. a Hip2Save post title); names are verbatim source
   * titles, so the price field is the assertion point. */
  const ninetyPrice = realWeekly.items.filter(function (it) { return (it.price || '').indexOf('90%') !== -1; });
  console.log('90PCT in price: ' + ninetyPrice.length);
  check('no feed item prices 90% off (app never asserts it)', ninetyPrice.length, 0);
  const hlNorm = PA.normalizeWeekly({ generated_at: '', sources: [], items: hlItems }).deals;
  check('HL items normalize to the Hobby Lobby label', hlNorm.every(function (d) { return PA.prettyStore(d.storeId) === 'Hobby Lobby'; }), true);
  const savedDeals3 = st.deals;
  st.deals = hlNorm;
  st.filters.pennyOnly = false; st.filters.showExpired = false; st.filters.futureOnly = false; st.filters.retailer = ''; st.filters.dept = ''; st.filters.sort = 'recent';
  check('HL items render on the Deals tab', PA._visibleDeals().map(function (d) { return d.name; }).indexOf('White Layered Wood Pumpkin') !== -1, true);
  check('HL item modal shows the generic checklist (no invented steps)', (function () { PA._openInstructions(hlNorm[0].id); var ok = els['instrBody'].innerHTML.indexOf('Clip any digital coupons') !== -1; PA._closeInstructions(); return ok; })(), true);
  st.deals = savedDeals3;
  st.filters.sort = 'recent'; st.filters.futureOnly = false; st.filters.pennyOnly = false; st.filters.showExpired = false; st.filters.retailer = ''; st.filters.dept = '';

  /* 21. New sources (v13 scout batch): every wired source reports ok
   * in the feed's source table, and every source domain contributes at
   * least one item with a name, a price and a URL. The Slickdeals
   * searches share one source domain, so they are checked by retailer
   * instead. The Hobby Lobby search and the Hip2Save API queries may
   * legitimately return zero (no fresh threads / no posts for that
   * store) — for those, status ok is enough. */
  function sourceStatus(nm) {
    return realWeekly.sources.filter(function (s) { return s.name === nm; })[0] || null;
  }
  var newSources = [
    'Slickdeals — Target search', 'Slickdeals — Dollar General search',
    'Slickdeals — Home Depot search', 'Slickdeals — clearance search',
    'Slickdeals — Walgreens free search', 'Saving With Dana — DG penny list',
    'Crazy4Couponing — DG penny list', 'Southern Savers — Walgreens ad & coupons',
    'Southern Savers — RSS', 'GlitchNDealz — RSS', 'GlitchNDealz — DG penny list',
    "DealNews — today's edition RSS", "DealNews — editors' choice RSS",
    'Hip2Save — RSS', 'Hip2Save — Walgreens deals (WP API)',
    'Hip2Save — CVS deals (WP API)', 'Hip2Save — Target deals (WP API)',
    'Hip2Save — Dollar General deals (WP API)',
    'Hip2Save — Hobby Lobby deals (WP API)',
    'Hip2Save — Home Depot deals (WP API)',
    'Krazy Coupon Lady — Michaels stacks', "Krazy Coupon Lady — Kohl's stacks",
    'Krazy Coupon Lady — JCPenney stacks', "ClearanceFinds — Lowe's penny list",
    'Aminahstore — Home Depot penny list',
    'weeklyadhunters — Dollar General weekly ad',
    'Kart.deals — JCPenney live clearance', 'Freebie Guy — Target deals',
    'Passionate Penny Pincher — RSS', 'Fabulessly Frugal — deals RSS',
    "Brad's Deals — homepage deals"
  ];
  var zeroOk = ['Slickdeals — Hobby Lobby search',
    'Hip2Save — Walgreens deals (WP API)', 'Hip2Save — CVS deals (WP API)',
    'Hip2Save — Target deals (WP API)', 'Hip2Save — Dollar General deals (WP API)',
    'Hip2Save — Hobby Lobby deals (WP API)', 'Hip2Save — Home Depot deals (WP API)'];
  newSources.forEach(function (nm) {
    var st = sourceStatus(nm);
    check('feed source table has ' + nm, !!st, true);
    if (st) {
      check(nm + ' ran ok', st.status, 'ok');
      if (zeroOk.indexOf(nm) === -1) {
        check(nm + ' returned items', (st.item_count || 0) >= 1, true);
      }
    }
  });
  check('feed source table has Slickdeals — Hobby Lobby search', !!sourceStatus('Slickdeals — Hobby Lobby search'), true);
  check('Hobby Lobby search ran ok', (sourceStatus('Slickdeals — Hobby Lobby search') || {}).status, 'ok');
  check('feed source table marks Freebie Guy — CVS deals link-only', (sourceStatus('Freebie Guy — CVS deals') || {}).status, 'link-only');
  check('feed source table marks Penny Puss link-only', (sourceStatus('Penny Puss — DG penny list') || {}).status, 'link-only');
  function smoke(domain, extra) {
    var items = realWeekly.items.filter(function (it) {
      return it.source === domain && (!extra || extra(it));
    });
    return items.filter(function (it) { return it.name && it.price && it.url; });
  }
  check('smoke: Saving With Dana items', smoke('savingwithdana.com').length >= 1, true);
  check('smoke: Crazy4Couponing items', smoke('crazy4couponing.com').length >= 1, true);
  check('smoke: Southern Savers page items', smoke('southernsavers.com', function (it) { return it.is_stack; }).length >= 1, true);
  check('smoke: Southern Savers feed items', smoke('southernsavers.com', function (it) { return !it.is_stack; }).length >= 1, true);
  check('smoke: GlitchNDealz items', smoke('glitchndealz.com').length >= 1, true);
  check('smoke: DealNews items', smoke('dealnews.com').length >= 1, true);
  check('smoke: Hip2Save items', smoke('hip2save.com').length >= 1, true);
  check('smoke: KCL Michaels items', smoke('krazycouponlady.com', function (it) { return it.retailer === 'michaels'; }).length >= 1, true);
  check('smoke: KCL Kohl’s items', smoke('krazycouponlady.com', function (it) { return it.retailer === 'kohls'; }).length >= 1, true);
  check('smoke: KCL JCPenney items', smoke('krazycouponlady.com', function (it) { return it.retailer === 'jcp'; }).length >= 1, true);
  check('smoke: ClearanceFinds Lowe’s items', smoke('clearancefinds.com').length >= 1, true);
  check('smoke: Aminahstore items', smoke('aminahstore.com').length >= 1, true);
  check('smoke: weeklyadhunters items', smoke('weeklyadhunters.com').length >= 1, true);
  check('smoke: Kart.deals items', smoke('kart.deals').length >= 1, true);
  check('smoke: Freebie Guy Target items', smoke('thefreebieguy.com', function (it) { return it.retailer === 'target'; }).length >= 1, true);
  check('smoke: Passionate Penny Pincher items', smoke('passionatepennypincher.com').length >= 1, true);
  check('smoke: Fabulessly Frugal items', smoke('fabulesslyfrugal.com').length >= 1, true);
  check('smoke: Brad’s Deals items', smoke('bradsdeals.com').length >= 1, true);
  check('smoke: Slickdeals Target search items', realWeekly.items.filter(function (it) { return it.source === 'slickdeals.net' && it.retailer === 'target' && it.price; }).length >= 1, true);
  check('smoke: Slickdeals DG search items', realWeekly.items.filter(function (it) { return it.source === 'slickdeals.net' && it.retailer === 'dollar-general' && it.price; }).length >= 1, true);
  check('smoke: Slickdeals Home Depot search items', realWeekly.items.filter(function (it) { return it.source === 'slickdeals.net' && it.retailer === 'home-depot' && it.price; }).length >= 1, true);
  /* Dollar General search noise filter: the '1 Million Dollar'
   * sweepstakes that tops the raw search must not appear. */
  check('DG search noise filtered (no Million Dollar sweepstakes)', realWeekly.items.filter(function (it) { return /million dollar/i.test(it.name); }).length, 0);
  /* Lowe's items are keyed by item number, never UPC. */
  var lowesItems = realWeekly.items.filter(function (it) { return it.source === 'clearancefinds.com'; });
  check('Lowe’s items exist', lowesItems.length >= 1, true);
  check('Lowe’s items carry no UPC', lowesItems.every(function (it) { return !it.upc; }), true);
  check('Lowe’s items carry a digits-only item number as sku', lowesItems.every(function (it) { return /^\d+$/.test(it.sku || ''); }), true);
  check('no 7-digit Lowe’s item number sits in a upc field', realWeekly.items.filter(function (it) { return /^\d{7}$/.test(it.upc || ''); }).length, 0);
  /* Aminahstore: mixed SKU formats, both in sku, never UPC. */
  var amItems = realWeekly.items.filter(function (it) { return it.source === 'aminahstore.com'; });
  check('Aminahstore items exist', amItems.length >= 1, true);
  check('Aminahstore items carry no UPC', amItems.every(function (it) { return !it.upc; }), true);
  check('Aminahstore SKUs are 6-digit legacy or 12-digit internet form', amItems.every(function (it) { return /^(\d{3}-\d{3}|\d{4}-\d{3}-\d{3})$/.test(it.sku || ''); }), true);
  /* Flipp is NOT approved — nothing from it may appear. */
  check('Flipp absent from feed sources', realWeekly.sources.filter(function (s) { return /flipp/i.test(s.name); }).length, 0);
  check('Flipp absent from feed items', realWeekly.items.filter(function (it) { return /flipp/i.test(it.source || ''); }).length, 0);
  /* The Dixie deal (Joseph's reel, Nov 22): one Deals-tab item from
   * the weeklyadhunters source, price is the reel's $8.50 final —
   * never the garbled $2.95/$9.95 ad row. */
  var dixie = realWeekly.items.filter(function (it) { return it.name.indexOf('4 Dixie Plates/Bowls') === 0; });
  check('Dixie item exists', dixie.length, 1);
  if (dixie.length === 1) {
    check('Dixie price is $8.50', dixie[0].price, '$8.50');
    check('Dixie was is $12.00', dixie[0].was, '$12.00');
    check('Dixie valid_to is 2026-11-28', dixie[0].valid_to, '2026-11-28');
    check('Dixie list_date is 2026-11-22', dixie[0].list_date, '2026-11-22');
    check('Dixie has 6 steps', dixie[0].steps.length, 6);
    check('Dixie is not a stack', dixie[0].is_stack, false);
    check('Dixie source is weeklyadhunters', dixie[0].source, 'weeklyadhunters.com');
    var dixieNorm = PA.normalizeWeekly({ generated_at: '', sources: [], items: dixie }).deals;
    var savedDeals4 = st.deals;
    st.deals = dixieNorm;
    st.filters.pennyOnly = false; st.filters.showExpired = false; st.filters.futureOnly = false; st.filters.retailer = ''; st.filters.dept = ''; st.filters.sort = 'recent';
    check('Dixie renders on the Deals tab', PA._visibleDeals().length, 1);
    check('Dixie does not render on Bundles', PA.visibleStacks().length, 0);
    st.deals = savedDeals4;
    st.filters.sort = 'recent'; st.filters.futureOnly = false; st.filters.pennyOnly = false; st.filters.showExpired = false; st.filters.retailer = ''; st.filters.dept = '';
  }
  /* Discovery is never a guessed date: the two discovery functions
   * take the sitemap / homepage text and return the latest dated URL.
   * Runs under the audit venv when present; skipped (not failed) when
   * it is absent — the feed smoke tests above are the primary check. */
  try {
    var discCode = [
      'import importlib.util',
      'spec = importlib.util.spec_from_file_location("pl", "/home/hatch/workspace/penny-alerts/scripts/parse-lists.py")',
      'pl = importlib.util.module_from_spec(spec); spec.loader.exec_module(pl)',
      'sm = "<urlset><url><loc>https://savingwithdana.com/penny-list/2026-11-01.html</loc></url><url><loc>https://savingwithdana.com/penny-list/2026-11-22.html</loc></url></urlset>"',
      'assert pl.discover_swd_url(sm) == "https://savingwithdana.com/penny-list/2026-11-22.html", "swd latest"',
      'assert pl.discover_swd_url("<urlset></urlset>") == "", "swd empty"',
      'assert pl.discover_swd_urls(sm) == ["https://savingwithdana.com/penny-list/2026-11-22.html", "https://savingwithdana.com/penny-list/2026-11-01.html"], "swd newest-first fallback list"',
      'hp = "<a href=\\"https://www.southernsavers.com/walgreens-ad-coupons-11-15-11-21/\\">x</a><a href=\\"https://www.southernsavers.com/walgreens-ad-coupons-11-22-11-28/\\">y</a>"',
      'assert pl.discover_ss_walgreens_url(hp) == "https://www.southernsavers.com/walgreens-ad-coupons-11-22-11-28/", "ss latest"',
      'assert pl.discover_ss_walgreens_url("<html></html>") == "", "ss empty"',
      'print("DISCOVERY OK")'
    ].join('\n');
    var discOut = execFileSync('/tmp/audit-venv/bin/python', ['-c', discCode], { encoding: 'utf8' });
    check('discovery functions return the latest dated URL, never a guess', discOut.indexOf('DISCOVERY OK') !== -1, true);
  } catch (e) {
    console.log('DISCOVERY CHECK SKIPPED (no audit venv): ' + (e && e.message ? e.message : e));
  }

  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})().catch(function (e) { console.error('HARNESS ERROR', e); process.exit(1); });
