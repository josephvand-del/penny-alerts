# Penny Alerts — Aurora, CO 80017

Free penny-deal and clearance alerts for the stores around Aurora, CO 80017.
Live at https://josephvand-del.github.io/penny-alerts/ — install it from your
phone's home screen (it's a PWA).

## What it does

- **Deal feed** from two free feeds, merged with the freshest first:
  the **weekly feed** (`feed/weekly.json`, parsed every morning from the
  community lists below) and Penny Hunter's public daily briefing
  (`https://rocketshon.github.io/penny-finder-backend/briefings/latest.json`),
  filterable by store, department, and "pennies only". Each deal shows its
  name, price / was-price, source, and a Watch button. Where the same UPC
  appears in both feeds, the weekly copy wins (it is fresher). Each card
  shows the **list date** the item came from ("penny list 2026-10-27") —
  not the date the parser ran — so an old archive item reads as old.
- **Sort + Future**: the Deals tab sorts **Most recent** (newest list date
  first, the default) or **Most verified** (most independent sources first;
  in that mode each card shows "✓ N sources" under its picture). The
  **Future** checkbox shows only deals whose list date is after today —
  right now that is PennyPinchinMom's Nov 24 list (105 items).
- **Watchlist** (saved on your phone): tap Watch on any deal. Each watched
  item gets an in-store checklist — scan in the store's app, find it on the
  shelf, confirm the register price.
- **Mark-off / ignore list**: "Don't show again" hides an item everywhere,
  with a way to un-mark it.
- **One-tap app links**: each card has one link — "Open in {Store} app"
  for Walmart, Target, Home Depot, and Dollar General. On Android it opens the store's
  app (falling back to a Google search for the item if the app isn't
  installed); on other phones it opens the store's own page for the
  item. Stores with no app link get a Google Shopping search instead.
- **Alerts**: tap "Enable alerts" and this phone subscribes for true
  background push — new deals push to it even when the app is closed.
  Until the one-time setup below is done, alerts are honestly labelled:
  **checked when you open the app.** Tap the button again to turn
  alerts off (the sender then prunes the dead subscription).
- **Deal photos**: every home-page card shows a thumbnail of the item
  (lazy-loaded). Items with no photo anywhere get a clean placeholder
  tile — a small product glyph plus the department name — never a
  fabricated image. See "Deal photos — where they come from" below.
- **Seller links**: every card has exactly one link. For Walmart, Target,
  Home Depot, and Dollar General it is "Open in {Store} app" — on Android an intent URL
  that opens the store app (Google Shopping search for the item is the
  fallback if the app isn't installed); elsewhere the store's own page
  for the item. Home Depot searches by product name (a SKU search
  server-redirects to the product page and blanks the in-app view).
  Other stores get a Google Shopping search for the item
  (by UPC when known, else by name). Labels say "app" / "search", never
  "buy". Tapping one opens the store app or your browser; nothing is
  embedded.

## Deal photos — where they come from

Photos are added at parse time, never by the app at runtime. The
parser (`scripts/parse-lists.py`) records one `image` URL per item, in
this priority order:

1. **List-page photos** — captured from the item's own card/row:
   RetailShout (every card carries a product photo) and PennyRecon
   (every card carries a product photo). Freebie Guy, Krazy Coupon
   Lady, PennyPinchinMom and FreeStuffFinder carry no per-item photos
   (KCL and FreeStuffFinder embed one generic store photo above their
   lists — the parser drops shared images like that on purpose).
2. **Previous-feed cache** — if a UPC already had a photo in the last
   feed, it is reused and never looked up again.
3. **Open Food Facts** (free, no key) — food/grocery UPCs only, looked
   up at ~1/sec, capped at 150 UPCs per run (env
   `OFF_LOOKUPS_PER_RUN`); candidates rotate daily so every UPC gets
   a turn over successive runs.
4. **Open Products Facts** (free, no key) — the general-products
   sibling of Open Food Facts, same API shape, same caps (env
   `OPF_LOOKUPS_PER_RUN`). Its hit rate on these lists is low
   (4 of 353 UPCs on the 2026-11-22 sweep) but it costs nothing.
   Open Beauty Facts was tested on the same sample and matched 0 of
   15, so it is not used.
5. **og:image from the item's own page** — for items that carry a
   `url` but no UPC (Slickdeals deal pages: the RSS has no thumbnails,
   but each deal page has an og:image). Capped at 40 pages per run
   (env `OG_LOOKUPS_PER_RUN`), ~1/sec, one retry on transient errors.
6. **UPCitemdb** — only if a paid key is set (see below).

Coverage is partial by design — measured on the 2026-11-23 regenerated
feed (660 items): **373/660 (56%) have a photo**. Per source:
PennyRecon 166/166, RetailShout 38/38, Slickdeals 25/25,
Freebie Guy 104/135, Krazy Coupon Lady 20/88, FreeStuffFinder 15/103,
PennyPinchinMom 5/105. The gaps are structural, not bugs: the DG
lists are text tables with no per-item photos and no per-item links,
so only their UPCs that a free product database knows get a photo
(Open Food Facts matched 89 of 442 UPCs in total, Open Products Facts
4 more). The remaining 287 items show the placeholder tile.

Diagnosis, verified 2026-11-22: the placeholders are **not** broken
image loads. Every photo host in the feed was probed with a
browser-like request (browser user agent + the app page as Referer):
`images.thdstatic.com` 8/8 loaded, `images.openfoodfacts.org` 8/8,
`retailshout.com` 8/8, `slickdeals.net` 3/3,
`images.openproductsfacts.org` 3/3 — no hotlink protection anywhere.
The 287 letter tiles are items with no image in the feed at all.

One honest note: PennyRecon's product photos live on Home Depot's
image CDN (`images.thdstatic.com`) — that is the URL PennyRecon
itself embeds on its own list pages, and the parser records exactly
that URL. The app never fetches or scrapes any retailer site: it makes
no `fetch()`/XHR call to any retailer domain, and the `<img>` tags
only load URLs already recorded in the feed. The only hosts images
come from are the list authors' own hosts (retailshout.com,
slickdeals.net), `images.thdstatic.com` (via PennyRecon),
`images.openfoodfacts.org`, `images.openproductsfacts.org`, and
`f.wishabi.net` (Penny Hunter's briefing images). Joseph decided
2026-11-22 to keep the Home Depot photos: dropping them would cut
coverage from 48% to ~24%.

### Optional: eBay Browse API by GTIN (free — the best keyed option)

The eBay Browse API is free (default 5,000 calls/day) and searches
listings by GTIN, returning each result's photo. It needs a free eBay
developer account (App ID / client ID + client secret) — no credit
card, but production access may need eBay Partner Network signup and
a Growth Check. It is NOT wired up yet: the parser has no eBay code,
and no key exists. If Joseph ever wants it: create the app at
developer.ebay.com, add GitHub Secrets `EBAY_CLIENT_ID` and
`EBAY_CLIENT_SECRET`, and the parser would get an app token (client
credentials grant) and search by GTIN for UPCs still imageless. Two
honest caveats: results are live eBay listings, so the first photo
may be a used item or a close variant rather than the exact product;
and the 5,000/day cap is shared across the whole app. This is the
only free keyed route worth doing — go-upc ($74.95/mo, key required)
and Barcode Lookup ($99/mo, key required) are paid and not
recommended, and UPCitemdb's free keyless trial is dead on shared IPs
(see below).

### Optional: UPCitemdb (paid, $99/mo — almost certainly not worth it)

### Optional: UPCitemdb (paid, $99/mo — almost certainly not worth it)

UPCitemdb's free tier is keyless (100 lookups/day on the trial
endpoint) — but that budget is per IP, and from shared IPs (this VM,
GitHub Actions runners) it answers `429 EXCEED_LIMIT` with 0
remaining on the very first call (verified live 2026-11-22). So the
only working UPCitemdb path is the paid DEV plan ($99/mo, 20,000
lookups/day). Open Food Facts + the list photos cover most items
already, so this is an optional upgrade, not a requirement. If you
ever want it: sign up for DEV at upcitemdb.com, copy the `user_key`
(and the `key_type` shown next to it — DEV keys use `3`), add a
GitHub Secret named `UPCITEMDB_KEY` (and `UPCITEMDB_KEY_TYPE` only
if the dashboard shows a different value), and add this env line to
the workflow file's "Parse weekly lists" step
(`.github/workflows/update-feed.yml`, edited on github.com):

```yaml
      - name: Parse weekly lists
        env:
          UPCITEMDB_KEY: ${{ secrets.UPCITEMDB_KEY }}
        run: python scripts/parse-lists.py
```

The parser caps UPCitemdb at 30 lookups per run (env
`UPCITEMDB_LOOKUPS_PER_RUN`) and stops on a 429, so a bad key or an
exhausted quota can never fail the feed job.

## Seller links — where they go

Every deal card carries exactly one link — a plain `<a>` tag, no popup,
no embedded page (retailers block framing, so the modal idea was dropped):

- **"Open in {Store} app"** (Walmart, Target, Home Depot, Dollar General): on Android
  this is an `intent://` URL with the store's Android package
  (`com.walmart.android`, `com.target.ui`, `com.thehomedepot`, `com.dollargeneral.android`) and a
  Google search for the item as `browser_fallback_url` — so a
  tap opens the store app when it is installed, and falls back to a
  Google search for the item when it is not (never to the store
  website). On other phones it is the plain store URL for the item
  (iOS Universal Links open the app there). Home Depot searches by
  product name. Store queries are punctuation-free (v11): every
  non-alphanumeric character is stripped from the query, words intact,
  in order — the HD app choked on `/` (v9, searched only "1-1") and
  on `#` (v10, the screw still would not open), and the screw still
  failed with other punctuation left in the path, so one symbol at a
  time was abandoned. Walmart and Target search by UPC, then name.
  Dollar General opens the app's home screen
  (`dollargeneral.com/`, v10): the DG app rejects `/product-search`
  deep links — the v8 link (with `&productSearchedMode=manual`) and
  the v9 link (bare) both fell back to Google on the phone — so the
  link lands in the app and the search/scan happens from there.
  Dollar General's fallback is a Google **web** search for
  "`<UPC or name>` Dollar General" (v11): the Shopping fallback
  showed irrelevant products (a penny UPC matches nothing in
  Google's catalog), while a web search surfaces the community
  penny lists that describe the item. Other stores keep the
  Google Shopping fallback.
  DG catalog limit: most DG penny items are not in DG's online
  catalog at all, so an in-app search may not find them either —
  the in-store scan is the check for DG pennies.
- **Copy** (every deal card and watchlist card, v11): a small button
  next to the item name copies the full original name — `#` and
  punctuation intact — to paste into a store app. It flips to
  "Copied" for a moment on success.
- **Version footer** (v11): the page footer reads "Penny Alerts v11"
  (bumped every release) so the version a phone is actually running
  is visible at a glance — the repeated stale-cache confusion is
  why it exists. (v12: "Penny Alerts v12".)
- **Google Shopping search** (every other store): `google.com/search?tbm=shop&q=<UPC>`
  when the item has a UPC, else `q=<item name, URL-encoded>`.

All three retailer patterns were verified live 2026-11-22: Walmart's
own homepage search form is `action=/search` with input `name=q`
(the results page itself is behind a PerimeterX wall for automated
fetches, so results were confirmed by the form, not by reading them);
Target returned a live results page with the UPC in it; Home Depot
returned a live "Search Results for <UPC>" page; Home Depot
returned a live "Search Results for <name>" page (2026-11-22), and
`/s/<SKU>` resolves to the exact product page on the web but blanks
the in-app view after its server redirect, which is why Home Depot
searches by name. **Dollar General** used the search pattern from
its own search box (`/product-search?q=<query>`, verified 2026-11-22)
through v9, but the DG app rejects that deep link on the phone, so
v10 opens the app's home screen instead; the old
`/search?query=` pattern is a branded
404 and is never used. Labels say "search",
never "buy" — a search link is a starting point, not a verified price
or a confirmed listing, and walmart.com search results in particular
could not be read by any automated fetch (PerimeterX "Robot or
human?" wall); a tap opens the page in your own browser, which is a
different thing from our fetch.

## Filters — stores, departments, sort, Future

Both dropdowns are built from the **weekly feed only** — the stale
briefing's stores never appear, so the store list is just the stores
with current deals. Each entry shows a deal count after the name
("Dollar General (469)"), most deals first, ties alphabetical.
Departments come from a keyword classifier on the item name
(`classifyDept` in `app.js`): it is a best-guess from names, so some
items land in General, and a few will be misfiled. There is no
"Penny" department — penny-ness shows via the $0.01 price and the
PENNY badge, not the department.

**Sort (v12):** "Most recent" (default) orders by the item's list date,
newest first; "Most verified" orders by how many independent lists
carried the item, then by list date. In Most verified mode each card
shows "✓ N sources" under its picture. **Future (v12):** the checkbox
next to "Show expired" shows only deals whose list date is after today
— currently PennyPinchinMom's Nov 24 list.

The app subscribes this phone with the Web Push API (VAPID public key in
`app.js` — public, safe to commit) and stores the subscription in
Supabase (`push_subscriptions` table, shared "bulk finder" project).
`scripts/send-push.py` runs in the same daily workflow right after the
parser: it diffs the new feed against the committed one and, when there
are new items, sends ONE summary push per subscribed phone ("3 new penny
deals", naming the top items). Subscriptions the push service rejects
(404/410) are pruned automatically. Push errors never fail the workflow.

One-time setup, in order (Joseph):
1. Add the workflow file on github.com (see
   `.github/workflows/update-feed.yml` — it now does feed + push in one
   file, and REPLACES the earlier feed-only version; do not add the old one).
2. Run `supabase/migrations/20261122153000_push_subscriptions.sql` in the
   Supabase dashboard → SQL editor. It creates the table with RLS +
   explicit grants (anon may INSERT only; reads/deletes are service_role
   only).
3. Add two GitHub Secrets (repo → Settings → Secrets and variables →
   Actions): `VAPID_PRIVATE_KEY` (the private key — kept outside the
   repo, delete the file after pasting) and `SUPABASE_SERVICE_ROLE_KEY`
   (Supabase dashboard → Project Settings → API — never put it in chat).
4. Install the PWA on the phone home screen, open it, tap Enable alerts.

## Data sources (all free)

The weekly feed (`feed/weekly.json`) is written by
`scripts/parse-lists.py`, which runs daily at 6am ET via GitHub Actions
(see `.github/workflows/update-feed.yml` — that one file is added by
Joseph on github.com, because GitHub Apps cannot push workflow files).
It reads only public coupon-blog lists and RSS feeds — never a retailer
site. Parsing reuses Penny Hunter's approach
([Rocketshon/penny-finder-backend](https://github.com/Rocketshon/penny-finder-backend),
MIT): the UPC-line regex for the penny-list pages, the category/signal
logic for RSS, and the retailer map + price extraction for Slickdeals.

Verified live 2026-11-22, re-verified and corrected 2026-11-23
(counts from the regenerated run — 660 items total, 469 unique UPCs):

| Source | What happens |
| --- | --- |
| Freebie Guy — DG penny list (master list) | Parsed — 135 items, all from previous weeks' lists (see audit below) |
| RetailShout — DG penny items | Parsed — 50 items (structured cards); 38 survive dedupe |
| Krazy Coupon Lady — DG penny list | Parsed — 105 items; 88 survive dedupe |
| PennyPinchinMom — DG penny list | Parsed — 105 items (table), all dated Nov 24, 2026 |
| FreeStuffFinder — DG penny list | Parsed — 266 items; 103 survive dedupe |
| Slickdeals — frontpage RSS | Parsed — 25 online deals (expire within hours) |
| PennyRecon — Home Depot penny items | Parsed — 166 of 304 live on site (name + HD SKU + retail; no UPC is exposed in the list HTML; only items with detail pages are parseable) |
| Freebie Guy RSS / PennyPinchinMom RSS | Parsed — post-level signals only (0 items; the list pages carry the real UPCs) |
| SavingK — Walmart hidden clearance | Link-only — the page is a guide, no parseable deal database exists |
| Krazy Coupon Lady — Home Depot penny items | Link-only — the page loads but the list is not in the static HTML (JS-rendered) |

The Freebie Guy Home Depot link was dropped in v12 — the page is a
404, and a dead link is worse than no link.

### Audit findings (2026-11-22, fixed in v12)

Joseph clicked the Freebie Guy link, saw no list of items, and suspected
false data. He was right about what he saw, and the data was real — both
at once:

- **Freebie Guy's 135 UPCs are real and on the page — but none of them
  are the current list.** The page's current section ("Effective Friday,
  November 20, 2026") has zero items, only category names. All 135 come
  from four collapsed "Previous 4 Dollar General Penny Lists" sections
  (Oct 27: 79, Nov 17: 28, Nov 3: 25, Sep 15: 3), closed by default on
  phones. Every card now shows the list date it came from, so an Oct 27
  item reads "penny list 2026-10-27".
- **Staleness is systemic, not one source.** Of the 492 DG items, only
  ~179 come from a current-week section: KCL has 15/105 in "This Week's"
  (90 under "Past…", which carries no dates on the page), FreeStuffFinder
  has 9 in its current Nov 10 section (110 from Oct 27 alone).
  PennyPinchinMom is the cleanest — all 105 from one list dated
  Nov 24, 2026 — and RetailShout is all current (Nov 20). Archive items
  are kept on purpose: an old penny can still ring up in a store. But
  their age is now visible and sortable instead of hidden behind the
  parser's run date.
- **Dedupe bug (fixed):** the old code let a later copy of a UPC replace
  the first copy when it had a photo — which stole 83 of Freebie Guy's
  135 UPCs for other sources, because Freebie Guy carries no per-item
  photos and the other lists pick up a generic page-header photo (later
  stripped anyway). First source now always wins; a later copy may only
  lend its photo. Freebie Guy is back to 135 in the feed.
- **UPC bug (fixed):** UPCs were compared as exact strings, but
  RetailShout drops the leading zero (11-digit). The same product
  entered twice — 23 duplicates. UPCs are now normalized (11-digit
  padded to 12) before dedupe: 492 UPC items → 469 unique products.
- **Source counts (new):** the parser records every list that carried an
  item before deduping (`sources` / `source_count` per item: 494 items
  in 1 source, 140 in 2, 26 in 3). That is what "Most verified" ranks on.
- **PennyRecon honesty:** the site lists 304 live $0.01 items, but only
  166 have detail pages the parser can read — and all 138 dropped are
  "Low likelihood". The source line now says "166 of 304" instead of
  silently showing a subset.

The Penny Hunter briefing JSON (30+ sources incl. the KCL DG penny list,
Freebie Guy, Slickdeals, Flipp weekly ads) is still read as a fallback —
it is the only thing the app fetches automatically besides the weekly
feed. Weekly DG penny lists are also linked out below, as before:

- Weekly DG penny lists: [Freebie Guy master list](https://THEFREEBIEGUY.COM/DOLLAR-GENERAL-PENNY-SHOPPING-MASTER-LIST/)
  and [RetailShout](https://retailshout.com/latest-dollar-general-penny-items-near-you/)
- [SavingK — Walmart hidden clearance](https://savingk.com/walmart-hidden-clearance-how-to-find-these-secret-deals/)
- [PennyRecon — Home Depot penny lists](https://www.pennyrecon.com/)

## What it does NOT do

- It never calls walmart.com or any retailer endpoint automatically. No scraping, no paid APIs, no Discord.
- It cannot confirm a penny at a specific store. Only a scan in the
  store's app — and the register — can do that. A deal here is a lead:
  "go check it."
- Dollar General has no remote price check at all, paid or free.

## Honest caveat — the briefing can go stale

The briefing file is published by Penny Hunter's project. If it hasn't been
republished recently, the app says so at the top ("This briefing is N days
old") and expired weekly-ad items are hidden by default. The weekly feed
above is the fresh source — it is rebuilt every morning from the lists,
so it stays current even when the briefing is old. If a list source fails
one morning, the job records the failure in the feed and keeps the
previous good items; the Lists & Sources tab shows each source's status.

## Planned next

- Optional King Soopers auto price-check via Kroger's free public API
  (needs a free Kroger developer account).

## Files

`index.html`, `app.js`, `styles.css`, `manifest.json`, `sw.js`
(service-worker cache `penny-alerts-v12`), `icon.svg`, `README.md`,
`scripts/parse-lists.py` + `scripts/send-push.py` +
`scripts/test-parse-images.py` +
`scripts/requirements.txt` (the weekly-feed parser and the push sender),
`feed/weekly.json` (generated daily by the parser; committed when it
changes), `supabase/migrations/20261122153000_push_subscriptions.sql`
(run by Joseph in the Supabase dashboard SQL editor). Plain HTML/CSS/JS,
no build step, no backend. The scheduled job is
`.github/workflows/update-feed.yml` — added on github.com, not pushed
from here.
