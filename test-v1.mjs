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
  check('penny dept', pennies[0].dept, 'Penny');
  check('penny price', pennies[0].price, '$0.01');
  check('meta week', norm.meta.weekId, '2026-W40');
  check('meta generatedAt', norm.meta.generatedAt, '2026-10-03T14:36:45+00:00');

  /* 2. expiry + date math */
  check('expired weekly-ad item', PA.isExpired({ validTo: '2026-10-06' }, '2026-11-22'), true);
  check('no validTo is not expired', PA.isExpired({ validTo: '' }, '2026-11-22'), false);
  check('days since Oct 3 to Nov 22', PA.daysSince('2026-10-03', '2026-11-22'), 50);

  /* 3. departments */
  check('pet dept', PA.deriveDepartment({ kind: 'deal', name: 'Blue Buffalo Dog Food 24lb', saleStory: '' }), 'Pet');
  check('toy dept', PA.deriveDepartment({ kind: 'deal', name: 'LEGO Classic Bricks', saleStory: '' }), 'Toys & Games');
  check('grocery dept', PA.deriveDepartment({ kind: 'deal', name: 'Chex Mix Snack 15oz', saleStory: '' }), 'Grocery');

  /* 4. check links — verified patterns only, no walmart.com/search guess */
  const dg = PA.checkLinks(pennies[0]);
  check('DG checker link', dg[0].url, 'https://brickseek.com/dollar-general-inventory-checker?sku=' + encodeURIComponent(pennies[0].upc));
  const wmLinks = PA.checkLinks({ storeId: 'wm-ct', upc: '012345678905' });
  check('Walmart checker link present', wmLinks.some(function (l) { return l.url.indexOf('brickseek.com/walmart-inventory-checker?sku=') !== -1; }), true);
  check('no walmart.com/search URL anywhere', JSON.stringify(wmLinks).indexOf('walmart.com/search') === -1, true);
  check('walmart.com homepage link present', wmLinks.some(function (l) { return l.url === 'https://www.walmart.com/'; }), true);
  const noUpc = PA.checkLinks({ storeId: 'target', upc: '' });
  check('no-UPC item gets no checker link', noUpc.length, 0);

  /* 5. weekly feed fixture: one dup of the first briefing penny (by UPC),
   * one Home Depot penny (no UPC), one Slickdeals deal. Merged total is
   * 1790 briefing - 2 sharing the fixture UPC (the penny + one deal) + 3
   * weekly = 1791. */
  weeklyFixture = {
    generated_at: '2026-11-22T10:00:00+00:00',
    sources: [
      { name: 'Freebie Guy — DG penny list', url: 'https://THEFREEBIEGUY.COM/DOLLAR-GENERAL-PENNY-SHOPPING-MASTER-LIST/', status: 'ok', item_count: 1 },
      { name: 'SavingK — Walmart hidden clearance', url: 'https://savingk.com/walmart-hidden-clearance-how-to-find-these-secret-deals/', status: 'link-only', item_count: 0, note: 'Guide page only' }
    ],
    items: [
      { name: pennies[0].name, upc: pennies[0].upc, price: '$0.01', was: '', retailer: 'dollar-general', department: 'Penny', source: 'thefreebieguy.com', first_seen: '2026-11-22', valid_to: '', url: '' },
      { name: 'Weekly Test HD Screw', upc: '', price: '$0.01', was: '$12.98', retailer: 'home-depot', department: 'Penny', source: 'pennyrecon.com', first_seen: '2026-11-22', valid_to: '', url: 'https://www.pennyrecon.com/item/123/' },
      { name: 'Weekly Test Charger', upc: '', price: '$39.99', was: '', retailer: 'amazon', department: 'Electronics', source: 'slickdeals.net', first_seen: '2026-11-22', valid_to: '2026-11-22', url: '' }
    ]
  };
  const wnorm = PA.normalizeWeekly(weeklyFixture);
  check('weekly normalize count', wnorm.deals.length, 3);
  check('weekly penny kind', wnorm.deals[0].kind, 'penny');
  check('weekly deal kind', wnorm.deals[2].kind, 'deal');
  check('weekly meta generatedAt', wnorm.meta.generatedAt, '2026-11-22T10:00:00+00:00');
  check('weekly meta sources', wnorm.meta.sources.length, 2);

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
  check('stale bar shown (briefing 50 days old)', els['staleBar'].hidden, false);
  check('stale bar mentions days old', els['staleBar'].textContent.indexOf('50 days old') !== -1, true);
  check('stale bar mentions weekly feed', els['staleBar'].textContent.indexOf('weekly feed') !== -1, true);
  check('deal list rendered cards', (els['dealList'].innerHTML.match(/<article/g) || []).length > 0, true);
  check('retailer filter populated', els['retailerFilter'].options.length > 5, true);
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
  check('sw cache bumped to v3', swText.indexOf("penny-alerts-v3") !== -1, true);
  check('sw has push handler', swText.indexOf("addEventListener('push'") !== -1, true);
  check('sw push shows a notification', swText.indexOf('showNotification') !== -1, true);
  check('sw has notificationclick handler', swText.indexOf("addEventListener('notificationclick'") !== -1, true);
  check('app.js has no VAPID private key', fs.readFileSync('/home/hatch/workspace/penny-alerts/app.js', 'utf8').indexOf('VAPID_PRIVATE_KEY') === -1, true);

  /* 10. sender dry-run with fixtures (real scripts/send-push.py) */
  const senderOld = { generated_at: '2026-11-22T10:00:00+00:00', sources: [], items: [
    { name: 'Old Penny Item', upc: '012345678901', price: '$0.01', retailer: 'dollar-general', department: 'Penny', source: 'thefreebieguy.com', first_seen: '2026-11-21' },
    { name: 'Old Named Deal', upc: '', price: '$5.00', retailer: 'amazon', department: 'General', source: 'slickdeals.net', first_seen: '2026-11-21' }
  ] };
  const senderNew = { generated_at: '2026-11-22T11:00:00+00:00', sources: [], items: senderOld.items.concat([
    { name: 'New Penny Item', upc: '012345678902', price: '$0.01', retailer: 'dollar-general', department: 'Penny', source: 'thefreebieguy.com', first_seen: '2026-11-22' },
    { name: 'Brand New Deal', upc: '', price: '$9.99', retailer: 'target', department: 'General', source: 'slickdeals.net', first_seen: '2026-11-22' }
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

  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})().catch(function (e) { console.error('HARNESS ERROR', e); process.exit(1); });
