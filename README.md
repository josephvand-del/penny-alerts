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
- **Alerts**: tap "Enable alerts" and the app notifies you about new deals
  when you open it, plus an in-app "NEW" badge. v1 alerts are honestly
  labelled: **checked when you open the app.**

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
- It does not send background push notifications while closed. A static
  GitHub Pages site has no server to push from.

## Honest caveat — the briefing can go stale

The briefing file is published by Penny Hunter's project. If it hasn't been
republished recently, the app says so at the top ("This briefing is N days
old") and expired weekly-ad items are hidden by default. The weekly feed
above is the fresh source — it is rebuilt every morning from the lists,
so it stays current even when the briefing is old. If a list source fails
one morning, the job records the failure in the feed and keeps the
previous good items; the Lists & Sources tab shows each source's status.

## Planned next

- True background push: push subscription stored in Supabase + a small
  scheduled sender that fetches the feed daily and pushes new deals.
  Needs a server piece — designed, not built.
- Optional King Soopers auto price-check via Kroger's free public API
  (needs a free Kroger developer account).

## Files

`index.html`, `app.js`, `styles.css`, `manifest.json`, `sw.js`
(service-worker cache `penny-alerts-v2`), `icon.svg`, `README.md`,
`scripts/parse-lists.py` + `scripts/requirements.txt` (the weekly-feed
parser), `feed/weekly.json` (generated daily by the parser; committed
when it changes). Plain HTML/CSS/JS, no build step, no backend. The
scheduled job is `.github/workflows/update-feed.yml` — added on
github.com, not pushed from here.
