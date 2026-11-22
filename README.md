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
  appears in both feeds, the weekly copy wins (it is fresher).
- **Watchlist** (saved on your phone): tap Watch on any deal. Each watched
  item gets an in-store checklist — scan in the store's app, find it on the
  shelf, confirm the register price.
- **Mark-off / ignore list**: "Don't show again" hides an item everywhere,
  with a way to un-mark it.
- **Stores**: the verified local store list — 6 Walmart Supercenters,
  5 Targets, Dollar General (nearest Aurora location is permanently closed;
  nearest active are Commerce City and Denver), and 5 Home Depots — with
  addresses, phones, and per-store notes.
- **One-tap check links**: each item links to the retailer's BrickSeek
  inventory checker (Walmart / Dollar General / Target / Home Depot).
  These open in a new tab — **you** do the check manually.
- **Alerts**: tap "Enable alerts" and this phone subscribes for true
  background push — new deals push to it even when the app is closed.
  Until the one-time setup below is done, alerts are honestly labelled:
  **checked when you open the app.** Tap the button again to turn
  alerts off (the sender then prunes the dead subscription).
- **Deal photos**: every home-page card shows a thumbnail of the item
  (lazy-loaded). Items with no photo anywhere get a clean placeholder
  tile with the department initial — never a fabricated image. See
  "Deal photos — where they come from" below.

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
   Slickdeals frontpage RSS carries no thumbnails.
2. **Previous-feed cache** — if a UPC already had a photo in the last
   feed, it is reused and never looked up again.
3. **Open Food Facts** (free, no key) — food/grocery UPCs only, looked
   up at ~1/sec, capped at 150 UPCs per run (env
   `OFF_LOOKUPS_PER_RUN`); candidates rotate daily so every UPC gets
   a turn over successive runs.
4. **UPCitemdb** — only if a paid key is set (see below).

Coverage is partial by design — measured on the 2026-11-22 run
(683 items): **280/683 (40%) have a photo**. Per source:
PennyRecon 166/166, RetailShout 50/50, FreeStuffFinder 35/180,
Krazy Coupon Lady 17/105, Freebie Guy 11/52, PennyPinchinMom 1/105,
Slickdeals 0/25. The gaps are structural, not bugs: Slickdeals
carries no thumbnails and no UPCs; the DG lists carry no per-item
photos, so only their food UPCs get one (Open Food Facts is
food-only — 64 of 442 UPCs matched); PennyPinchinMom's list is
almost entirely non-food UPCs Open Food Facts doesn't know. The
remaining 403 items show the placeholder tile.

One honest note: PennyRecon's product photos live on Home Depot's
image CDN (`images.thdstatic.com`) — that is the URL PennyRecon
itself embeds on its own list pages, and the parser records exactly
that URL. The app never fetches or scrapes any retailer site: it makes
no `fetch()`/XHR call to any retailer domain, and the `<img>` tags
only load URLs already recorded in the feed. The only hosts images
come from are the list authors' own hosts (retailshout.com),
`images.thdstatic.com` (via PennyRecon), `images.openfoodfacts.org`,
and `f.wishabi.net` (Penny Hunter's briefing images).

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

## Background push — how it works + one-time setup

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

Verified live 2026-11-22 (counts from the first run — 683 items total):

| Source | What happens |
| --- | --- |
| Freebie Guy — DG penny list (master list) | Parsed — 135 items |
| RetailShout — DG penny items | Parsed — 50 items (structured cards) |
| Krazy Coupon Lady — DG penny list | Parsed — 105 items |
| PennyPinchinMom — DG penny list | Parsed — 105 items (table) |
| FreeStuffFinder — DG penny list | Parsed — 266 items |
| Slickdeals — frontpage RSS | Parsed — 25 online deals |
| PennyRecon — Home Depot penny items | Parsed — 166 items (name + HD SKU + retail; no UPC is exposed in the list HTML) |
| Freebie Guy RSS / PennyPinchinMom RSS | Parsed — post-level signals only (0–1 items; the list pages carry the real UPCs) |
| SavingK — Walmart hidden clearance | Link-only — the page is a guide, no parseable deal database exists |
| Krazy Coupon Lady — Home Depot penny items | Link-only — the page loads but the list is not in the static HTML (JS-rendered) |
| Freebie Guy — Home Depot penny list | Link-only — the page returns 404 (removed) |

The Penny Hunter briefing JSON (30+ sources incl. the KCL DG penny list,
Freebie Guy, Slickdeals, Flipp weekly ads) is still read as a fallback —
it is the only thing the app fetches automatically besides the weekly
feed. Weekly DG penny lists are also linked out below, as before:

- Weekly DG penny lists: [Freebie Guy master list](https://THEFREEBIEGUY.COM/DOLLAR-GENERAL-PENNY-SHOPPING-MASTER-LIST/)
  and [RetailShout](https://retailshout.com/latest-dollar-general-penny-items-near-you/)
- [SavingK — Walmart hidden clearance](https://savingk.com/walmart-hidden-clearance-how-to-find-these-secret-deals/)
- [PennyRecon — Home Depot penny lists](https://www.pennyrecon.com/)

## What it does NOT do

- It never calls walmart.com, brickseek.com, or any retailer endpoint
  automatically. No scraping, no paid APIs, no Discord.
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
(service-worker cache `penny-alerts-v4`), `icon.svg`, `README.md`,
`scripts/parse-lists.py` + `scripts/send-push.py` +
`scripts/requirements.txt` (the weekly-feed parser and the push sender),
`feed/weekly.json` (generated daily by the parser; committed when it
changes), `supabase/migrations/20261122153000_push_subscriptions.sql`
(run by Joseph in the Supabase dashboard SQL editor). Plain HTML/CSS/JS,
no build step, no backend. The scheduled job is
`.github/workflows/update-feed.yml` — added on github.com, not pushed
from here.
