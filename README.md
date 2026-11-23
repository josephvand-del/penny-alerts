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
- **Bundles tab — coupon stacks (v13)**: a second tab next to Deals,
  for coupon-stack / bundle deals — buy the bundle, clip the digitals,
  earn the rewards, pay the out-of-pocket price after rewards (e.g.
  "$2.00 (was $14.98)"). Bundles come from the free coupon blogs and
  deal forums below (Walgreens, CVS, Target); Facebook reels can't be
  watched automatically (no API, login wall, video), but the same stacks
  appear in text on those sites. Digital coupons and rewards vary by
  account — clip them in the store app first and confirm before you
  shop. Stacks never appear on the Deals tab. **v14 controls:** sort
  (Most verified / Most recent / Biggest deals — biggest = largest
  dollar saving, was − price), store and department dropdowns built
  from the stacks only, and a Future checkbox with the same rules as
  the Deals tab. The badge counts the stacks matching the active
  filters.
- **Department hide (v14):** every row in the department dropdown
  (Deals and Bundles) carries an ✕. Tap it and that department's deals
  leave both feed tabs; the ✕ stays highlighted and the name stays in
  the dropdown, so it can be tapped again to bring the department
  back. The preference persists on the phone (`pa:hiddenDepts`) across
  reloads and app updates. The watchlist is never hidden — only the
  feed lists.
- **Stale-briefing banner (v14):** the "This briefing is N days old"
  banner has an ✕ to dismiss it. The dismissal is remembered for that
  briefing's date, so it stays gone across reloads and updates — but a
  newer briefing shows the banner again.
- **Instructions — every card (v13)**: an "Instructions" button on
  every deal card (Deals, Bundles, and watchlist) opens a panel with
  everything needed to get the deal: price / was, retailer, UPC or SKU
  with a Copy button, the list date and sources, and — where the source
  genuinely provides them — the step-by-step (clip coupon, apply code,
  expected total). Where no source gives steps, the panel shows a short
  generic checklist instead; steps are never invented. Closes with the
  X, a tap outside, Esc, or the phone Back button.
- **Watchlist** (saved on your phone): tap Watch on any deal. Each watched
  item gets an in-store checklist — scan in the store's app, find it on the
  shelf, confirm the register price. Watchlist cards carry the same
  Instructions button as deal cards.
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
  **v14 — alerts survive app updates:** the button used to go off
  after an update (v13) because the app re-checked the browser's
  subscription on load and one null result wiped the stored flag. Now
  the stored flag is the user's intent: only a deliberate tap on "turn
  off" (or a denied permission) turns alerts off. If the flag says on
  but the browser reports no subscription — and permission is already
  granted — the app re-subscribes automatically on load, no tap
  needed. If alerts ever show off after an update, tap "Enable alerts"
  once; the re-subscribe path covers the transient case from then on.
  The button is a pill now — filled when alerts are on, muted outline
  when off.
- **Install the app (v14):** a download-icon button sits top-right in
  the header. It appears only when the browser says the app is
  installable (the manifest now carries real 192px and 512px PNG
  icons, plus a 512px maskable icon — `scripts/make-icons.py`
  regenerates them from `icon.svg`) — tap it to install Penny Alerts
  on the home screen. It never shows when the app is already installed
  or when the browser offers no install prompt, so it is never a dead
  button.
- **The "Tap to copy the URL" card is Chrome's, not ours:** the
  notification card that reads "Penny Alerts — Tap to copy the URL for
  this app" (Share / Open in Chrome browser, in the Silent section) is
  Chrome's own PWA card — no code in the app writes that text, and the
  site cannot rewrite it. What changed in v14 is the real alerts:
  deal pushes now name the top new deals with prices (see below), and
  the app installs properly with real icons, so the browser offers a
  real install prompt. Do not expect the Chrome card itself to change
  wording — it is Chrome's.
- **Richer deal alerts (v14):** the background push now reads
  "Penny Alerts: 5 new deals" with the top 3 new deals listed by name,
  price and store ("Gerber Multi-Tool — $29.97 (Home Depot)"), then
  "+N more" and "Open the app to see them." One push per morning run,
  as before. The notification has a View deals button (tap it, or the
  notification itself, to open the app) and a short vibration. The
  in-app "new deals" popup names the top deals the same way, and no
  longer auto-closes after 12 seconds (20 seconds max, and the OS
  dismisses it).
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
feed (2,234 items): **1,281/2,234 (57%) have a photo**. Per source:
PennyRecon 166/166, RetailShout 38/38, Freebie Guy 109/135,
Krazy Coupon Lady 27/88, FreeStuffFinder 26/102,
PennyPinchinMom 7/105. The gaps are structural, not bugs: the DG
lists are text tables with no per-item photos and no per-item links,
so only their UPCs that a free product database knows get a photo
(Open Food Facts matched 89 of 442 UPCs on the 2026-11-22 sweep, Open
Products Facts 4 more). The remaining 261 DG items show the
placeholder tile.

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
  **v14 — Slickdeals title cleanup:** deal titles often lead with a
  price + "FS" and end with the store name ("$29.97, FS, Gerber
  Suspension NXT 15-N-1 Multi-Tool with Pocket Clip, HomeDepot") —
  the store search now strips the leading price + FS marker and a
  trailing retailer name first, so the Home Depot app searches the
  clean product name ("Gerber Suspension NXT 15 N 1 Multi Tool with
  Pocket Clip") instead of "29 97 FS Gerber ... HomeDepot". The
  Google fallback keeps the raw name.
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
shows "✓ N sources" under its picture. **Future (v13 fix):** the checkbox
next to "Show expired" shows only deals whose list date is after today
— currently PennyPinchinMom's Nov 24 list. Before v13 it only narrowed
when checked and let future-dated deals through when unchecked; now it
is symmetric with "Show expired": Future OFF hides any deal dated after
today, Future ON shows only those. Undated deals (no list date) are
never future and show by default.

**Bundles tab (v13):** shows only coupon stacks (`is_stack`), newest
first, undated last; its badge counts the visible stacks. The Deals tab
excludes stacks entirely. **v14:** the Bundles tab has its own sort
(Most verified by default, Most recent, Biggest deals), store and
department dropdowns built from the stacks only, and a Future checkbox
with the Deals-tab semantics.

**Department hide (v14):** the department dropdown is a button + panel
(a native `<select>` cannot carry a per-row button). Each row has an ✕
that hides that department from both feed tabs until tapped again; the
name stays in the dropdown and the ✕ stays highlighted while hidden.
The preference lives in localStorage (`pa:hiddenDepts`, no version in
the key) and survives reloads and app updates. The watchlist is never
hidden.

The app subscribes this phone with the Web Push API (VAPID public key in
`app.js` — public, safe to commit) and stores the subscription in
Supabase (`push_subscriptions` table, shared "bulk finder" project).
`scripts/send-push.py` runs in the same daily workflow right after the
parser: it diffs the new feed against the committed one and, when there
are new items, sends ONE summary push per subscribed phone — v14: the
title is the count ("Penny Alerts: 5 new deals") and the body names the
top 3 new deals with prices and stores, then "+N more" and "Open the
app to see them." Subscriptions the push service rejects
(404/410) are pruned automatically. Push errors never fail the workflow.

**v14 — Blackstone price fix:** the parser used to take the *minimum*
`$` amount across a Slickdeals title + summary as the price, so the
Blackstone 28" griddle (title $150, summary mentioning a "$1 Walmart+
trial") came out as price $1.00 / was $150.00. The price is now the
*first* real `$` amount in the title — titles lead with the deal price
— and the summary is only used when the title has no price at all.
The same first-price rule now covers every source that shares the
helper (DealNews, TotallyTarget, the generic deal-blog feeds). The
exact Blackstone thread is the regression test in `test-v1.mjs`.

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
(counts from the regenerated run — 2,234 items total, 51 ok sources, 7 link-only, 0 failed):

### Penny lists (Dollar General $0.01)

| Source | What happens |
| --- | --- |
| Freebie Guy — DG penny list (master list) | Parsed — 135 items, all from previous weeks' lists (see audit below) |
| RetailShout — DG penny items | Parsed — 50 items (structured cards); 38 survive dedupe |
| Krazy Coupon Lady — DG penny list | Parsed — 105 items; 88 survive dedupe |
| PennyPinchinMom — DG penny list | Parsed — 113 items (table), all dated Nov 24, 2026 |
| FreeStuffFinder — DG penny list | Parsed — 266 items; 103 survive dedupe |
| Saving With Dana — DG penny list | Parsed — sitemap discovery, newest week first; the current week's page is sometimes an empty shell until the list is posted (Nov 22: the 2026-11-22 page had no table), so the run falls back to the previous week's sitemap page rather than guessing a date |
| Crazy4Couponing — DG penny list | Parsed — 209 items, dated sections (current Nov 24 section is categories-only; UPCs live in archived sections) |
| GlitchNDealz — DG penny list | Parsed — 39 items in dated tables (Nov 17 / Nov 3 / Oct 27 / Oct 20) |
| Penny Puss — DG penny list | Link-only — the homepage yields no current list link (only a 2023 index) and the Oct 27 list page carries only 6 UPCs in static HTML, not the 27 claimed — the rest are not in the page text |

### Home Depot / Lowe's penny lists

| Source | What happens |
| --- | --- |
| PennyRecon — Home Depot penny items | Parsed — 166 of 304 live on site (name + HD SKU + retail; no UPC is exposed in the list HTML; only items with detail pages are parseable) |
| Aminahstore — Home Depot penny list | Parsed — 16 items with HD SKUs (mixed formats: 12-digit internet SKUs like 1009-074-829 and 6-digit legacy SKUs like 215-583, stored as `sku`, never as UPC). The scout report claimed 47 SKUs; only 16 are on the live page |
| ClearanceFinds — Lowe's penny list | Parsed — 121 items keyed by Lowe's item number (2–7 digits, stored as `sku`, never as UPC — no UPCs exist on the page; observed prices 1¢–6¢) |
| Krazy Coupon Lady — Home Depot penny items | Link-only — the page loads but the list is not in the static HTML (JS-rendered) |

### Coupon stacks / bundles (Bundles tab)

| Source | What happens |
| --- | --- |
| Krazy Coupon Lady — Walgreens / CVS / Target deals | Parsed — 11 deal cards each (title + final price + was price + coupon/reward lines as steps) |
| Krazy Coupon Lady — Michaels / Kohl's / JCPenney deals | Parsed — 11 / 14 / 14 deal cards, same structure |
| Freebie Guy — Walgreens deals | Parsed — 18 article cards, titles carry final price |
| Freebie Guy — Target deals | Parsed — 18 article cards (some titles are "$X.xx" placeholders — those get no price) |
| Freebie Guy — CVS deals | Link-only — only 1 CVS-titled deal on the page, not a real CVS list |
| RetailShout — Walgreens weekly ad | Parsed — 70 sale items (ad prices, not pennies; list Nov 22–28) |
| RetailShout — CVS weekly ad | Link-only — this week's page is a gift guide, not a priced deal list |
| Living Rich With Coupons — RSS | Parsed — 20 items (weekly Walgreens/CVS posts; the homepage itself is not the source) |
| Southern Savers — Walgreens ad page | Parsed — 22 stack deals (discovered from the homepage, never a guessed date slug; "makes it" math + Register Rewards lines) |
| Southern Savers — RSS | Parsed — 19 items |
| TotallyTarget — RSS | Parsed — 6 items (weekly ad previews + clearance finds) |
| Hip2Save — feed | Parsed — 51 items (store from category tags) |
| Hip2Save — WordPress API | Parsed — 5 items each for walgreens, cvs, target, dollar-general, hobby-lobby, home-depot (search matches are filtered by slug/title — `Michaels` also matches "Michael Kors") |
| Passionate Penny Pincher — feed | Parsed — 51 items (article pages are 403 BigScoots verification — link-only, never fetched) |
| Fabulessly Frugal — deals feed | Parsed — 56 items |

### Deal forums / aggregators (Deals tab)

| Source | What happens |
| --- | --- |
| Slickdeals — frontpage RSS | Parsed — 25 online deals (expire within hours) |
| Slickdeals — search RSS (target, dollar-general, home-depot, clearance, walgreens, cvs, walgreens+free, hobby-lobby) | Parsed — 25 each, newest first; `dollar general` is downstream-filtered to titles/summaries containing the phrase "dollar general" (the raw search's first hit is a "1 Million Dollar" sweepstakes); hobby-lobby is freshness-filtered to ≤7 days (0 fresh this run); walgreens+free routes to Bundles, the rest to Deals |
| DealNews — today's edition RSS | Parsed — 50 items (price from titles/summaries; the feed carries no `<dealnews:price>` element despite the scout report) |
| DealNews — editors' choice RSS | Parsed — 40 items (fetched on a fresh client: DealNews stalls this feed on a client that already fetched today's edition — reproduced Nov 23, 2026; a retry alone did not fix it) |
| GlitchNDealz — RSS | Parsed — 42 items (store + exact price in titles) |
| Brad's Deals — homepage | Parsed — 24 deal tiles (no RSS exists; search page useless) |
| weeklyadhunters — DG weekly ad | Parsed — 272 items (273 listed; the Dixie/Vanity Fair row is skipped — its price is garbled, $2.95 name vs $9.95 price — and the curated Dixie deal below covers it) |
| Kart.deals — JCPenney | Parsed — 25 items (first 30 of 540 live; prices from the static card HTML, JSON-LD carries name+url only) |
| Weekly Bargains — Hobby Lobby flyer | Parsed — 8 items (Nov 18–30, 75% fall decor; e.g. White Layered Wood Pumpkin $1.62, was $6.49) |
| Katalozi365 — Hobby Lobby leaflet | Link-only — leaflet is image-based; page text gives only the category discounts (75% fall decor, 50% tableware), no per-item prices |
| Milled — Hobby Lobby email (75% fall decor) | Link-only — the parser couldn't fetch the page (connection reset twice, 2026-11-22); open it manually |
| SavingK — Walmart hidden clearance | Link-only — the page is a guide, no parseable deal database exists |

### Gaps — no source verified for these (do not invent one)

- **No CVS or Walgreens $0.01 penny list exists** anywhere verified — the drugstore "pennies" are stack math, not penny lists.
- **No standing Target DPCI list page** — the Slickdeals `target` search RSS is the catch-net.
- **No parseable Rite Aid weekly-deal blog verified.**
- **No Walmart aggregated penny/UPC list** — Walmart has no trackable penny program.
- Ceiling unchanged: these are deal posts, not live price checks — the register scan is still the truth.

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

### Hobby Lobby fall clearance (v13) — predicted vs verified

A Facebook reel (Nov 21, 2026) claimed Hobby Lobby fall clearance goes
to 90% off on Monday, November 23, "everything included". That 90% is a
**creator prediction, disputed, not a fact**: Hobby Lobby's own weekly
ad / email (Nov 15–21) has Fall Decor, Floral & Crafts at 75% off and
Fall Tableware & Party at 50% off; a Nov 22 update from another creator
citing a Hobby Lobby email says Nov 23 stays at 75% / 50%; employees in
comments say 90% typically lands on Black Friday, not Nov 23. One other
creator claims a manager source for 90% on Nov 23. The app therefore
carries **no hand-written event item** — Hobby Lobby coverage comes only
from general sources that find items on their own: the Weekly Bargains
Black Friday flyer (Nov 18–30, 75% fall decor — 8 priced items, e.g.
White Layered Wood Pumpkin $1.62, was $6.49) and the Slickdeals
"hobby lobby" search (fresh threads only, ≤7 days — none yet). Rule:
**a predicted discount is never shown as a price**; an item may only
carry a percentage its own source actually states.

The Penny Hunter briefing JSON (30+ sources incl. the KCL DG penny list,
Freebie Guy, Slickdeals, Flipp weekly ads) is still read as a fallback —
it is the only thing the app fetches automatically besides the weekly
feed. Weekly DG penny lists are also linked out below, as before:

### The Dixie deal (v13) — one curated item, not a hand-written list

Joseph shared a reel (Stacey Workman, Nov 22, 2026): 4 Dixie
plates/bowls for $8.50 before tax at Dollar General, Nov 22–28, 2026.
The weeklyadhunters DG ad page lists "Dixie or Vanity Fair Products -
$2.95" and "Ultra Plates", but its price row is garbled (name says
$2.95, listed price shows $9.95) and it does not carry the 2-for-$5 /
2-for-$7 structure or the digital coupons — those come from the reel.
So the feed carries exactly one Dixie item, from the weeklyadhunters
source, with the reel's mechanics as its steps: 2 regular Dixie
(32-count, floral) 2-for-$5 + 2 Dixie Ultra (20-count plates / 26-count
bowls, blue swirl) 2-for-$7, clip the $0.50 manufacturer digital and the
$3.00 DG store coupon (spend $12 on Dixie or Vanity Fair), $12.00 −
$3.50 = $8.50 before tax. The garbled $2.95/$9.95 row is never used as
a price, and the weeklyadhunters Dixie/Vanity Fair rows are skipped by
the parser so they cannot duplicate it. The coupons are DG-app digitals
(account-specific) — clip first, confirm before shopping.

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
(service-worker cache `penny-alerts-v14`), `icon.svg`,
`icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `README.md`,
`scripts/parse-lists.py` + `scripts/send-push.py` +
`scripts/make-icons.py` (regenerates the PNG icons from `icon.svg`) +
`scripts/test-parse-images.py` +
`scripts/requirements.txt` (the weekly-feed parser and the push sender),
`feed/weekly.json` (generated daily by the parser; committed when it
changes), `supabase/migrations/20261122153000_push_subscriptions.sql`
(run by Joseph in the Supabase dashboard SQL editor). Plain HTML/CSS/JS,
no build step, no backend. The scheduled job is
`.github/workflows/update-feed.yml` — added on github.com, not pushed
from here.
