'use strict';
/* Penny Alerts v1 — Aurora, CO 80017
 * Free signals only. The ONLY automatic network fetch this app makes is
 * Penny Hunter's PUBLIC daily briefing JSON on GitHub Pages. It never
 * fetches walmart.com, brickseek.com, or any retailer endpoint. Check
 * links below are plain <a> links the USER taps; the user does the check.
 *
 * v2: the weekly feed — scripts/parse-lists.py runs daily (GitHub Actions,
 * workflow file added by Joseph on github.com) and writes feed/weekly.json,
 * which the app reads alongside the briefing. Parsing reuses Penny
 * Hunter's approach (MIT).
 *
 * v3 (this version): true background push. "Enable alerts" subscribes this
 * phone via the Web Push API (VAPID public key below — public, safe to
 * commit) and stores the subscription in Supabase (push_subscriptions
 * table; migration in supabase/migrations/, run by Joseph in the
 * dashboard). scripts/send-push.py runs in the same daily workflow and
 * pushes one summary message when the feed gains new items. Until the
 * migration + workflow + secrets are in place, alerts stay honestly
 * labelled: "checked when you open the app."
 *
 * v5: more deal photos — Open Products Facts enrichment and og:image
 * from per-item pages (Slickdeals), and a nicer no-photo tile: a small
 * generic product glyph plus the department name, instead of one big
 * initial letter. Plus seller links on every card: Google Shopping
 * search (by UPC, else by name) and a retailer search link where the
 * retailer + UPC are known and the pattern was verified live — Walmart,
 * Target, Home Depot (Dollar General's pattern could not be confirmed,
 * so no DG link). Still no fabricated images — the tile is the honest
 * "no photo anywhere" state.
 */

var BRIEFING_URL = 'https://rocketshon.github.io/penny-finder-backend/briefings/latest.json';
var WEEKLY_URL = 'feed/weekly.json';

/* Background push (v3). The VAPID public key and the Supabase publishable
 * key are public by design and safe to commit. The VAPID *private* key and
 * the service_role key are NEVER in this repo — they live in GitHub Secrets
 * for the sender script. Supabase project is the shared "bulk finder"
 * project (free tier is at its 2-project limit, so no new project). */
var APP_URL = 'https://josephvand-del.github.io/penny-alerts/';
var SUPABASE_URL = 'https://xwekulsnfarjibawqqih.supabase.co';
var SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_EIBE-riBIT2UCrfP0X0HmA_gUSRTGpD';
var VAPID_PUBLIC_KEY = 'BKrLIraB-gkEEseuViMkpmgA5SuJylbJ0xOIJvaHcezUVqUNI72pFYnBNnjNMVeV404-JvKUuG3xeLSYycDvefY';

/* Friendly retailer names for store_ids found in the briefing. */
var STORE_NAMES = {
  'dollar-general': 'Dollar General',
  'target': 'Target',
  'home-depot': 'Home Depot',
  'wm-ct': 'Walmart',
  'walmart': 'Walmart',
  'best-buy': 'Best Buy',
  'menards': 'Menards',
  'ollies': "Ollie's",
  'aldi': 'ALDI',
  'cvs': 'CVS',
  'walgreens': 'Walgreens',
  'family-dollar': 'Family Dollar',
  'tj-maxx': 'T.J.Maxx',
  'kroger': 'Kroger',
  'kohls': "Kohl's",
  'five-below': 'Five Below',
  'jcp': 'JCPenney',
  'costco': 'Costco',
  'meijer': 'Meijer',
  'ulta': 'Ulta',
  'dicks': "Dick's",
  'harbor-freight': 'Harbor Freight',
  'bath-body-works': 'Bath & Body Works',
  'lowes': "Lowe's",
  'office-depot': 'Office Depot',
  'marshalls': 'Marshalls',
  'petsmart': 'PetSmart',
  'amazon': 'Amazon',
  'online': 'Online'
};

/* Per-retailer "check it yourself" links. Every pattern below was verified
 * live (HTTP 200) on 2026-11-22. BrickSeek's checker takes a SKU/UPC.
 * walmart.com/search?q= could NOT be verified live (Walmart's bot wall
 * answers automated requests with a challenge), so per the build rules we
 * link to walmart.com itself instead of guessing the search URL works. */
var CHECKERS = {
  'dollar-general': 'https://brickseek.com/dollar-general-inventory-checker?sku=',
  'target': 'https://brickseek.com/target-inventory-checker?sku=',
  'home-depot': 'https://brickseek.com/home-depot-inventory-checker?sku=',
  'wm-ct': 'https://brickseek.com/walmart-inventory-checker?sku=',
  'walmart': 'https://brickseek.com/walmart-inventory-checker?sku='
};
var CHECKER_LABEL = 'Check on BrickSeek';

/* Hardcoded local stores — verified in the 2026-11-22 research. Do not add
 * stores that were not verified. */
var STORES = [
  { group: 'Walmart Supercenter', hours: '6am–11pm daily', note: 'Hidden clearance + rare $0.03 finds. Regular Walmart app does NOT show hidden-clearance prices — Walmart+ Scan & Go does. Register is the final truth.',
    items: [
      { name: '#1689 — closest, 5.7 mi', addr: '5650 S Chambers Rd, Aurora, CO 80015', phone: '303-690-6322', page: 'https://www.walmart.com/store/1689-aurora-co' },
      { name: '#5137', addr: '6101 S Aurora Pkwy, Aurora, CO 80016', phone: '303-617-1261', page: 'https://www.walmart.com/store/5137-aurora-co' },
      { name: '#3740', addr: '21475 E Quincy Ave, Aurora, CO 80015', phone: '303-248-4048' },
      { name: '#1492', addr: '14000 E Exposition Ave, Aurora, CO 80012', phone: '303-368-1115' },
      { name: '#5334', addr: '3301 Tower Rd, Aurora, CO 80011', phone: '720-374-0278' },
      { name: 'Iliff Ave', addr: '15240 E Iliff Ave, Aurora, CO 80014', phone: '303-481-3904' }
    ] },
  { group: 'Target — clearance only, no penny system', hours: '', note: 'Store-specific markdowns. BrickSeek covers ordinary clearance here.',
    items: [
      { name: 'Quincy Ave — closest', addr: '16910 E Quincy Ave, Aurora, CO 80015', phone: '303-699-1020' },
      { name: 'Ellsworth Ave (#1471)', addr: '14200 E Ellsworth Ave, Aurora, CO 80012', phone: '303-214-0114' },
      { name: 'Aurora West', addr: '1400 S Havana St, Aurora, CO 80012', phone: '303-755-8530' },
      { name: 'Aurora South', addr: '15700 E Briarwood Cir, Aurora, CO 80016', phone: '720-214-6000' },
      { name: 'Saddle Rock', addr: '7400 S Gartrell Rd, Aurora, CO 80016', phone: '303-209-2827' }
    ] },
  { group: 'Dollar General', hours: '', note: 'Weekly Tuesday penny list — the most systematic penny program. NO remote price check exists: the penny price shows only in the DG app scan and at the register.',
    items: [
      { name: '#19055 — PERMANENTLY CLOSED, do not drive here', addr: '10204 E Colfax Ave, Aurora, CO 80010', phone: '', closed: true },
      { name: '#13763 — nearest active, 12.2 mi', addr: '7400 CO-2, Commerce City, CO', phone: '' },
      { name: '#31493 — 13.0 mi', addr: '1505 S Federal Blvd, Denver, CO', phone: '' }
    ] },
  { group: 'Home Depot', hours: '', note: 'Penny finds via the PennyRecon lists (linked under Lists & Sources). Register scan is the only proof; stores can refuse penny sales.',
    items: [
      { name: '#1501 — closest to Buckley', addr: '14001 E Mississippi Ave, Aurora, CO 80012', phone: '303-743-7557' },
      { name: '#1551', addr: '3475 N Salida Ct, Aurora, CO 80011', phone: '720-374-3110' },
      { name: '#1523', addr: '5600 S Chambers Rd, Aurora, CO 80015', phone: '303-699-5006' },
      { name: '#1528', addr: '6000 S Gun Club Rd, Aurora, CO 80016', phone: '720-870-8839' },
      { name: 'Brighton', addr: '2440 Buckley Rd, Brighton, CO 80601', phone: '' }
    ] }
];

/* Weekly lists + source pages. Every URL below returned HTTP 200 on 2026-11-22. */
var SOURCE_LINKS = [
  { name: 'Freebie Guy — Dollar General penny list (master list)', url: 'https://THEFREEBIEGUY.COM/DOLLAR-GENERAL-PENNY-SHOPPING-MASTER-LIST/', note: 'The weekly DG penny list. New list usually Tuesday morning.' },
  { name: 'RetailShout — latest Dollar General penny items', url: 'https://retailshout.com/latest-dollar-general-penny-items-near-you/', note: 'DG penny items with SKU, UPC and penny date.' },
  { name: 'SavingK — Walmart hidden clearance', url: 'https://savingk.com/walmart-hidden-clearance-how-to-find-these-secret-deals/', note: 'How Walmart hidden clearance works + the clearance database.' },
  { name: 'PennyRecon — Home Depot penny lists', url: 'https://www.pennyrecon.com/', note: 'Community Home Depot penny lists by store.' },
  { name: 'Penny Hunter — daily briefing (raw JSON this app reads)', url: 'https://rocketshon.github.io/penny-finder-backend/briefings/latest.json', note: 'The public briefing file. Open it to see exactly what the app sees.' }
];

/* ---------------- storage (localStorage with in-memory fallback) ---------------- */
var memStore = {};
var store = {
  get: function (key, fallback) {
    try {
      var v = (typeof localStorage !== 'undefined') ? localStorage.getItem(key) : null;
      return v === null || v === undefined ? fallback : JSON.parse(v);
    } catch (e) {
      return (key in memStore) ? memStore[key] : fallback;
    }
  },
  set: function (key, val) {
    try {
      if (typeof localStorage !== 'undefined') { localStorage.setItem(key, JSON.stringify(val)); return; }
    } catch (e) { /* fall through to memory */ }
    memStore[key] = val;
  }
};
var LS = { watch: 'pa:watch', ignored: 'pa:ignored', seen: 'pa:seen', checks: 'pa:checks', push: 'pa:push' };

/* ---------------- pure helpers (tested) ---------------- */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function prettyStore(id) {
  if (STORE_NAMES[id]) return STORE_NAMES[id];
  return String(id).replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}
function deriveDepartment(item) {
  var text = ((item.name || '') + ' ' + (item.saleStory || '')).toLowerCase();
  if (item.kind === 'penny') return 'Penny';
  if (/pet|dog|cat|bird|fish tank|aquarium/.test(text)) return 'Pet';
  if (/toy|lego|game|doll|playset|nerf/.test(text)) return 'Toys & Games';
  if (/baby|infant|diaper|toddler|kids|children/.test(text)) return 'Baby & Kids';
  if (/shoe|cloth|apparel|dress|shirt|pants|jacket|fashion|men's|women/.test(text)) return 'Clothing';
  if (/food|snack|drink|coffee|grocery|candy|chip|juice|soda|water|popcorn/.test(text)) return 'Grocery';
  if (/clean|detergent|soap|bleach|laundry|dish/.test(text)) return 'Household';
  if (/beauty|shampoo|makeup|skincare|deodorant|vitamin|health/.test(text)) return 'Health & Beauty';
  if (/tv|headphone|computer|laptop|monitor|phone|tablet|wifi|speaker|electronic|camera/.test(text)) return 'Electronics';
  if (/tool|drill|saw|hammer|hardware|wrench/.test(text)) return 'Tools';
  if (/furniture|decor|holiday|halloween|christmas|garden|patio|bedding|towel/.test(text)) return 'Home & Seasonal';
  if (/car|auto|tire|motor oil/.test(text)) return 'Auto';
  return 'General';
}
function isExpired(deal, todayStr) {
  if (!deal.validTo) return false;
  return deal.validTo < todayStr;
}
function daysSince(dateStr, todayStr) {
  if (!dateStr) return null;
  var a = new Date(dateStr + 'T00:00:00Z').getTime();
  var b = new Date((todayStr || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z').getTime();
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}
/* Normalize the Penny Hunter briefing into a flat deal list. Never throws on
 * odd shapes — unknown fields are skipped, not crashed on. */
function normalizeBriefing(data) {
  var meta = { generatedAt: '', weekId: '', weekOf: '', headline: '' };
  var deals = [];
  if (!data || typeof data !== 'object') return { meta: meta, deals: deals };
  meta.generatedAt = data.generated_at || '';
  meta.weekId = data.week_id || '';
  meta.weekOf = data.week_of || '';
  meta.headline = data.headline || '';
  var penny = Array.isArray(data.penny_list) ? data.penny_list : [];
  penny.forEach(function (p, i) {
    if (!p || !p.item) return;
    var upc = p.upc ? String(p.upc) : '';
    deals.push({
      id: 'penny-' + (upc || ('n' + i)),
      kind: 'penny',
      name: p.item,
      upc: upc,
      storeId: p.store_id || 'dollar-general',
      source: p.source || 'community',
      note: p.note || '',
      price: '$0.01',
      originalPrice: '',
      saleStory: 'PENNY LIST',
      dept: 'Penny',
      confirmedOn: p.confirmed_on || '',
      validTo: '',
      image: ''
    });
  });
  var items = Array.isArray(data.all_items) ? data.all_items : [];
  items.forEach(function (it) {
    if (!it || !it.name) return;
    var d = {
      id: String(it.id || ('item-' + it.name)),
      kind: 'deal',
      name: it.name,
      upc: it.upc ? String(it.upc) : '',
      storeId: it.store_id || 'online',
      source: it.source || '',
      note: '',
      price: it.price || '',
      originalPrice: it.original_price || '',
      saleStory: it.sale_story || '',
      dept: 'General',
      confirmedOn: '',
      validTo: it.valid_to || '',
      image: it.image_url || ''
    };
    d.dept = deriveDepartment(d);
    deals.push(d);
  });
  return { meta: meta, deals: deals };
}

/* Normalize the weekly feed (feed/weekly.json, written by
 * scripts/parse-lists.py) into the same flat deal list. Never throws. */
function normalizeWeekly(data) {
  var meta = { generatedAt: '', sources: [] };
  var deals = [];
  if (!data || typeof data !== 'object') return { meta: meta, deals: deals };
  meta.generatedAt = data.generated_at || '';
  meta.sources = Array.isArray(data.sources) ? data.sources : [];
  var items = Array.isArray(data.items) ? data.items : [];
  items.forEach(function (it) {
    if (!it || !it.name) return;
    var upc = it.upc ? String(it.upc) : '';
    var slug = String(it.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
    var kind = it.price === '$0.01' ? 'penny' : 'deal';
    deals.push({
      id: 'w-' + (upc || (slug + '-' + (it.retailer || 'x'))),
      kind: kind,
      name: it.name,
      upc: upc,
      storeId: it.retailer || 'online',
      source: it.source || 'weekly feed',
      note: it.note || '',
      price: it.price || '',
      originalPrice: it.was || '',
      saleStory: 'WEEKLY FEED',
      dept: it.department || 'General',
      confirmedOn: it.first_seen || '',
      validTo: it.valid_to || '',
      url: it.url || '',
      sku: it.sku || '',
      image: it.image || ''
    });
  });
  return { meta: meta, deals: deals };
}

/* ---------------- app state ---------------- */
var state = {
  deals: [],
  briefingDeals: [],
  weeklyDeals: [],
  meta: { generatedAt: '', weekId: '', weekOf: '', headline: '' },
  weeklyMeta: { generatedAt: '', sources: [] },
  loadError: '',
  weeklyError: '',
  today: new Date().toISOString().slice(0, 10),
  watch: {},      // id -> deal snapshot
  ignored: {},    // id -> true
  seen: {},       // id -> first-seen date (YYYY-MM-DD)
  checks: {},     // watch id -> {scanned, shelf, register}
  filters: { q: '', retailer: '', dept: '', pennyOnly: false, showExpired: false }
};
function loadState() {
  state.watch = store.get(LS.watch, {});
  state.ignored = store.get(LS.ignored, {});
  state.seen = store.get(LS.seen, {});
  state.checks = store.get(LS.checks, {});
}
function saveState() {
  store.set(LS.watch, state.watch);
  store.set(LS.ignored, state.ignored);
  store.set(LS.seen, state.seen);
  store.set(LS.checks, state.checks);
}
function isNew(id) {
  var d = daysSince(state.seen[id], state.today);
  return d !== null && d <= 7;
}
function visibleDeals() {
  var f = state.filters;
  var q = f.q.trim().toLowerCase();
  return state.deals.filter(function (d) {
    if (state.ignored[d.id]) return false;
    if (f.pennyOnly && d.kind !== 'penny') return false;
    if (!f.showExpired && isExpired(d, state.today)) return false;
    if (f.retailer && d.storeId !== f.retailer) return false;
    if (f.dept && d.dept !== f.dept) return false;
    if (q && d.name.toLowerCase().indexOf(q) === -1 && (d.upc || '').indexOf(q) === -1) return false;
    return true;
  });
}
function checkLinks(deal) {
  var out = [];
  var base = CHECKERS[deal.storeId];
  if (deal.upc && base) {
    out.push({ label: CHECKER_LABEL + ' (' + prettyStore(deal.storeId) + ')', url: base + encodeURIComponent(deal.upc) });
  } else if (deal.upc) {
    out.push({ label: CHECKER_LABEL, url: 'https://brickseek.com/' });
  }
  if (deal.storeId === 'wm-ct' || deal.storeId === 'walmart') {
    out.push({ label: 'Open walmart.com (search the UPC there)', url: 'https://www.walmart.com/' });
  }
  return out;
}
/* Seller links (v5). Plain <a> links the USER taps — they open in the
 * user's own browser; nothing is embedded (retailers block framing) and
 * the app makes no fetch to any seller. Google Shopping is the primary
 * search (by UPC when known, else by name). A retailer search link is
 * added only when the retailer is known AND the item has a UPC, and only
 * for patterns verified live 2026-11-22: Walmart (its own search form is
 * action=/search with input name=q), Target (live results page, UPC in
 * body), Home Depot (live results page). Dollar General is NOT included:
 * its search URL could not be confirmed (403 on /search?query=, 404 on
 * the Magento-style /catalogsearch/result/?q=), so no DG link is rendered.
 * Labels say "search", never "buy" — a search link is not a verified
 * price or a confirmed listing. */
var SELLER_SEARCH = {
  'wm-ct': { label: 'Walmart', base: 'https://www.walmart.com/search?q=' },
  'walmart': { label: 'Walmart', base: 'https://www.walmart.com/search?q=' },
  'target': { label: 'Target', base: 'https://www.target.com/s?searchTerm=' },
  'home-depot': { label: 'Home Depot', base: 'https://www.homedepot.com/s/' }
};
function sellerLinks(deal) {
  var out = [];
  var q = deal.upc || deal.name || '';
  out.push({ label: 'Google Shopping search', url: 'https://www.google.com/search?tbm=shop&q=' + encodeURIComponent(q) });
  if (deal.upc) {
    var s = SELLER_SEARCH[deal.storeId];
    if (s) out.push({ label: 'Search ' + s.label + ' for this UPC', url: s.base + encodeURIComponent(deal.upc) });
  }
  return out;
}
function sellerLinksHtml(d) {
  return sellerLinks(d).map(function (l) {
    return '<a class="btn small" href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>';
  }).join(' ');
}

/* ---------------- background push (v3) ---------------- */
function b64encode(bin) {
  if (typeof btoa !== 'undefined') return btoa(bin);
  if (typeof Buffer !== 'undefined') return Buffer.from(bin, 'binary').toString('base64');
  return '';
}
function b64decode(b64) {
  if (typeof atob !== 'undefined') return atob(b64);
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('binary');
  return '';
}
function urlBase64ToUint8Array(base64String) {
  var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  var raw = b64decode(base64);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
/* Map a PushSubscription to the row stored in Supabase. Keys are base64url. */
function buildSubscriptionBody(sub) {
  function key(name) {
    var k = sub.getKey ? sub.getKey(name) : null;
    if (!k) return '';
    var bytes = new Uint8Array(k);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return b64encode(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return { endpoint: sub.endpoint, p256dh: key('p256dh'), auth: key('auth') };
}
function pushSupported() {
  return (typeof window !== 'undefined') && ('serviceWorker' in navigator) && ('PushManager' in window) && (typeof Notification !== 'undefined');
}

/* ---------------- rendering ---------------- */
function $(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
/* Deal photo (v5). The placeholder tile sits underneath the <img>; if the
 * image fails to load, onerror removes it and the placeholder shows. The
 * placeholder is a small generic product glyph plus the department name —
 * an honest "no photo" state, never a fabricated image. */
function thumbHtml(d) {
  var dept = d.dept || 'General';
  var img = d.image ? '<img src="' + esc(d.image) + '" alt="" loading="lazy" onerror="this.remove()">' : '';
  return '<div class="deal-thumb"><span class="deal-thumb-ph">' +
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l9-5 9 5v8l-9 5-9-5V8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M3 8l9 5 9-5M12 13v8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
    '<span class="deal-thumb-ph-label">' + esc(dept) + '</span></span>' + img + '</div>';
}
function dealCard(d) {
  var isW = !!state.watch[d.id];
  var links = checkLinks(d).map(function (l) {
    return '<a class="btn small" href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>';
  }).join(' ');
  var price = d.price ? '<span class="price">' + esc(d.price) + '</span>' : '';
  var was = d.originalPrice ? '<span class="was">was ' + esc(d.originalPrice) + '</span>' : '';
  var valid = d.validTo ? '<span class="meta">valid to ' + esc(d.validTo) + (isExpired(d, state.today) ? ' · EXPIRED' : '') + '</span>' : '';
  var conf = d.confirmedOn ? '<span class="meta">penny list ' + esc(d.confirmedOn) + '</span>' : '';
  var upc = d.upc ? '<span class="meta">UPC ' + esc(d.upc) + '</span>' : '<span class="meta">no UPC in this listing</span>';
  var badge = isNew(d.id) ? '<span class="badge-new">NEW</span>' : '';
  var penny = d.kind === 'penny' ? '<span class="badge-penny">PENNY</span>' : '';
  return '<article class="deal"><div class="deal-row">' + thumbHtml(d) + '<div class="deal-main">' +
    '<div class="deal-top">' + penny + badge + '<span class="retailer">' + esc(prettyStore(d.storeId)) + '</span>' +
    '<span class="dept">' + esc(d.dept) + '</span></div>' +
    '<h3>' + esc(d.name) + '</h3>' +
    '<div class="price-row">' + price + was + '</div>' +
    '<div class="deal-meta"><span class="meta">via ' + esc(d.source || 'briefing') + '</span>' + valid + conf + upc + '</div>' +
    (d.note ? '<p class="note">' + esc(d.note) + '</p>' : '') +
    '<div class="deal-actions">' +
      '<button type="button" class="btn" data-action="watch" data-id="' + esc(d.id) + '">' + (isW ? '✓ Watching' : '＋ Watch') + '</button>' +
      '<button type="button" class="btn quiet" data-action="ignore" data-id="' + esc(d.id) + '">Don’t show again</button>' +
      links + ' ' + sellerLinksHtml(d) +
    '</div></div></div></article>';
}
function renderDeals() {
  var el = $('dealList');
  if (!el) return;
  var list = visibleDeals();
  var dc = $('dealCount');
  if (dc) dc.textContent = list.length ? '(' + list.length + ')' : '';
  if (!state.deals.length) {
    el.innerHTML = '<p class="empty">No deals loaded yet. ' + (state.loadError ? esc(state.loadError) : 'Try again in a moment.') + '</p>';
    return;
  }
  if (!list.length) {
    el.innerHTML = '<p class="empty">Nothing matches these filters. Clear the search or turn off “Pennies only”.</p>';
    return;
  }
  el.innerHTML = list.slice(0, 400).map(dealCard).join('') +
    (list.length > 400 ? '<p class="hint">Showing the first 400 of ' + list.length + ' matches — narrow the search to see more.</p>' : '');
}
function renderFilters() {
  var rf = $('retailerFilter');
  if (rf && rf.options.length <= 1) {
    var seen = {};
    state.deals.forEach(function (d) { seen[d.storeId] = true; });
    Object.keys(seen).sort().forEach(function (id) {
      var o = (typeof document !== 'undefined') ? document.createElement('option') : null;
      if (!o) return;
      o.value = id; o.textContent = prettyStore(id);
      rf.appendChild(o);
    });
  }
  var df = $('deptFilter');
  if (df && df.options.length <= 1) {
    var depts = {};
    state.deals.forEach(function (d) { depts[d.dept] = true; });
    Object.keys(depts).sort().forEach(function (id) {
      var o = (typeof document !== 'undefined') ? document.createElement('option') : null;
      if (!o) return;
      o.value = id; o.textContent = id;
      df.appendChild(o);
    });
  }
}
function watchCard(d) {
  var c = state.checks[d.id] || {};
  function cb(key, label) {
    return '<label class="check"><input type="checkbox" data-check="' + key + '" data-id="' + esc(d.id) + '"' +
      (c[key] ? ' checked' : '') + '> ' + label + '</label>';
  }
  var links = checkLinks(d).map(function (l) {
    return '<a class="btn small" href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>';
  }).join(' ');
  var badge = isNew(d.id) ? '<span class="badge-new">NEW</span>' : '';
  return '<article class="deal"><div class="deal-row">' + thumbHtml(d) + '<div class="deal-main">' +
    '<div class="deal-top"><span class="retailer">' + esc(prettyStore(d.storeId)) + '</span>' +
    '<span class="dept">' + esc(d.dept) + '</span>' + badge + '</div>' +
    '<h3>' + esc(d.name) + '</h3>' +
    '<div class="price-row">' + (d.price ? '<span class="price">' + esc(d.price) + '</span>' : '') +
    (d.originalPrice ? '<span class="was">was ' + esc(d.originalPrice) + '</span>' : '') + '</div>' +
    '<div class="deal-meta">' + (d.upc ? '<span class="meta">UPC ' + esc(d.upc) + '</span>' : '<span class="meta">no UPC in this listing</span>') + '</div>' +
    '<div class="checklist"><strong>In-store checklist</strong>' +
      cb('scanned', 'Scanned it in the store’s app') +
      cb('shelf', 'Found it on the shelf') +
      cb('register', 'Register rang the deal price') +
      '<p class="hint">If the register rings full price or locks up, the deal isn’t real at this store. A manager can refuse a penny sale.</p></div>' +
    '<div class="deal-actions">' + links + ' ' + sellerLinksHtml(d) +
      '<button type="button" class="btn quiet" data-action="unwatch" data-id="' + esc(d.id) + '">Stop watching</button></div>' +
    '</div></div></article>';
}
function renderWatchlist() {
  var el = $('watchList');
  var wc = $('watchCount');
  var ids = Object.keys(state.watch);
  if (wc) wc.textContent = ids.length ? '(' + ids.length + ')' : '';
  if (el) {
    el.innerHTML = ids.length
      ? ids.map(function (id) { return watchCard(state.watch[id]); }).join('')
      : '<p class="empty">Nothing watched yet. Tap “Watch” on any deal and it shows up here with its in-store checklist.</p>';
  }
  var ig = $('ignoredList');
  if (ig) {
    var ignoredIds = Object.keys(state.ignored);
    ig.innerHTML = ignoredIds.length
      ? ignoredIds.map(function (id) {
          var d = state.watch[id] || state.deals.filter(function (x) { return x.id === id; })[0];
          var name = d ? d.name : id;
          return '<article class="deal ignored"><h3>' + esc(name) + '</h3>' +
            '<div class="deal-actions"><button type="button" class="btn" data-action="unignore" data-id="' + esc(id) + '">Show again</button></div></article>';
        }).join('')
      : '<p class="empty">Nothing marked off.</p>';
  }
}
function renderStores() {
  var el = $('storeList');
  if (!el) return;
  el.innerHTML = STORES.map(function (g) {
    var rows = g.items.map(function (s) {
      var tel = s.phone ? '<a href="tel:+1' + s.phone.replace(/[^0-9]/g, '') + '">' + esc(s.phone) + '</a>' : '—';
      var page = s.page ? ' · <a href="' + esc(s.page) + '" target="_blank" rel="noopener">Store page</a>' : '';
      return '<div class="store' + (s.closed ? ' closed' : '') + '">' +
        '<strong>' + esc(s.name) + '</strong><br>' + esc(s.addr) + '<br>' +
        '<span class="meta">Phone: ' + tel + page + '</span></div>';
    }).join('');
    return '<section class="store-group"><h2>' + esc(g.group) + (g.hours ? ' <span class="meta">· ' + esc(g.hours) + '</span>' : '') + '</h2>' +
      (g.note ? '<p class="hint">' + esc(g.note) + '</p>' : '') + rows + '</section>';
  }).join('');
}
function renderSources() {
  var el = $('sourceLinks');
  if (!el) return;
  el.innerHTML = SOURCE_LINKS.map(function (s) {
    return '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.name) + '</a><br><span class="meta">' + esc(s.note) + '</span></li>';
  }).join('');
}
function renderBriefingBar() {
  var bar = $('briefingBar');
  var stale = $('staleBar');
  if (!bar) return;
  if (state.loadError && !state.deals.length && !state.weeklyDeals.length) {
    bar.textContent = 'Couldn’t load the deal briefing: ' + state.loadError;
    return;
  }
  var m = state.meta;
  var gen = m.generatedAt ? m.generatedAt.slice(0, 10) : '';
  var age = gen ? daysSince(gen, state.today) : null;
  var wgen = state.weeklyMeta.generatedAt ? state.weeklyMeta.generatedAt.slice(0, 10) : '';
  var wage = wgen ? daysSince(wgen, state.today) : null;
  var weeklyPart;
  if (wgen) {
    var when = wage === 0 ? 'today' : wage === 1 ? 'yesterday' : wage + ' days ago';
    weeklyPart = 'Weekly feed: updated ' + wgen + ' (' + when + ') · ' + state.weeklyDeals.length + ' items';
  } else if (state.weeklyError) {
    weeklyPart = 'Weekly feed: not loaded (' + state.weeklyError + ')';
  } else {
    weeklyPart = 'Weekly feed: not loaded yet';
  }
  bar.textContent = 'Briefing: week ' + (m.weekId || '—') + ' (' + (m.weekOf || '—') + ') · generated ' + (gen || 'unknown') +
    ' · ' + state.deals.length + ' deals — ' + weeklyPart;
  if (stale) {
    if (age !== null && age > 7) {
      stale.hidden = false;
      stale.textContent = '⚠ This briefing is ' + age + ' days old — Penny Hunter hasn’t published a newer one. Penny lists rotate weekly, so treat these as leads, not this week’s list.' +
        (wgen ? ' The weekly feed above was updated ' + wgen + ' — use it first.' : ' Use the Lists & Sources tab for the current weekly lists.');
    } else {
      stale.hidden = true;
      stale.textContent = '';
    }
  }
}
function renderWeeklySources() {
  var el = $('weeklySources');
  if (!el) return;
  var srcs = state.weeklyMeta.sources || [];
  if (!srcs.length) {
    el.innerHTML = '<li><span class="meta">Weekly feed not loaded yet — the scheduled job publishes it daily. See the links below.</span></li>';
    return;
  }
  el.innerHTML = srcs.map(function (s) {
    var status = s.status === 'ok' ? '✓ ' + s.item_count + ' item' + (s.item_count === 1 ? '' : 's')
      : s.status === 'link-only' ? 'link only — ' + (s.note || 'open it manually')
      : 'failed — ' + (s.note || s.status);
    return '<li><strong>' + esc(s.name) + '</strong> — ' + esc(status) +
      '<br><span class="meta"><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.url) + '</a></span></li>';
  }).join('');
}
/* Push state lives in localStorage ('pa:push' = 'on' when subscribed) and
 * is confirmed against the browser's real subscription on load. */
function setNotifUI(mode, text) {
  var btn = $('notifBtn');
  var st = $('notifState');
  if (!btn || !st) return;
  if (mode === 'on') {
    btn.textContent = '🔔 Alerts on — tap to turn off';
    btn.disabled = false;
    st.textContent = text || 'On. New deals push to this phone, even when the app is closed.';
  } else if (mode === 'off') {
    btn.textContent = '🔔 Enable alerts';
    btn.disabled = false;
    st.textContent = text || 'Tap “Enable alerts” — new deals will push to this phone.';
  } else {
    btn.textContent = '🔔 Enable alerts';
    btn.disabled = true;
    st.textContent = text;
  }
}
function renderNotif() {
  if (typeof Notification === 'undefined') {
    setNotifUI('disabled', 'This browser doesn’t support notifications. Alerts are checked when you open the app.');
    return;
  }
  if (Notification.permission === 'denied') {
    setNotifUI('disabled', 'Notifications are blocked for this site in your browser settings. Alerts are checked when you open the app.');
    return;
  }
  if (!pushSupported()) {
    /* No service worker / PushManager (e.g. an old browser or a plain tab):
     * on-open alerts only, as in v1/v2. */
    setNotifUI('off', 'This browser can’t do background push. Tap “Enable alerts” and new deals will pop up when you open the app.');
    return;
  }
  setNotifUI(store.get(LS.push, '') === 'on' ? 'on' : 'off');
  refreshPushState();
}
function refreshPushState() {
  if (!pushSupported()) return Promise.resolve(false);
  try {
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      var on = !!sub;
      store.set(LS.push, on ? 'on' : '');
      setNotifUI(on ? 'on' : 'off');
      return on;
    }).catch(function () { return false; });
  } catch (e) { return Promise.resolve(false); }
}
function saveSubscription(sub) {
  var body = buildSubscriptionBody(sub);
  if (!body.endpoint || !body.p256dh || !body.auth) return Promise.resolve(false);
  if (typeof fetch === 'undefined') return Promise.resolve(false);
  return fetch(SUPABASE_URL + '/rest/v1/push_subscriptions', {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_PUBLISHABLE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(body)
  }).then(function (resp) {
    /* 409 = this endpoint is already stored. Either way the phone is covered. */
    return resp.ok || resp.status === 409;
  }).catch(function () { return false; });
}
function enablePush() {
  if (!pushSupported()) return Promise.resolve(false);
  return Notification.requestPermission().then(function (perm) {
    if (perm !== 'granted') { renderNotif(); return false; }
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }).then(function (sub) {
      return saveSubscription(sub);
    }).then(function (ok) {
      store.set(LS.push, ok ? 'on' : '');
      renderNotif();
      return ok;
    }).catch(function () {
      renderNotif();
      return false;
    });
  });
}
function disablePush() {
  if (!pushSupported()) { store.set(LS.push, ''); renderNotif(); return Promise.resolve(false); }
  return navigator.serviceWorker.ready.then(function (reg) {
    return reg.pushManager.getSubscription();
  }).then(function (sub) {
    if (sub) return sub.unsubscribe();
    return false;
  }).then(function () {
    /* The endpoint is now dead; the sender prunes it on the next 404/410.
     * Anon cannot DELETE rows (by design — see the migration), so there is
     * no server delete from the app. */
    store.set(LS.push, '');
    renderNotif();
    return true;
  }).catch(function () {
    store.set(LS.push, '');
    renderNotif();
    return false;
  });
}
function togglePush() {
  if (store.get(LS.push, '') === 'on') return disablePush();
  return enablePush();
}

/* ---------------- actions ---------------- */
function findDeal(id) {
  var d = state.deals.filter(function (x) { return x.id === id; })[0];
  return d || state.watch[id] || null;
}
function handleAction(action, id) {
  if (action === 'watch') {
    var d = findDeal(id);
    if (d) { state.watch[id] = d; }
  } else if (action === 'unwatch') {
    delete state.watch[id];
    delete state.checks[id];
  } else if (action === 'ignore') {
    state.ignored[id] = true;
    delete state.watch[id];
  } else if (action === 'unignore') {
    delete state.ignored[id];
  }
  saveState();
  renderDeals();
  renderWatchlist();
}
function handleCheck(id, key, checked) {
  if (!state.checks[id]) state.checks[id] = {};
  state.checks[id][key] = !!checked;
  saveState();
}

/* ---------------- loading the briefing ---------------- */
function markSeenAndNotify(newIds) {
  var fresh = [];
  newIds.forEach(function (id) {
    if (!state.seen[id]) {
      state.seen[id] = state.today;
      fresh.push(id);
    }
  });
  saveState();
  if (fresh.length && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      var n = new Notification('Penny Alerts: ' + fresh.length + ' new deal' + (fresh.length === 1 ? '' : 's') + ' found', {
        body: 'Open the app to see them. Remember: a lead is not a confirmation — scan in store.',
        tag: 'penny-alerts-new'
      });
      if (n && n.close) { setTimeout(function () { try { n.close(); } catch (e) {} }, 12000); }
    } catch (e) { /* notifications are best-effort */ }
  }
  return fresh.length;
}
/* Weekly feed first (it is the fresh one): briefing deals whose UPC also
 * appears in the weekly feed are dropped — the weekly copy is fresher. */
function mergeFeeds() {
  var weeklyUpcs = {};
  (state.weeklyDeals || []).forEach(function (d) { if (d.upc) weeklyUpcs[d.upc] = true; });
  var briefingDeals = (state.briefingDeals || []).filter(function (d) { return !(d.upc && weeklyUpcs[d.upc]); });
  state.deals = (state.weeklyDeals || []).concat(briefingDeals);
}
function loadBriefing() {
  if (typeof fetch === 'undefined') {
    state.loadError = 'This browser can’t fetch the briefing (no fetch).';
    renderBriefingBar(); renderDeals();
    return Promise.resolve();
  }
  var weeklyP = fetch(WEEKLY_URL, { cache: 'no-store' }).then(function (resp) {
    if (!resp.ok) throw new Error('weekly feed returned HTTP ' + resp.status);
    return resp.json();
  }).then(function (data) {
    var norm = normalizeWeekly(data);
    state.weeklyMeta = norm.meta;
    state.weeklyDeals = norm.deals;
  }).catch(function (err) {
    state.weeklyError = (err && err.message) ? err.message : 'network error';
    state.weeklyMeta = { generatedAt: '', sources: [] };
    state.weeklyDeals = [];
  });
  var briefingP = fetch(BRIEFING_URL, { cache: 'no-store' }).then(function (resp) {
    if (!resp.ok) throw new Error('briefing returned HTTP ' + resp.status);
    return resp.json();
  }).then(function (data) {
    var norm = normalizeBriefing(data);
    state.meta = norm.meta;
    state.briefingDeals = norm.deals;
  }).catch(function (err) {
    state.loadError = (err && err.message) ? err.message : 'network error';
    state.briefingDeals = [];
  });
  return Promise.all([weeklyP, briefingP]).then(function () {
    mergeFeeds();
    var fresh = markSeenAndNotify(state.deals.map(function (d) { return d.id; }));
    renderBriefingBar(); renderFilters(); renderDeals(); renderWatchlist(); renderWeeklySources();
    return fresh;
  });
}

/* ---------------- wiring ---------------- */
function switchTab(name) {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('.tab').forEach(function (t) {
    t.classList.toggle('active', t.getAttribute('data-tab') === name);
  });
  document.querySelectorAll('.tab-panel').forEach(function (p) {
    p.hidden = (p.id !== 'tab-' + name);
  });
  if (name === 'watchlist') renderWatchlist();
}
function init() {
  loadState();
  renderStores();
  renderSources();
  renderNotif();
  renderWatchlist();
  if (typeof document === 'undefined') return;
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); });
  });
  var dl = $('dealList');
  if (dl) dl.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (b) handleAction(b.getAttribute('data-action'), b.getAttribute('data-id'));
  });
  var wl = $('watchList');
  if (wl) {
    wl.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
      if (b) handleAction(b.getAttribute('data-action'), b.getAttribute('data-id'));
    });
    wl.addEventListener('change', function (ev) {
      var c = ev.target;
      if (c && c.getAttribute && c.getAttribute('data-check')) {
        handleCheck(c.getAttribute('data-id'), c.getAttribute('data-check'), c.checked);
      }
    });
  }
  var ig = $('ignoredList');
  if (ig) ig.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (b) handleAction(b.getAttribute('data-action'), b.getAttribute('data-id'));
  });
  var sb = $('searchBox');
  if (sb) sb.addEventListener('input', function () { state.filters.q = sb.value; renderDeals(); });
  var rf = $('retailerFilter');
  if (rf) rf.addEventListener('change', function () { state.filters.retailer = rf.value; renderDeals(); });
  var df = $('deptFilter');
  if (df) df.addEventListener('change', function () { state.filters.dept = df.value; renderDeals(); });
  var po = $('pennyOnly');
  if (po) po.addEventListener('change', function () { state.filters.pennyOnly = po.checked; renderDeals(); });
  var se = $('showExpired');
  if (se) se.addEventListener('change', function () { state.filters.showExpired = se.checked; renderDeals(); });
  var nb = $('notifBtn');
  if (nb) nb.addEventListener('click', function () {
    if (!pushSupported()) {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().then(function () { renderNotif(); });
      }
      return;
    }
    togglePush();
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline cache is best-effort */ });
  }
  loadBriefing();
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', init);
}
if (typeof window !== 'undefined') {
  window.PennyAlerts = {
    BRIEFING_URL: BRIEFING_URL,
    WEEKLY_URL: WEEKLY_URL,
    APP_URL: APP_URL,
    SUPABASE_URL: SUPABASE_URL,
    VAPID_PUBLIC_KEY: VAPID_PUBLIC_KEY,
    urlBase64ToUint8Array: urlBase64ToUint8Array,
    buildSubscriptionBody: buildSubscriptionBody,
    pushSupported: pushSupported,
    normalizeBriefing: normalizeBriefing,
    normalizeWeekly: normalizeWeekly,
    mergeFeeds: mergeFeeds,
    deriveDepartment: deriveDepartment,
    isExpired: isExpired,
    daysSince: daysSince,
    prettyStore: prettyStore,
    checkLinks: checkLinks,
    sellerLinks: sellerLinks,
    thumbHtml: thumbHtml,
    STORES: STORES,
    SOURCE_LINKS: SOURCE_LINKS,
    _state: state,
    _visibleDeals: visibleDeals,
    _handleAction: handleAction
  };
}
