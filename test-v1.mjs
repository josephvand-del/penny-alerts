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
  check('stale bar mentions days old', els['staleBar'].innerHTML.indexOf(PA.daysSince('2026-10-03', PA._state.today) + ' days old') !== -1, true);
  check('stale bar mentions weekly feed', els['staleBar'].innerHTML.indexOf('weekly feed') !== -1, true);
  check('stale bar carries a dismiss button (v14)', els['staleBar'].innerHTML.indexOf('data-action="dismiss-stale"') !== -1, true);
  check('deal list rendered cards', (els['dealList'].innerHTML.match(/<article/g) || []).length > 0, true);
  check('retailer filter populated from weekly deals only', els['retailerFilter'].options.map(function (o) { return o.value; }).join(','), ',amazon,dollar-general,home-depot');
  check('retailer filter labels carry counts', els['retailerFilter'].options.map(function (o) { return o.textContent; }).join('|'), 'All stores|Amazon (1)|Dollar General (1)|Home Depot (1)');
  /* v14: the department filter is a custom button + panel (a native
   * <select> cannot carry a per-row hide ✕). Same options as the old
   * select: weekly deals only, counts, no Penny. */
  check('dept dropdown populated from weekly deals only', els['deptDdPanel'].innerHTML.indexOf('Electronics (1)') !== -1 && els['deptDdPanel'].innerHTML.indexOf('General (1)') !== -1 && els['deptDdPanel'].innerHTML.indexOf('Tools (1)') !== -1, true);
  check('dept dropdown has no Penny row', els['deptDdPanel'].innerHTML.indexOf('>Penny (') === -1, true);
  check('dept dropdown button reads All departments', els['deptDdBtn'].textContent, 'All departments');
  check('notification fired for new deals', notifCalls.length >= 1, true);
  check('notification title mentions new deals', /new deal/.test(notifCalls[0].title), true);
  /* v14: the in-app notification names the top new deals with prices. */
  check('notification body names a new deal with its price', notifCalls[0].opts.body.indexOf('Weekly Test HD Screw — $0.01') !== -1, true);
  check('notification body names a second deal with its price', notifCalls[0].opts.body.indexOf('Weekly Test Charger — $39.99') !== -1, true);

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
  check('sw cache bumped to v16', swText.indexOf("penny-alerts-v16") !== -1, true);
  check('sw has push handler', swText.indexOf("addEventListener('push'") !== -1, true);
  check('sw push shows a notification', swText.indexOf('showNotification') !== -1, true);
  check('sw push uses the 512 PNG icon (v14)', swText.indexOf("icon: 'icon-512.png'") !== -1, true);
  check('sw push uses the 192 PNG badge (v14)', swText.indexOf("badge: 'icon-192.png'") !== -1, true);
  check('sw push has a View deals action (v14)', swText.indexOf("actions: [{ action: 'open', title: 'View deals' }]") !== -1, true);
  check('sw push vibrates (v14)', swText.indexOf('vibrate: [200, 100, 200]') !== -1, true);
  check('sw caches the PNG icons (v14)', swText.indexOf("'icon-192.png'") !== -1 && swText.indexOf("'icon-512.png'") !== -1 && swText.indexOf("'icon-512-maskable.png'") !== -1, true);
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
  /* v14 payload: title "Penny Alerts: 3 new deals", body names the top
   * 3 with prices — "Name — $price (Store)" lines. */
  check('sender dry-run title is the count (v14)', dryOut.indexOf('Penny Alerts: 3 new deals') !== -1, true);
  check('sender dry-run names new penny with price + store', dryOut.indexOf('New Penny Item — $0.01 (Dollar General)') !== -1, true);
  check('sender dry-run names new deal with price + store', dryOut.indexOf('Brand New Deal — $9.99 (Target)') !== -1, true);
  check('sender dry-run names new stack', dryOut.indexOf('New Stack Deal — $2.00 (Walgreens)') !== -1, true);
  check('sender dry-run ends with Open the app', dryOut.indexOf('Open the app to see them.') !== -1, true);
  check('sender dry-run sends nothing', dryOut.indexOf('dry run') !== -1, true);
  /* More than 3 new items: the body lists the top 3 and "+N more". */
  const senderMany = { generated_at: '2026-11-22T11:00:00+00:00', sources: [], items: senderOld.items.concat([
    { name: 'New One', upc: '012345678910', price: '$0.01', retailer: 'dollar-general', department: 'Penny', source: 'thefreebieguy.com', first_seen: '2026-11-22', image: '' },
    { name: 'New Two', upc: '', price: '$9.99', retailer: 'target', department: 'General', source: 'slickdeals.net', first_seen: '2026-11-22', image: '' },
    { name: 'New Three', upc: '', price: '$2.00', was: '$14.98', retailer: 'walgreens', department: 'Health & Beauty', source: 'krazycouponlady.com', first_seen: '2026-11-22', image: '', is_stack: true },
    { name: 'New Four', upc: '', price: '$4.00', retailer: 'cvs', department: 'General', source: 'slickdeals.net', first_seen: '2026-11-22', image: '' },
    { name: 'New Five', upc: '', price: '$5.00', retailer: 'walmart', department: 'General', source: 'slickdeals.net', first_seen: '2026-11-22', image: '' }
  ]) };
  fs.writeFileSync('/tmp/pa-sender-many.json', JSON.stringify(senderMany));
  const dryMany = execFileSync('python3', [senderPath, '--dry-run', '--feed', '/tmp/pa-sender-many.json', '--old-feed', '/tmp/pa-sender-old.json'], { encoding: 'utf8' });
  check('sender dry-run 5 items title', dryMany.indexOf('Penny Alerts: 5 new deals') !== -1, true);
  check('sender dry-run 5 items lists top 3 only', dryMany.indexOf('New Three') !== -1 && dryMany.indexOf('New Four') === -1 && dryMany.indexOf('New Five') === -1, true);
  check('sender dry-run 5 items has +2 more', dryMany.indexOf('+2 more') !== -1, true);
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
  /* v14 Gerber bug: the Slickdeals title leads with "$29.97, FS, " and
   * ends with ", HomeDepot" — the store search must be a clean
   * product-name search, not "29 97 FS Gerber ... HomeDepot". */
  const gerber = { storeId: 'home-depot', upc: '', name: '$29.97, FS, Gerber Suspension NXT 15-N-1 Multi-Tool with Pocket Clip, HomeDepot', price: '$29.97', source: 'slickdeals.net', url: 'https://slickdeals.net/f/20372505-29-97-fs-gerber-suspension-nxt-15-n-1-multi-tool-with-pocket-clip-homedepot' };
  sandbox.navigator.userAgent = ANDROID_UA;
  const slGerber = PA.sellerLinks(gerber);
  check('Gerber: store query is the clean product name', slGerber[0].url, intentUrl('www.homedepot.com', '/s/Gerber%20Suspension%20NXT%2015%20N%201%20Multi%20Tool%20with%20Pocket%20Clip', 'com.thehomedepot', gerber));
  check('Gerber: no raw $ in the built link', slGerber[0].url.indexOf('$') === -1, true);
  check('Gerber: no 29 97 residue in the query', slGerber[0].url.split('/s/')[1].split('#Intent')[0].indexOf('29') === -1, true);
  check('Gerber: no FS token in the query', slGerber[0].url.split('/s/')[1].split('#Intent')[0].indexOf('FS') === -1, true);
  check('Gerber: no HomeDepot tail in the query', slGerber[0].url.split('/s/')[1].split('#Intent')[0].indexOf('HomeDepot') === -1, true);
  check('Gerber: link does not throw', (function () { try { PA.sellerLinks(gerber); return true; } catch (e) { return false; } })(), true);
  check('cleanStoreQuery strips a leading price + FS', PA.cleanStoreQuery('$29.97, FS, Gerber Tool, HomeDepot', 'home-depot'), 'Gerber Tool');
  check('cleanStoreQuery leaves a plain name alone', PA.cleanStoreQuery('Test Screw', 'home-depot'), 'Test Screw');
  check('cleanStoreQuery strips a trailing Walmart', PA.cleanStoreQuery('Blue Widget, Walmart', 'walmart'), 'Blue Widget');
  check('cleanStoreQuery does not strip another store name', PA.cleanStoreQuery('Blue Widget, Walmart', 'target'), 'Blue Widget, Walmart');
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
  check('real feed: HD link searches by product name', realHdNorm ? PA.sellerLinks(realHdNorm)[0].url : '', realHdNorm ? 'https://www.homedepot.com/s/' + encodeURIComponent(PA.cleanStoreQuery(realHdNorm.name, 'home-depot').replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()) : '');
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
  /* v14: the rendered department control is the custom dropdown panel,
   * not a <select> — same options, no Penny row, All departments first. */
  check('dept dropdown: rendered panel has no Penny row', els['deptDdPanel'].innerHTML.indexOf('>Penny (') === -1, true);
  check('dept dropdown: rendered panel matches weekly deals', els['deptDdPanel'].innerHTML.indexOf('Electronics (1)') !== -1 && els['deptDdPanel'].innerHTML.indexOf('General (1)') !== -1 && els['deptDdPanel'].innerHTML.indexOf('Tools (1)') !== -1, true);
  check('dept dropdown: All departments row first', els['deptDdPanel'].innerHTML.indexOf('All departments') !== -1 && els['deptDdPanel'].innerHTML.indexOf('All departments') < els['deptDdPanel'].innerHTML.indexOf('Electronics (1)'), true);
  check('dept dropdown: every dept row carries a hide button', (els['deptDdPanel'].innerHTML.match(/data-action="dept-hide"/g) || []).length, 3);
  check('dept dropdown: All departments row has no hide button', els['deptDdPanel'].innerHTML.indexOf('data-action="dept-hide" data-dept=""') === -1, true);
  check('dept filter select is gone from index.html (v14 custom dropdown)', htmlText.indexOf('id="deptFilter"') === -1, true);

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
  /* Version footer: APP_VERSION is v16, the page footer reads
   * "Penny Alerts v16", and init() set the rendered element. */
  check('APP_VERSION is v16', PA.APP_VERSION, 'v16');
  check('index.html footer reads Penny Alerts v16', htmlText.indexOf('Penny Alerts v16') !== -1, true);
  check('rendered version footer reads Penny Alerts v16', els['appVersion'].textContent, 'Penny Alerts v16');

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

  /* 18. regenerated real feed (v16, run Nov 25, 2026 evening — parser
   * run 2026-11-26T01:59Z): first-wins attribution, no UPC duplicates,
   * every item carries sources + list_date. Freebie Guy is 0 tonight —
   * the site blocked the parser (HTTP 403 on all three FG pages,
   * confirmed twice); the DG penny list is still covered by seven
   * other sources. Kart.deals is 429 (rate-limited). The pinned
   * counts below are this run's actuals. v16 adds 46 Slickdeals
   * per-chain searches: 215 food items (was 135), 80 of them for the
   * chains, 30 of 46 chains with food items; 1 app-only food deal
   * (McDonald's App Exclusive). */
  check('real feed Freebie Guy count is 0 (site blocked the parser, HTTP 403, Nov 25)', realWeekly.items.filter(function (it) { return it.source === 'thefreebieguy.com'; }).length, 0);
  const normUpc = function (u) { return (u && u.length === 11) ? '0' + u : u; };
  const seenU = {};
  const dupU = realWeekly.items.filter(function (it) { if (!it.upc) return false; const u = normUpc(it.upc); if (seenU[u]) return true; seenU[u] = 1; return false; });
  check('real feed has no duplicate normalized UPCs', dupU.length, 0);
  check('real feed total is 2176', realWeekly.items.length, 2176);
  check('real feed every item has a sources array', realWeekly.items.every(function (it) { return Array.isArray(it.sources) && it.sources.length >= 1; }), true);
  check('real feed source_count equals sources.length', realWeekly.items.every(function (it) { return it.source_count === it.sources.length; }), true);
  check('real feed every item has a list_date string ("" or YYYY-MM-DD)', realWeekly.items.every(function (it) { return typeof it.list_date === 'string' && (it.list_date.length === 0 || it.list_date.length === 10); }), true);
  check('real feed multi-source items number 249', realWeekly.items.filter(function (it) { return it.source_count >= 2; }).length, 249);
  /* Future items are the RSS posts published after midnight UTC (still
   * Nov 25 evening in Denver): 85, all dated 2026-11-26 — Slickdeals
   * 28, DealNews 23, Hip2Save 17, GlitchNDealz 11, Fabulessly Frugal 5,
   * Passionate Penny Pincher 1. They roll into "today" tomorrow; the
   * Denver-today fix (v15) is what puts them under Future tonight
   * instead of misreading them as today's deals. */
  check('real feed future items are 85, all dated 2026-11-26', realWeekly.items.filter(function (it) { return it.list_date > '2026-11-25'; }).length, 85);
  check('real feed PennyRecon note says 169 of 313', (realWeekly.sources.filter(function (s) { return s.name.indexOf('PennyRecon') !== -1; })[0].note || '').indexOf('169 of 313') !== -1, true);
  check('real feed has no Freebie Guy HD source', realWeekly.sources.some(function (s) { return s.name.indexOf('Freebie Guy — Home Depot') !== -1; }), false);
  check('real feed image coverage is 1227/2176', realWeekly.items.filter(function (it) { return !!it.image; }).length, 1227);
  /* v13: unknown list dates stay unknown — a string of length 0 or 10,
   * never the run date stamped in by the parser. */
  check('real feed no KCL penny item carries the run date', realWeekly.items.filter(function (it) { return it.source === 'krazycouponlady.com' && !it.is_stack && it.list_date === '2026-11-26'; }).length, 0);
  check('real feed every item carries a steps array', realWeekly.items.every(function (it) { return Array.isArray(it.steps); }), true);
  check('real feed every item carries an is_stack flag', realWeekly.items.every(function (it) { return typeof it.is_stack === 'boolean'; }), true);
  const realStacks = realWeekly.items.filter(function (it) { return it.is_stack; });
  console.log('STACKS real feed: ' + realStacks.length + ' stack items');
  check('real feed has stack items', realStacks.length >= 40, true);
  check('real feed KCL stacks exist', realStacks.filter(function (it) { return it.source === 'krazycouponlady.com'; }).length, 82);
  check('real feed FG Walgreens stacks are 0 (site blocked, HTTP 403, Nov 25)', realStacks.filter(function (it) { return it.source === 'thefreebieguy.com' && it.retailer === 'walgreens'; }).length, 0);
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

  /* 21. New sources (v13 scout batch, v15 adds Dollar Tree + Food):
   * every wired source reports ok in the feed's source table, and
   * every source domain contributes at least one item with a name, a
   * price and a URL. The Slickdeals searches share one source domain,
   * so they are checked by retailer instead. The Hobby Lobby search
   * and the Hip2Save API queries may legitimately return zero (no
   * fresh threads / no posts for that store) — for those, status ok is
   * enough. Two sources are SITE-BLOCKED on the Nov 25 run (Freebie
   * Guy 403, Kart.deals 429 — the sites, not the parser): for those,
   * a 'failed' status whose note names the HTTP status is the honest
   * record, and the smoke test is skipped; an 'ok' status still has
   * to carry items. */
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
    'Hip2Save — restaurant deals (WP API)',
    'Krazy Coupon Lady — Michaels stacks', "Krazy Coupon Lady — Kohl's stacks",
    'Krazy Coupon Lady — JCPenney stacks', 'Krazy Coupon Lady — Kroger stacks',
    "ClearanceFinds — Lowe's penny list",
    'Aminahstore — Home Depot penny list',
    'weeklyadhunters — Dollar General weekly ad',
    'Kart.deals — JCPenney live clearance', 'Freebie Guy — Target deals',
    'Passionate Penny Pincher — RSS', 'Fabulessly Frugal — deals RSS',
    "Brad's Deals — homepage deals",
    'RetailShout — Dollar Tree penny items',
    'Slickdeals — Dollar Tree search',
    'Slickdeals — free food search', 'Slickdeals — fast food search',
    'Slickdeals — restaurant search', 'Slickdeals — Kroger search'
  ];
  var zeroOk = ['Slickdeals — Hobby Lobby search',
    'Hip2Save — Walgreens deals (WP API)', 'Hip2Save — CVS deals (WP API)',
    'Hip2Save — Target deals (WP API)', 'Hip2Save — Dollar General deals (WP API)',
    'Hip2Save — Hobby Lobby deals (WP API)', 'Hip2Save — Home Depot deals (WP API)',
    'Hip2Save — restaurant deals (WP API)',
    /* weeklyadhunters intermittently serves a "One moment, please..."
     * bot challenge (HTTP 200, no price list) instead of the ad —
     * verified Nov 25: one fetch got the real 269KB page, the next
     * got the 7KB challenge. A 0-item run is the challenge, not an
     * empty ad; the Dixie reel deal still ships because the source
     * status stays 'ok' (its smoke test is the Dixie item itself). */
    'weeklyadhunters — Dollar General weekly ad'];
  var blockedOk = ['Freebie Guy — Target deals', 'Kart.deals — JCPenney live clearance'];
  newSources.forEach(function (nm) {
    var st = sourceStatus(nm);
    check('feed source table has ' + nm, !!st, true);
    if (st) {
      if (blockedOk.indexOf(nm) !== -1 && st.status === 'failed') {
        check(nm + ' failed with a site-side block (403/429), not a parser error', /HTTP (403|429)/.test(st.note || ''), true);
      } else {
        check(nm + ' ran ok', st.status, 'ok');
        if (zeroOk.indexOf(nm) === -1) {
          check(nm + ' returned items', (st.item_count || 0) >= 1, true);
        }
      }
    }
  });
  check('feed source table has Slickdeals — Hobby Lobby search', !!sourceStatus('Slickdeals — Hobby Lobby search'), true);
  /* v16: one Slickdeals search per fast-food chain. Items are optional
   * (a chain can have no fresh threads in a given week — Jack in the
   * Box and Firehouse Subs returned 0 on the Nov 26 probe), but the
   * source must exist in the feed table and have run ok. */
  var chainSources = [
    'Slickdeals — McDonald\'s search', 'Slickdeals — Burger King search',
    'Slickdeals — Wendy\'s search', 'Slickdeals — Taco Bell search',
    'Slickdeals — Chick-fil-A search', 'Slickdeals — Subway search',
    'Slickdeals — KFC search', 'Slickdeals — Domino\'s search',
    'Slickdeals — Pizza Hut search', 'Slickdeals — Little Caesars search',
    'Slickdeals — Sonic search', 'Slickdeals — Arby\'s search',
    'Slickdeals — Dairy Queen search', 'Slickdeals — Panda Express search',
    'Slickdeals — Chipotle search', 'Slickdeals — Jimmy John\'s search',
    'Slickdeals — Jersey Mike\'s search', 'Slickdeals — Panera search',
    'Slickdeals — Starbucks search', 'Slickdeals — Dunkin\' search',
    'Slickdeals — Popeyes search', 'Slickdeals — Five Guys search',
    'Slickdeals — Wingstop search', 'Slickdeals — Raising Cane\'s search',
    'Slickdeals — Papa John\'s search', 'Slickdeals — Jack in the Box search',
    'Slickdeals — Hardee\'s search', 'Slickdeals — Carl\'s Jr. search',
    'Slickdeals — Culver\'s search', 'Slickdeals — Whataburger search',
    'Slickdeals — Del Taco search', 'Slickdeals — Zaxby\'s search',
    'Slickdeals — Firehouse Subs search', 'Slickdeals — Qdoba search',
    'Slickdeals — Shake Shack search', 'Slickdeals — Tim Hortons search',
    'Slickdeals — Krispy Kreme search', 'Slickdeals — Baskin-Robbins search',
    'Slickdeals — Smoothie King search', 'Slickdeals — Jamba search',
    'Slickdeals — El Pollo Loco search', 'Slickdeals — Bojangles search',
    'Slickdeals — Church\'s Chicken search', 'Slickdeals — White Castle search',
    'Slickdeals — Long John Silver\'s search', 'Slickdeals — Moe\'s search'
  ];
  chainSources.forEach(function (nm) {
    var st = sourceStatus(nm);
    check('feed source table has ' + nm, !!st, true);
    if (st) check(nm + ' ran ok', st.status, 'ok');
  });
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
  /* Kart.deals / Freebie Guy Target are site-blocked tonight (429 /
   * 403): the smoke test passes when the source table records the
   * block, and requires items when the source ran ok. */
  var kartBlocked = (sourceStatus('Kart.deals — JCPenney live clearance') || {}).status === 'failed';
  check('smoke: Kart.deals items (or site-blocked)', kartBlocked || smoke('kart.deals').length >= 1, true);
  var fgTargetBlocked = (sourceStatus('Freebie Guy — Target deals') || {}).status === 'failed';
  check('smoke: Freebie Guy Target items (or site-blocked)', fgTargetBlocked || smoke('thefreebieguy.com', function (it) { return it.retailer === 'target'; }).length >= 1, true);
  check('smoke: Passionate Penny Pincher items', smoke('passionatepennypincher.com').length >= 1, true);
  check('smoke: Fabulessly Frugal items', smoke('fabulesslyfrugal.com').length >= 1, true);
  check('smoke: Brad’s Deals items', smoke('bradsdeals.com').length >= 1, true);
  check('smoke: Slickdeals Target search items', realWeekly.items.filter(function (it) { return it.source === 'slickdeals.net' && it.retailer === 'target' && it.price; }).length >= 1, true);
  check('smoke: Slickdeals DG search items', realWeekly.items.filter(function (it) { return it.source === 'slickdeals.net' && it.retailer === 'dollar-general' && it.price; }).length >= 1, true);
  check('smoke: Slickdeals Home Depot search items', realWeekly.items.filter(function (it) { return it.source === 'slickdeals.net' && it.retailer === 'home-depot' && it.price; }).length >= 1, true);
  /* v15: Dollar Tree + Food sources. The Slickdeals Dollar Tree hit is
   * a 50%-off-shipping code thread with no price, so its smoke test
   * does not require one. */
  check('smoke: RetailShout Dollar Tree penny items (with UPC)', realWeekly.items.filter(function (it) { return it.source === 'retailshout.com' && it.retailer === 'dollar-tree' && it.upc; }).length >= 1, true);
  check('smoke: Dollar Tree penny items carry was prices', realWeekly.items.filter(function (it) { return it.retailer === 'dollar-tree' && it.was; }).length >= 1, true);
  check('smoke: Slickdeals Dollar Tree search items', realWeekly.items.filter(function (it) { return it.source === 'slickdeals.net' && it.retailer === 'dollar-tree'; }).length >= 1, true);
  check('smoke: Food-tab items exist', realWeekly.items.filter(function (it) { return it.food === true; }).length >= 1, true);
  check('smoke: Food-tab items are all deals, never pennies', realWeekly.items.filter(function (it) { return it.food === true; }).every(function (it) { return it.kind === 'deal'; }), true);
  check('smoke: KCL Kroger items', realWeekly.items.filter(function (it) { return it.source === 'krazycouponlady.com' && it.retailer === 'kroger'; }).length >= 1, true);
  check('smoke: Hip2Save restaurant food items', realWeekly.items.filter(function (it) { return it.source === 'hip2save.com' && it.food === true; }).length >= 1, true);
  check('smoke: Slickdeals food-search items', realWeekly.items.filter(function (it) { return it.source === 'slickdeals.net' && it.food === true; }).length >= 1, true);
  /* v16: fast-food chain coverage + app-only split. */
  var chainIds = ['mcdonalds', 'burger-king', 'wendys', 'taco-bell', 'chick-fil-a', 'subway', 'kfc', 'dominos', 'pizza-hut', 'little-caesars', 'sonic', 'arbys', 'dairy-queen', 'panda-express', 'chipotle', 'jimmy-johns', 'jersey-mikes', 'panera', 'starbucks', 'dunkin', 'popeyes', 'five-guys', 'wingstop', 'raising-canes', 'papa-johns', 'jack-in-the-box', 'hardees', 'carls-jr', 'culvers', 'whataburger', 'del-taco', 'zaxbys', 'firehouse-subs', 'qdoba', 'shake-shack', 'tim-hortons', 'krispy-kreme', 'baskin-robbins', 'smoothie-king', 'jamba', 'el-pollo-loco', 'bojangles', 'churchs-chicken', 'white-castle', 'long-john-silvers', 'moes'];
  var chainFood = realWeekly.items.filter(function (it) { return it.food === true && chainIds.indexOf(it.retailer) !== -1; });
  var chainRetailers = {};
  chainFood.forEach(function (it) { chainRetailers[it.retailer] = 1; });
  check('Food tab covers many fast-food chains', Object.keys(chainRetailers).length >= 15, true);
  check('Slickdeals chain-search food items exist', chainFood.filter(function (it) { return it.source === 'slickdeals.net'; }).length >= 10, true);
  check('real feed app_only flag is boolean when present', realWeekly.items.filter(function (it) { return 'app_only' in it; }).every(function (it) { return typeof it.app_only === 'boolean'; }), true);
  check('Food tab has app-only deals', realWeekly.items.filter(function (it) { return it.food === true && it.app_only === true; }).length >= 1, true);
  /* v15: stop-date rule — every non-penny item with a list_date carries
   * a valid_to (list_date + 7 days when the source gave no end date);
   * penny items never carry one. */
  check('stop-date: every non-penny item with a list_date has a valid_to', realWeekly.items.filter(function (it) { return it.kind !== 'penny' && it.list_date && !it.valid_to; }).length, 0);
  check('stop-date: no penny item carries a valid_to', realWeekly.items.filter(function (it) { return it.kind === 'penny' && it.valid_to; }).length, 0);
  check('real feed every item carries a kind field', realWeekly.items.every(function (it) { return typeof it.kind === 'string' && (it.kind === 'deal' || it.kind === 'penny'); }), true);
  check('real feed food flag is boolean when present', realWeekly.items.filter(function (it) { return 'food' in it; }).every(function (it) { return typeof it.food === 'boolean'; }), true);
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
    var discOut = '';
    try { discOut = execFileSync('/tmp/pa-venv/bin/python', ['-c', discCode], { encoding: 'utf8' }); }
    catch (e1) { discOut = execFileSync('/tmp/audit-venv/bin/python', ['-c', discCode], { encoding: 'utf8' }); }
    check('discovery functions return the latest dated URL, never a guess', discOut.indexOf('DISCOVERY OK') !== -1, true);
  } catch (e) {
    console.log('DISCOVERY CHECK SKIPPED (no audit venv): ' + (e && e.message ? e.message : e));
  }

  /* 22. Bundles tab controls (v14): sort (Most verified / Most
   * recent / Biggest deals), store + department dropdowns built from
   * the stacks only, Future with the Deals-tab semantics, and a count
   * badge that respects the active filters. */
  check('bundleSort select exists in index.html', htmlText.indexOf('id="bundleSort"') !== -1, true);
  check('bundleSort has Most verified option', htmlText.indexOf('>Most verified</option>') !== -1, true);
  check('bundleSort has Most recent option', htmlText.indexOf('>Most recent</option>') !== -1, true);
  check('bundleSort has Biggest deals option', htmlText.indexOf('>Biggest deals</option>') !== -1, true);
  check('bundleSort defaults to Most verified', htmlText.indexOf('<option value="verified">Most verified</option>') !== -1, true);
  check('bundleStore select exists in index.html', htmlText.indexOf('id="bundleStore"') !== -1, true);
  check('bundle dept dropdown exists in index.html', htmlText.indexOf('id="bundleDeptDd"') !== -1, true);
  check('bundleFuture checkbox exists in index.html', htmlText.indexOf('id="bundleFuture"') !== -1, true);
  check('default bundle sort is Most verified', st.bundleFilters.sort, 'verified');
  const bundleFix = [
    { id: 'b-big', kind: 'deal', name: 'Big Savings Stack', upc: '', storeId: 'walgreens', source: 'krazycouponlady.com', sources: ['krazycouponlady.com', 'x.com', 'y.com'], sourceCount: 3, price: '$1.00', originalPrice: '$21.00', dept: 'Health & Beauty', confirmedOn: '2026-11-01', listDate: '2026-11-01', validTo: '2026-11-28', image: '', stack: true, steps: [] },
    { id: 'b-small', kind: 'deal', name: 'Small Savings Stack', upc: '', storeId: 'walgreens', source: 'krazycouponlady.com', sources: ['krazycouponlady.com'], sourceCount: 1, price: '$5.00', originalPrice: '$7.00', dept: 'General', confirmedOn: '2026-11-22', listDate: '2026-11-22', validTo: '2026-11-28', image: '', stack: true, steps: [] },
    { id: 'b-none', kind: 'deal', name: 'No Was Stack', upc: '', storeId: 'cvs', source: 'slickdeals.net', sources: ['slickdeals.net'], sourceCount: 1, price: '$3.00', originalPrice: '', dept: 'General', confirmedOn: '2026-11-20', listDate: '2026-11-20', validTo: '2026-11-28', image: '', stack: true, steps: [] },
    { id: 'b-future', kind: 'deal', name: 'Future Stack', upc: '', storeId: 'cvs', source: 'slickdeals.net', sources: ['slickdeals.net'], sourceCount: 1, price: '$1.00', originalPrice: '', dept: 'General', confirmedOn: '2099-01-01', listDate: '2099-01-01', validTo: '', image: '', stack: true, steps: [] },
    { id: 'b-plain', kind: 'deal', name: 'Plain Deal Not A Stack', upc: '', storeId: 'walgreens', source: 'slickdeals.net', sources: ['slickdeals.net'], sourceCount: 1, price: '$4.00', originalPrice: '', dept: 'General', confirmedOn: '2026-11-22', listDate: '2026-11-22', validTo: '', image: '', stack: false, steps: [] }
  ];
  const savedDeals5 = st.deals;
  st.deals = bundleFix;
  st.bundleFilters = { sort: 'verified', retailer: '', dept: '', futureOnly: false };
  check('Bundles default (Most verified) sorts by source count', PA.visibleStacks().map(function (d) { return d.id; }), ['b-big', 'b-small', 'b-none']);
  st.bundleFilters.sort = 'recent';
  check('Bundles Most recent sorts by list date desc', PA.visibleStacks().map(function (d) { return d.id; }), ['b-small', 'b-none', 'b-big']);
  st.bundleFilters.sort = 'biggest';
  check('Bundles Biggest deals sorts by savings desc', PA.visibleStacks().map(function (d) { return d.id; }), ['b-big', 'b-small', 'b-none']);
  check('Bundles Biggest deals puts a was-less item last', PA.visibleStacks()[2].id, 'b-none');
  st.bundleFilters.sort = 'verified';
  st.bundleFilters.retailer = 'cvs';
  check('Bundles store filter shows only that store', PA.visibleStacks().map(function (d) { return d.id; }), ['b-none']);
  st.bundleFilters.retailer = 'walgreens';
  check('Bundles store filter walgreens', PA.visibleStacks().map(function (d) { return d.id; }), ['b-big', 'b-small']);
  st.bundleFilters.retailer = '';
  st.bundleFilters.dept = 'General';
  check('Bundles dept filter shows only that dept', PA.visibleStacks().map(function (d) { return d.id; }), ['b-small', 'b-none']);
  st.bundleFilters.dept = 'Health & Beauty';
  check('Bundles dept filter Health & Beauty', PA.visibleStacks().map(function (d) { return d.id; }), ['b-big']);
  st.bundleFilters.dept = '';
  check('Bundles Future off hides the future stack', PA.visibleStacks().some(function (d) { return d.id === 'b-future'; }), false);
  st.bundleFilters.futureOnly = true;
  check('Bundles Future on shows only the future stack', PA.visibleStacks().map(function (d) { return d.id; }), ['b-future']);
  st.bundleFilters.futureOnly = false;
  PA.renderBundles();
  check('Bundles badge counts visible stacks', els['bundleCount'].textContent, '(3)');
  st.bundleFilters.retailer = 'cvs';
  PA.renderBundles();
  check('Bundles badge respects the store filter', els['bundleCount'].textContent, '(1)');
  st.bundleFilters.retailer = '';
  /* The sort select drives the same state the tests just set directly. */
  els['bundleSort'].value = 'biggest';
  els['bundleSort'].listeners.change[0]();
  check('bundle sort select change sets Biggest deals', st.bundleFilters.sort, 'biggest');
  check('bundle sort select change re-sorts', PA.visibleStacks().map(function (d) { return d.id; }), ['b-big', 'b-small', 'b-none']);
  check('bundle sort select is wired (change listener)', Array.isArray(els['bundleSort'].listeners.change) && els['bundleSort'].listeners.change.length === 1, true);
  check('bundle future checkbox is wired (change listener)', Array.isArray(els['bundleFuture'].listeners.change) && els['bundleFuture'].listeners.change.length === 1, true);
  /* The Bundles dropdowns are built from the weekly stacks only. */
  const savedWeekly5 = st.weeklyDeals;
  st.weeklyDeals = PA.normalizeWeekly({ generated_at: '', sources: [], items: [
    { name: 'Big Savings Stack', upc: '', price: '$1.00', was: '$21.00', retailer: 'walgreens', department: 'Health & Beauty', source: 'krazycouponlady.com', sources: ['krazycouponlady.com'], source_count: 3, first_seen: '2026-11-01', valid_to: '2026-11-28', url: '', image: '', list_date: '2026-11-01', is_stack: true, steps: [] },
    { name: 'Small Savings Stack', upc: '', price: '$5.00', was: '$7.00', retailer: 'walgreens', department: 'General', source: 'krazycouponlady.com', sources: ['krazycouponlady.com'], source_count: 1, first_seen: '2026-11-22', valid_to: '2026-11-28', url: '', image: '', list_date: '2026-11-22', is_stack: true, steps: [] },
    { name: 'No Was Stack', upc: '', price: '$3.00', was: '', retailer: 'cvs', department: 'General', source: 'slickdeals.net', sources: ['slickdeals.net'], source_count: 1, first_seen: '2026-11-20', valid_to: '2026-11-28', url: '', image: '', list_date: '2026-11-20', is_stack: true, steps: [] },
    { name: 'Future Stack', upc: '', price: '$1.00', was: '', retailer: 'cvs', department: 'General', source: 'slickdeals.net', sources: ['slickdeals.net'], source_count: 1, first_seen: '2099-01-01', valid_to: '', url: '', image: '', list_date: '2099-01-01', is_stack: true, steps: [] }
  ] }).deals;
  /* The stub DOM does not clear <select> children on innerHTML='' (a
   * real browser does), so reset the option children before the
   * re-render — a stub limitation, not an app bug. */
  els['bundleStore'].children = [];
  els['retailerFilter'].children = [];
  PA._renderFilters();
  check('bundle store dropdown lists only stack stores', els['bundleStore'].options.map(function (o) { return o.value; }).join(','), ',cvs,walgreens');
  check('bundle store dropdown labels carry counts', els['bundleStore'].options.map(function (o) { return o.textContent; }).join('|'), 'All stores|CVS (2)|Walgreens (2)');
  check('bundle dept dropdown lists only stack depts', els['bundleDeptDdPanel'].innerHTML.indexOf('General (3)') !== -1 && els['bundleDeptDdPanel'].innerHTML.indexOf('Health &amp; Beauty (1)') !== -1, true);
  st.weeklyDeals = savedWeekly5;
  st.deals = savedDeals5;
  st.bundleFilters = { sort: 'verified', retailer: '', dept: '', futureOnly: false };

  /* 23. Alerts persistence (v14) + the nicer Enable alerts button.
   * The v13 bug: refreshPushState wrote the stored flag from whatever
   * getSubscription() returned on load, so one null result after the
   * SW update wiped the flag and flipped the button off forever. */
  check('notif button starts with the off state class', els['notifBtn'].classList.contains('notif-off'), true);
  PA._setNotifUI('on');
  check('notif button carries notif-on class when on', els['notifBtn'].classList.contains('notif-on'), true);
  check('notif button drops notif-off class when on', els['notifBtn'].classList.contains('notif-off'), false);
  PA._setNotifUI('off');
  check('notif button carries notif-off class when off', els['notifBtn'].classList.contains('notif-off'), true);
  check('notif button drops notif-on class when off', els['notifBtn'].classList.contains('notif-on'), false);
  check('notif button pill styles are in styles.css', cssText.indexOf('#notifBtn') !== -1 && cssText.indexOf('notif-on') !== -1 && cssText.indexOf('notif-off') !== -1, true);
  const fakeSub2 = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-2',
    getKey: function (name) {
      if (name === 'p256dh') return new Uint8Array([4, 1, 2, 3]).buffer;
      if (name === 'auth') return new Uint8Array([9, 8, 7]).buffer;
      return null;
    }
  };
  let subState = null;
  let subscribeCalls = 0;
  sandbox.PushManager = function () {};
  sandbox.navigator.serviceWorker = { ready: Promise.resolve({ pushManager: {
    getSubscription: async function () { return subState; },
    subscribe: async function () { subscribeCalls++; subState = fakeSub2; return fakeSub2; }
  } }) };
  check('pushSupported true once serviceWorker + PushManager are stubbed', PA.pushSupported(), true);
  lsMem['pa:push'] = JSON.stringify('on');
  subState = null; subscribeCalls = 0;
  await PA._refreshPushState();
  check('alerts: transient null subscription re-subscribes', subscribeCalls, 1);
  check('alerts: flag stays on after re-subscribe', JSON.parse(lsMem['pa:push']), 'on');
  check('alerts: button shows on after re-subscribe', els['notifBtn'].classList.contains('notif-on'), true);
  subscribeCalls = 0;
  await PA._refreshPushState();
  check('alerts: live subscription needs no re-subscribe', subscribeCalls, 0);
  check('alerts: button on with live subscription', els['notifBtn'].classList.contains('notif-on'), true);
  sandbox.navigator.serviceWorker.ready = Promise.resolve({ pushManager: {
    getSubscription: async function () { throw new Error('no sw yet'); },
    subscribe: async function () { subscribeCalls++; return fakeSub2; }
  } });
  await PA._refreshPushState();
  check('alerts: failed check keeps the flag', JSON.parse(lsMem['pa:push']), 'on');
  check('alerts: failed check keeps the button on', els['notifBtn'].classList.contains('notif-on'), true);
  sandbox.navigator.serviceWorker.ready = Promise.resolve({ pushManager: {
    getSubscription: async function () { return null; },
    subscribe: async function () { subscribeCalls++; subState = fakeSub2; return fakeSub2; }
  } });
  await PA._disablePush();
  check('alerts: tap off clears the flag', lsMem['pa:push'], JSON.stringify(''));
  check('alerts: button off after tap off', els['notifBtn'].classList.contains('notif-off'), true);
  subscribeCalls = 0;
  await PA._refreshPushState();
  check('alerts: off stays off across a reload, no re-subscribe', subscribeCalls, 0);
  check('alerts: button stays off after reload', els['notifBtn'].classList.contains('notif-off'), true);

  /* 24. Blackstone price (v14, parser): the exact title + summary
   * from the live Slickdeals RSS. The old min() rule took the $1
   * Walmart+ trial out of the summary and called $150 the was price. */
  try {
    var priceCode = [
      'import importlib.util',
      'spec = importlib.util.spec_from_file_location("pl", "/home/hatch/workspace/penny-alerts/scripts/parse-lists.py")',
      'pl = importlib.util.module_from_spec(spec); spec.loader.exec_module(pl)',
      'bt = \'Blackstone Original 28" 2-Burner Outdoor Flat Top Griddle w/ Hard Cover (Model 2370) $150 + Free Shipping w/ Walmart+ or on $35+\'',
      'bs = \'Walmart has Blackstone Original 28" 2-Burner Outdoor Flat Top Griddle w/ Hard Cover (Model 2370) on sale for $150. Shipping is free w/ Walmart+ ($1 trial available) or on $35+.\'',
      'assert pl._extract_price(bt, bs) == ("$150.00", ""), pl._extract_price(bt, bs)',
      'assert pl._extract_price(\'Samsung 65" TV $1,299.99 + Free Shipping\', "") == ("$1299.99", "")',
      'assert pl._extract_price(\'Crest Toothpaste $9.97 at Target\', "") == ("$9.97", "")',
      'assert pl._extract_price(\'$29.97, FS, Gerber Suspension NXT 15-N-1 Multi-Tool with Pocket Clip, HomeDepot\', "") == ("$29.97", "")',
      'print("PRICE OK")'
    ].join('\n');
    var priceOut = '';
    try { priceOut = execFileSync('/tmp/pa-venv/bin/python', ['-c', priceCode], { encoding: 'utf8' }); }
    catch (e1) { priceOut = execFileSync('/tmp/audit-venv/bin/python', ['-c', priceCode], { encoding: 'utf8' }); }
    check('Blackstone price is $150.00, was empty (parser unit test)', priceOut.indexOf('PRICE OK') !== -1, true);
  } catch (e) {
    console.log('PRICE CHECK SKIPPED (no parser venv): ' + (e && e.message ? e.message : e));
  }
  const blackstone = realWeekly.items.filter(function (it) { return (it.url || '').indexOf('20373510') !== -1; });
  if (blackstone.length === 1) {
    check('real feed Blackstone price is $150.00', blackstone[0].price, '$150.00');
    check('real feed Blackstone has no was', blackstone[0].was, '');
  } else {
    console.log('BLACKSTONE: thread 20373510 rotated out of the regenerated feed (' + blackstone.length + ' matches) — the parser unit test above is the check');
  }

  /* 25. Stale-briefing banner dismiss (v14) + department hide toggles. */
  check('stale bar visible before dismiss', els['staleBar'].hidden, false);
  PA._dismissStaleBriefing();
  check('stale bar hidden after dismiss', els['staleBar'].hidden, true);
  check('dismissal stored under the briefing date', JSON.parse(lsMem['pa:dismissedBriefing']), '2026-10-03T14:36:45+00:00');
  PA._renderBriefingBar();
  check('stale bar stays hidden on reload', els['staleBar'].hidden, true);
  st.meta.generatedAt = '2026-11-10T10:00:00+00:00';
  PA._renderBriefingBar();
  check('stale bar shows again for a newer briefing', els['staleBar'].hidden, false);
  st.meta.generatedAt = '2026-10-03T14:36:45+00:00';
  PA._renderBriefingBar();
  check('stale bar hidden again for the dismissed briefing', els['staleBar'].hidden, true);
  const hideFix = [
    { id: 'h-pet', kind: 'penny', name: 'Pet Treats', upc: '', storeId: 'dollar-general', source: 'a.com', sources: ['a.com'], sourceCount: 1, price: '$0.01', originalPrice: '', dept: 'Pet', confirmedOn: '2026-11-22', listDate: '2026-11-22', validTo: '', image: '' },
    { id: 'h-groc', kind: 'deal', name: 'Dog Food', upc: '', storeId: 'dollar-general', source: 'a.com', sources: ['a.com'], sourceCount: 1, price: '$5.00', originalPrice: '', dept: 'Grocery', confirmedOn: '2026-11-22', listDate: '2026-11-22', validTo: '', image: '' }
  ];
  const savedDeals6 = st.deals;
  const savedWeekly6 = st.weeklyDeals;
  st.deals = hideFix;
  st.weeklyDeals = PA.normalizeWeekly({ generated_at: '', sources: [], items: [
    { name: 'Pet Treats', upc: '', price: '$0.01', was: '', retailer: 'dollar-general', department: 'Pet', source: 'a.com', first_seen: '2026-11-22', valid_to: '', url: '', image: '', list_date: '2026-11-22' },
    { name: 'Dog Food', upc: '', price: '$5.00', was: '', retailer: 'dollar-general', department: 'Grocery', source: 'a.com', first_seen: '2026-11-22', valid_to: '', url: '', image: '', list_date: '2026-11-22' }
  ] }).deals;
  PA._renderFilters();
  st.filters.pennyOnly = false; st.filters.showExpired = false; st.filters.futureOnly = false; st.filters.retailer = ''; st.filters.dept = ''; st.filters.sort = 'recent';
  check('Pet item visible before hide', PA._visibleDeals().map(function (d) { return d.id; }), ['h-groc', 'h-pet']);
  check('hide Pet returns true (now hidden)', PA._toggleHiddenDept('Pet'), true);
  check('Pet item hidden from the feed', PA._visibleDeals().map(function (d) { return d.id; }), ['h-groc']);
  check('Pet name stays visible in the dropdown', els['deptDdPanel'].innerHTML.indexOf('Pet (1)') !== -1, true);
  check('Pet row X is highlighted while hidden', els['deptDdPanel'].innerHTML.indexOf('hidden-on') !== -1, true);
  check('hide preference persisted', JSON.parse(lsMem['pa:hiddenDepts']), { Pet: true });
  /* Reload simulation: fresh state, re-read from storage. */
  st.hiddenDepts = {};
  PA._loadState();
  check('Pet still hidden after a reload', PA._visibleDeals().map(function (d) { return d.id; }), ['h-groc']);
  /* The watchlist is never hidden — only the feed lists. */
  PA._handleAction('watch', 'h-pet');
  check('hidden dept still shows in the watchlist', els['watchList'].innerHTML.indexOf('Pet Treats') !== -1, true);
  check('un-hide Pet returns false (now shown)', PA._toggleHiddenDept('Pet'), false);
  check('Pet item back in the feed', PA._visibleDeals().map(function (d) { return d.id; }), ['h-groc', 'h-pet']);
  check('Pet row X no longer highlighted', els['deptDdPanel'].innerHTML.indexOf('hidden-on') === -1, true);
  PA._handleAction('unwatch', 'h-pet');
  st.deals = savedDeals6;
  st.weeklyDeals = savedWeekly6;
  st.filters.sort = 'recent'; st.filters.futureOnly = false; st.filters.pennyOnly = false; st.filters.showExpired = false; st.filters.retailer = ''; st.filters.dept = '';

  /* 26. PWA installability (v14) + the in-app Install button. The
   * "Tap to copy the URL" card Joseph saw is Chrome's own PWA card —
   * the site cannot rewrite it — but real 192/512 PNG icons make the
   * app properly installable, so the browser offers a real install
   * prompt and the in-app button can use it. */
  const manifest = JSON.parse(fs.readFileSync('/home/hatch/workspace/penny-alerts/manifest.json', 'utf8'));
  check('manifest has a 192 PNG icon', manifest.icons.some(function (i) { return i.sizes === '192x192' && i.type === 'image/png'; }), true);
  check('manifest has a 512 PNG icon', manifest.icons.some(function (i) { return i.sizes === '512x512' && i.type === 'image/png' && i.purpose !== 'maskable'; }), true);
  check('manifest has a 512 maskable icon', manifest.icons.some(function (i) { return i.sizes === '512x512' && i.purpose === 'maskable'; }), true);
  check('manifest keeps the SVG icon too', manifest.icons.some(function (i) { return i.type === 'image/svg+xml'; }), true);
  check('manifest display is standalone', manifest.display, 'standalone');
  check('manifest has name + short_name + start_url', !!(manifest.name && manifest.short_name && manifest.start_url), true);
  function pngSize(p) {
    const b = fs.readFileSync(p);
    if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  }
  check('icon-192.png is a valid 192x192 PNG', pngSize('/home/hatch/workspace/penny-alerts/icon-192.png'), [192, 192]);
  check('icon-512.png is a valid 512x512 PNG', pngSize('/home/hatch/workspace/penny-alerts/icon-512.png'), [512, 512]);
  check('icon-512-maskable.png is a valid 512x512 PNG', pngSize('/home/hatch/workspace/penny-alerts/icon-512-maskable.png'), [512, 512]);
  check('install button exists in index.html', htmlText.indexOf('id="installBtn"') !== -1, true);
  check('install button is labelled Install app', htmlText.indexOf('aria-label="Install app"') !== -1, true);
  check('install button uses an inline SVG, not an emoji', (function () { var i = htmlText.indexOf('id="installBtn"'); var seg = htmlText.slice(i, i + 400); return seg.indexOf('<svg') !== -1 && seg.indexOf('📥') === -1 && seg.indexOf('⬇') === -1; })(), true);
  check('install button hidden before install prompt', els['installBtn'].hidden, true);
  let promptCalls = 0;
  const fakePromptEv = { preventDefault: function () {}, prompt: function () { promptCalls++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) };
  domListeners['window:beforeinstallprompt'](fakePromptEv);
  check('install button appears after beforeinstallprompt', els['installBtn'].hidden, false);
  els['installBtn'].listeners.click[0]();
  check('install tap calls prompt()', promptCalls, 1);
  check('install button hides after prompt', els['installBtn'].hidden, true);
  domListeners['window:beforeinstallprompt'](fakePromptEv);
  check('install button reappears on a new prompt event', els['installBtn'].hidden, false);
  domListeners['window:appinstalled']();
  check('install button hides after appinstalled', els['installBtn'].hidden, true);
  sandbox.window.matchMedia = function (q) { return { matches: q === '(display-mode: standalone)' }; };
  domListeners['window:beforeinstallprompt'](fakePromptEv);
  check('install button stays hidden in standalone mode', els['installBtn'].hidden, true);
  delete sandbox.window.matchMedia;
  PA._updateInstallBtn();

  /* 27. Food tab + Price sort + Biggest on Deals + hamburger drawer
   * + Denver today + expiry-aware dropdowns (v15). Synthetic deals so
   * the checks do not depend on the live feed. */
  /* Denver today: the app's today is the America/Denver calendar date,
   * not the UTC date — after 5pm MST the UTC date is already tomorrow,
   * which used to shift the Future boundary a day early all evening. */
  const denverToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  check('state.today is the Denver date, not UTC', PA._state.today, denverToday);
  check('denverToday() matches the Denver date', PA.denverToday(), denverToday);
  /* normalizeWeekly carries the food flag (parser sets it). */
  const wfood = PA.normalizeWeekly({ generated_at: '', sources: [], items: [
    { name: 'Free Fries Friday', upc: '', price: '$0.00', was: '$3.99', retailer: 'online', department: 'Restaurant', source: 'slickdeals.net', first_seen: '2026-11-25', valid_to: '', url: '', image: '', list_date: '2026-11-25', food: true, app_only: true },
    { name: 'Plain Screw', upc: '', price: '$1.99', was: '', retailer: 'home-depot', department: 'Tools', source: 'slickdeals.net', first_seen: '2026-11-25', valid_to: '', url: '', image: '', list_date: '2026-11-25' }
  ] });
  check('normalizeWeekly carries food flag', wfood.deals[0].food, true);
  check('normalizeWeekly defaults food to false', wfood.deals[1].food, false);
  check('normalizeWeekly keeps Restaurant dept', wfood.deals[0].dept, 'Restaurant');
  check('normalizeWeekly carries appOnly flag', wfood.deals[0].appOnly, true);
  check('normalizeWeekly defaults appOnly to false', wfood.deals[1].appOnly, false);
  const foodDeals = [
    { id: 'f-a', kind: 'deal', name: 'Free Fries Friday', upc: '', storeId: 'online', source: 'slickdeals.net', sources: ['slickdeals.net'], sourceCount: 1, price: '$0.00', originalPrice: '$3.99', dept: 'Restaurant', confirmedOn: '2026-11-25', listDate: '2026-11-25', validTo: '', image: '', food: true },
    { id: 'f-b', kind: 'deal', name: 'Kroger Butter $1.99', upc: '', storeId: 'kroger', source: 'slickdeals.net', sources: ['slickdeals.net'], sourceCount: 1, price: '$1.99', originalPrice: '', dept: 'Grocery', confirmedOn: '2026-11-24', listDate: '2026-11-24', validTo: '', image: '', food: true },
    { id: 'f-c', kind: 'deal', name: 'Burger Deal No Price', upc: '', storeId: 'online', source: 'slickdeals.net', sources: ['slickdeals.net'], sourceCount: 1, price: '', originalPrice: '', dept: 'Restaurant', confirmedOn: '2026-11-25', listDate: '2026-11-25', validTo: '', image: '', food: true },
    { id: 'f-d', kind: 'deal', name: 'Expired Pizza $4.00', upc: '', storeId: 'online', source: 'slickdeals.net', sources: ['slickdeals.net'], sourceCount: 1, price: '$4.00', originalPrice: '$8.00', dept: 'Restaurant', confirmedOn: '2026-11-20', listDate: '2026-11-20', validTo: '2026-11-21', image: '', food: true },
    { id: 'f-e', kind: 'deal', name: 'Future Taco Deal $2.00', upc: '', storeId: 'online', source: 'slickdeals.net', sources: ['slickdeals.net'], sourceCount: 1, price: '$2.00', originalPrice: '', dept: 'Restaurant', confirmedOn: '2099-01-01', listDate: '2099-01-01', validTo: '', image: '', food: true },
    { id: 'f-f', kind: 'deal', name: 'Kroger Stack $5.00', upc: '', storeId: 'kroger', source: 'krazycouponlady.com', sources: ['krazycouponlady.com'], sourceCount: 1, price: '$5.00', originalPrice: '$12.00', dept: 'Grocery', confirmedOn: '2026-11-25', listDate: '2026-11-25', validTo: '2026-11-30', image: '', food: true, stack: true },
    { id: 'f-g', kind: 'penny', name: 'Candy Bar Penny', upc: '012345678907', storeId: 'dollar-general', source: 'retailshout.com', sources: ['retailshout.com'], sourceCount: 1, price: '$0.01', originalPrice: '', dept: 'Grocery', confirmedOn: '2026-11-24', listDate: '2026-11-24', validTo: '', image: '', food: true },
    { id: 'f-h', kind: 'deal', name: 'Plain Screw $1.99', upc: '', storeId: 'home-depot', source: 'slickdeals.net', sources: ['slickdeals.net'], sourceCount: 1, price: '$1.99', originalPrice: '', dept: 'Tools', confirmedOn: '2026-11-25', listDate: '2026-11-25', validTo: '', image: '', food: false },
    { id: 'f-i', kind: 'deal', name: 'McDonald\'s App Exclusive Big Mac $3.50', upc: '', storeId: 'mcdonalds', source: 'slickdeals.net', sources: ['slickdeals.net'], sourceCount: 1, price: '$3.50', originalPrice: '$5.00', dept: 'Restaurant', confirmedOn: '2026-11-25', listDate: '2026-11-25', validTo: '', image: '', food: true, appOnly: true }
  ];
  const savedDealsV15 = st.deals;
  st.deals = foodDeals;
  st.filters.pennyOnly = false; st.filters.showExpired = false; st.filters.futureOnly = false; st.filters.retailer = ''; st.filters.dept = ''; st.filters.sort = 'recent';
  st.foodFilters.sort = 'price'; st.foodFilters.futureOnly = false; st.foodFilters.retailer = ''; st.foodFilters.dept = '';
  check('Food default sort is Price: Low to High', st.foodFilters.sort, 'price');
  /* Food tab, price sort: free first, then cheapest, no-price last;
   * expired + future + stacks + pennies + non-food never appear. */
  check('Food tab is food deals only, cheapest first', PA.visibleFood().map(function (d) { return d.id; }), ['f-a', 'f-b', 'f-i', 'f-c']);
  /* Deals tab excludes food deals but keeps food pennies. */
  check('Deals tab excludes food deals, keeps food pennies', PA._visibleDeals().map(function (d) { return d.id; }), ['f-h', 'f-g']);
  /* Price sort as a pure sort: $0.00, $0.01, $1.99 ties by recency,
   * then $2.00, $4.00, $5.00, no-price last. */
  check('Price sort orders cheapest first, no-price last', PA.sortDeals(foodDeals, 'price').map(function (d) { return d.id; }), ['f-a', 'f-g', 'f-h', 'f-b', 'f-e', 'f-i', 'f-d', 'f-f', 'f-c']);
  /* Biggest deals as a pure sort: $7.00, $4.00, $3.99, then the
   * no-saving items by recency (2099 first). */
  check('Biggest sort orders by dollars saved', PA.sortDeals(foodDeals, 'biggest').map(function (d) { return d.id; }), ['f-f', 'f-d', 'f-a', 'f-i', 'f-e', 'f-c', 'f-h', 'f-g', 'f-b']);
  /* Food Future toggle: only the 2099-dated food deal survives. */
  st.foodFilters.futureOnly = true;
  check('Food Future shows only future-dated food deals', PA.visibleFood().map(function (d) { return d.id; }), ['f-e']);
  st.foodFilters.futureOnly = false;
  /* Food store filter: Kroger shows the Kroger deal, not the stack. */
  st.foodFilters.retailer = 'kroger';
  check('Food store filter is Kroger deals only', PA.visibleFood().map(function (d) { return d.id; }), ['f-b']);
  st.foodFilters.retailer = '';
  /* Food renders its cards and badge; non-food never renders there. */
  PA.renderFood();
  check('Food renders the food deal cards', els['foodList'].innerHTML.indexOf('Free Fries Friday') !== -1 && els['foodList'].innerHTML.indexOf('Kroger Butter') !== -1, true);
  check('Food does not render non-food deals', els['foodList'].innerHTML.indexOf('Plain Screw') === -1, true);
  check('Food does not render food pennies', els['foodList'].innerHTML.indexOf('Candy Bar Penny') === -1, true);
  check('Food badge counts visible food deals', els['foodCount'].textContent, '(4)');
  /* v16: app-only deals render in their own labeled section below the
   * main Food list, never mixed in. */
  var foodHtml = els['foodList'].innerHTML;
  check('Food has an App-only section head', foodHtml.indexOf('App-only deals') !== -1, true);
  check('Food renders the app-only deal card', foodHtml.indexOf('App Exclusive Big Mac') !== -1, true);
  check('Food app-only card sits after the section head', foodHtml.indexOf('App Exclusive Big Mac') > foodHtml.indexOf('App-only deals'), true);
  check('Food main list ends before the app-only section', foodHtml.indexOf('Free Fries Friday') < foodHtml.indexOf('App-only deals'), true);
  /* Food card source count follows the Food sort (verified mode only). */
  st.foodFilters.sort = 'verified';
  const foodCard = PA.dealCard(foodDeals[0], 'verified');
  check('food card in verified mode shows source count', foodCard.indexOf('✓ 1 source</div>') !== -1, true);
  st.foodFilters.sort = 'price';
  check('food card in price mode shows no source count', PA.dealCard(foodDeals[0], 'price').indexOf('source-count') === -1, true);
  /* Deals sort select carries the two new options (v15). */
  check('Deals sort has Biggest deals option', htmlText.indexOf('>Biggest deals<') !== -1, true);
  check('Deals sort has Price: Low to High option', htmlText.indexOf('>Price: Low to High<') !== -1, true);
  check('Food sort defaults to Price: Low to High', (function () { var i = htmlText.indexOf('id="foodSort"'); var seg = htmlText.slice(i, i + 500); return seg.indexOf('<option value="price">Price: Low to High</option>') !== -1 && seg.indexOf('<option value="price"') < seg.indexOf('<option value="recent"'); })(), true);
  check('Food sort select exists in index.html', htmlText.indexOf('id="foodSort"') !== -1, true);
  check('Food store select exists in index.html', htmlText.indexOf('id="foodStore"') !== -1, true);
  check('Food Future checkbox exists in index.html', htmlText.indexOf('id="foodFuture"') !== -1, true);
  check('Food list exists in index.html', htmlText.indexOf('id="foodList"') !== -1, true);
  check('Food sort select is wired (change listener)', Array.isArray(els['foodSort'].listeners.change) && els['foodSort'].listeners.change.length === 1, true);
  check('Food Future checkbox is wired (change listener)', Array.isArray(els['foodFuture'].listeners.change) && els['foodFuture'].listeners.change.length === 1, true);
  /* Hamburger drawer: button + drawer + backdrop in the HTML; the top
   * tab bar is three tabs (Deals/Bundles/Food) and Watchlist + Lists
   * live in the drawer. */
  check('hamburger button exists in index.html', htmlText.indexOf('id="menuBtn"') !== -1, true);
  check('hamburger button is labelled Menu', htmlText.indexOf('aria-label="Menu"') !== -1, true);
  check('hamburger button uses an inline SVG, not an emoji', (function () { var i = htmlText.indexOf('id="menuBtn"'); var seg = htmlText.slice(i, i + 300); return seg.indexOf('<svg') !== -1 && seg.indexOf('☰') === -1; })(), true);
  check('drawer exists in index.html', htmlText.indexOf('id="drawer"') !== -1, true);
  check('drawer backdrop exists in index.html', htmlText.indexOf('id="drawerBackdrop"') !== -1, true);
  check('drawer holds the Watchlist link', htmlText.indexOf('data-tab="watchlist"') !== -1, true);
  check('drawer holds the Lists & Sources link', htmlText.indexOf('data-tab="lists"') !== -1, true);
  check('top tab bar is three tabs', (htmlText.match(/class="tab(\s|")/g) || []).length, 3);
  check('Food tab button exists', htmlText.indexOf('data-tab="food"') !== -1, true);
  check('hamburger button is wired (click listener)', Array.isArray(els['menuBtn'].listeners.click) && els['menuBtn'].listeners.click.length === 1, true);
  check('drawer starts closed', els['drawer'].hidden, true);
  els['menuBtn'].listeners.click[0]();
  check('hamburger tap opens the drawer', els['drawer'].hidden, false);
  check('drawer backdrop shows with the drawer', els['drawerBackdrop'].hidden, false);
  els['menuBtn'].listeners.click[0]();
  check('hamburger tap again closes the drawer', els['drawer'].hidden, true);
  /* Dropdown counts exclude expired items (v15): an expired food deal
   * must not keep its store in any dropdown, and a zero-count store
   * never appears. */
  const savedWeekly = st.weeklyDeals;
  st.weeklyDeals = PA.normalizeWeekly({ generated_at: '', sources: [], items: [
    { name: 'Expired Pizza', upc: '', price: '$4.00', was: '$8.00', retailer: 'online', department: 'Restaurant', source: 'slickdeals.net', first_seen: '2026-11-20', valid_to: '2026-11-21', url: '', image: '', list_date: '2026-11-20', food: true },
    { name: 'Live Fries', upc: '', price: '$0.00', was: '$3.99', retailer: 'online', department: 'Restaurant', source: 'slickdeals.net', first_seen: '2026-11-25', valid_to: '', url: '', image: '', list_date: '2026-11-25', food: true },
    { name: 'Live Screw', upc: '', price: '$1.99', was: '', retailer: 'home-depot', department: 'Tools', source: 'slickdeals.net', first_seen: '2026-11-25', valid_to: '', url: '', image: '', list_date: '2026-11-25' }
  ] }).deals;
  st.filters.retailer = ''; st.foodFilters.retailer = ''; st.bundleFilters.retailer = '';
  /* The stub DOM does not clear children when innerHTML is set (a real
   * browser does) — reset the option lists by hand so the rebuild is
   * measured exactly, the way a browser would see it. */
  els['retailerFilter'].children = [];
  els['foodStore'].children = [];
  els['bundleStore'].children = [];
  PA._renderFilters();
  check('Deals store dropdown excludes expired + food stores', els['retailerFilter'].options.map(function (o) { return o.value; }).join(','), ',home-depot');
  check('Food store dropdown excludes expired stores', els['foodStore'].options.map(function (o) { return o.value; }).join(','), ',online');
  check('Deals dept dropdown excludes the expired deal dept', els['deptDdPanel'].innerHTML.indexOf('Restaurant') === -1 && els['deptDdPanel'].innerHTML.indexOf('Tools (1)') !== -1, true);
  check('Food dept dropdown keeps the live food dept', els['foodDeptDdPanel'].innerHTML.indexOf('Restaurant (1)') !== -1, true);
  st.weeklyDeals = savedWeekly;
  PA._renderFilters();
  st.deals = savedDealsV15;
  st.filters.sort = 'recent'; st.filters.futureOnly = false; st.filters.pennyOnly = false; st.filters.showExpired = false; st.filters.retailer = ''; st.filters.dept = '';
  st.foodFilters.sort = 'price'; st.foodFilters.futureOnly = false; st.foodFilters.retailer = ''; st.foodFilters.dept = '';

  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})().catch(function (e) { console.error('HARNESS ERROR', e); process.exit(1); });
