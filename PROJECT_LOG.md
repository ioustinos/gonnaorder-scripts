# Project Log — GonnaOrder Scripts

## 2026-05-28 — Project bootstrap

- Repo: `git@github.com:ioustinos/gonnaorder-scripts.git`
- Stack: static HTML + vanilla JS in `public/`, Netlify Functions in `netlify/functions/`. No Supabase, no React, no localhost — these are one-page utilities, not products.
- Linear project "GonnaOrder Scripts" created in the GonnaOrder (GO) team.
- Netlify site `gonnaorder-scripts` created in the Wecook (ioustinos-sarris) team.

## 2026-05-28 — Voucher importer shipped

First script: bulk voucher importer.

- Frontend (`public/index.html`) loads SheetJS from CDN, parses CSV or XLSX client-side, validates per-row before submit. Drag-and-drop or click-to-choose.
- Backend (`netlify/functions/create-vouchers.js`) authenticates once per batch, creates vouchers sequentially. Cap: 500 rows per batch. Returns per-row results.
- Sample file `public/sample-vouchers.csv` with all columns + 3 example rows.
- CSV columns mirror the GonnaOrder voucher form fields: `code, discount, discountType, type, orderMinAmount, startDate, endDate, isActive, externalId`. Only `code` and `discount` are required; everything else has sensible defaults matching the original n8n flow.

### API gotchas discovered during build

- `discountType` is **`PERCENTILE`** in the API even though the UI shows "Percentage". Both `PERCENTAGE` and `%` are accepted in the CSV and normalized.
- `scheduleId` is the **string** `"null"`, not actual null. Carried over verbatim from the n8n flow because it's what works.

### Home page + folder-per-script layout

Restructured so `/` is now a card-grid hub and the voucher importer moved to `/vouchers/`. Each future script gets its own `public/<slug>/index.html`. The home page is plain static HTML — adding a script swaps one "Coming soon" placeholder card for a live link. Backlog scripts (cleanup, categories, products, store-config-copy) are seeded as `soon` cards so the user can see what's planned. Fixed a stale footer line on the importer that still mentioned "creds in Netlify env vars" — they live in the form now.

### Credentials handling (revised, pre-deploy)

Initial design stored `GONNAORDER_USERNAME` and `GONNAORDER_PASSWORD` as Netlify env vars sourced from the n8n flow — Ioustinos pointed out this hardcodes the tool to his account. Switched to per-request credentials in the body: user types email + password in the UI, function uses them once, discards them. Browser remembers only the email in `localStorage`.

Env vars deleted from Netlify. Tool is now usable by anyone with a GonnaOrder account.

### Post-deploy fix: wrong enum strings (WELCOME5 row)

First live test (store 5770) imported 2/3 sample rows. The third — `WELCOME5`, the only non-percentile non-multi-use row — returned `400 "Failed to read request"`.

**False start:** I guessed `discountType` was `"FIXED"` and patched the function to set `initialValue = discount` for FIXED. Both wrong.

**Real cause (from a working API payload Ioustinos pasted):** two enum strings I'd guessed are wrong:
- `discountType`: API uses `MONETARY` (not `FIXED`) for monetary vouchers. UI label is "Monetary" so it actually matches — I'd over-thought it.
- `type`: API uses `ONE_TIME_USE` (not `SINGLE_USE`). UI label is "Single Use" but the API enum is the longer phrase.

`initialValue` is `null` for both PERCENTILE and MONETARY in the working payload — no need to compute it from discount. Reverted that change.

Fix: corrected both enums in `netlify/functions/create-vouchers.js`, in the row normalizer + validation in `public/index.html`, and in `public/sample-vouchers.csv`. The frontend still accepts the older aliases (`FIXED`, `SINGLE_USE`, `%`, etc.) and normalizes them so CSVs that used my wrong values still work.

Lesson logged in CLAUDE.md: a generic `400 "Failed to read request"` from voucher create almost always means an unknown enum string — the deserializer doesn't give field-level errors.
