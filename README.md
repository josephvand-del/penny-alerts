# Penny Alerts — Aurora, CO 80017

Free penny-deal and clearance alerts for the stores around Aurora, CO 80017.
Live at https://josephvand-del.github.io/penny-alerts/ — install it from your
phone's home screen (it's a PWA).

## What it does

- **Deal feed** from Penny Hunter's public daily briefing
  (`https://rocketshon.github.io/penny-finder-backend/briefings/latest.json`),
  filterable by store, department, and "pennies only". Each deal shows its
  name, price / was-price, source, and a Watch button.
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

- Penny Hunter briefing JSON (30+ sources incl. the KCL DG penny list,
  Freebie Guy, Slickdeals, Flipp weekly ads) — the only thing the app
  fetches automatically.
- Weekly DG penny lists: [Freebie Guy master list](https://THEFREEBIEGUY.COM/DOLLAR-GENERAL-PENNY-SHOPPING-MASTER-LIST/)
  and [RetailShout](https://retailshout.com/latest-dollar-general-penny-items-near-you/) — linked out, not fetched (they block cross-site reads).
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
old") and expired weekly-ad items are hidden by default. The linked weekly
lists above are the current source when the briefing is old.

## Planned for v2

- True background push: push subscription stored in Supabase + a small
  scheduled sender that fetches the briefing daily and pushes new deals.
  Needs a server piece — designed, not built.
- Parsing the weekly DG lists into the feed automatically (needs a server
  or scheduled job; a plain web page can't fetch those pages).
- Optional King Soopers auto price-check via Kroger's free public API
  (needs a free Kroger developer account).

## Files

`index.html`, `app.js`, `styles.css`, `manifest.json`, `sw.js`
(service-worker cache `penny-alerts-v1`), `icon.svg`, `README.md`.
Plain HTML/CSS/JS, no build step, no backend.
