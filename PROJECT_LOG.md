# Project Log — GonnaOrder Scripts

## 2026-05-28 — Project bootstrap

- Repo: `git@github.com:ioustinos/gonnaorder-scripts.git`
- Stack: static HTML + vanilla JS in `public/`, Netlify Functions in `netlify/functions/`. No Supabase, no React, no localhost — these are one-page utilities, not products.
- Linear project "GonnaOrder Scripts" created in the GonnaOrder (GO) team.
- Netlify site `gonnaorder-scripts` created in the Wecook (ioustinos-sarris) team.

## 2026-05-28 — Voucher importer shipped

First script: bulk voucher importer.

- Frontend (`public/index.html`) loads SheetJS from CDN, parses CSV or XLSX client-side, validates per-row before submit. Drag-and-drop or click-to-choose.
- Backend (`netlify/functions/create-vouchers.js`) authenticates once per batch, creates vouchers sequentially. Cap: 100 rows per function call; larger CSV imports are chunked client-side. Returns per-row results. (Initially 500, dropped to 300 in c5f4c98 to fit Netlify's 10s function budget, then dropped again to 100 in 2026-06-04 after a 1683-row import burned 5 of 6 chunks — GonnaOrder voucher-create latency is 50–120ms per call, not the optimistic ~30ms originally estimated.)
- Sample file `public/sample-vouchers.csv` with all columns + 3 example rows.
- CSV columns mirror the GonnaOrder voucher form fields: `code, discount, discountType, type, orderMinAmount, startDate, endDate, isActive, externalId`. Only `code` and `discount` are required; everything else has sensible defaults matching the original n8n flow.

### API gotchas discovered during build

- `discountType` is **`PERCENTILE`** in the API even though the UI shows "Percentage". Both `PERCENTAGE` and `%` are accepted in the CSV and normalized.
- `scheduleId` is the **string** `"null"`, not actual null. Carried over verbatim from the n8n flow because it's what works.

### Catalogue Editor shipped (second script)

Ioustinos uploaded three files (a prompt + a Netlify function + a React component) and went to sleep. Built the catalogue editor as the second live script in the repo.

- Function ported as-is to `netlify/functions/catalog-editor.js` (CommonJS → ESM, matched our other functions' style; removed CORS headers since same-origin). Three modes: `catalogue` (auth + return all offers), `apply-one` (parent override + cascade to variants), `inspect` (debug). API logic kept 100% identical to the uploaded reference.
- Frontend ported from the React + Tailwind component to vanilla JS at `public/catalogue/index.html`, matching the existing dark theme. Every feature preserved: email/password/storeId auth, Load Catalogue, client-side category filter (built from the loaded data), per-row price/discount/visibility editing, expandable variants with inherited discount, bulk discount/show/hide on selected rows, Apply Log with collapsible payload/response per step, failed-offer-IDs collector, dirty-row highlighting.
- New live card on the home page, sitting next to the Voucher Importer. CLAUDE.md got a new "Catalogue API notes" section documenting the override-ID cascade (parent first, then variants anchored to the returned `childOfferId`) — that's the non-obvious bit that breaks silently if you reorder.
- Edits in the table use input-level state updates that don't trigger full re-renders, so typing in a price/discount input doesn't blow away focus. Visibility toggles still trigger an immediate apply + re-render.

### Home page + folder-per-script layout

Restructured so `/` is now a card-grid hub and the voucher importer moved to `/vouchers/`. Each future script gets its own `public/<slug>/index.html`. The home page is plain static HTML — adding a script swaps one "Coming soon" placeholder card for a live link. Backlog scripts (cleanup, categories, products, store-config-copy) are seeded as `soon` cards so the user can see what's planned. Fixed a stale footer line on the importer that still mentioned "creds in Netlify env vars" — they live in the form now.

### Credentials handling (revised, pre-deploy)

Initial design stored `GONNAORDER_USERNAME` and `GONNAORDER_PASSWORD` as Netlify env vars sourced from the n8n flow — Ioustinos pointed out this hardcodes the tool to his account. Switched to per-request credentials in the body: user types email + password in the UI, function uses them once, discards them. Browser remembers only the email in `localStorage`.

Env vars deleted from Netlify. Tool is now usable by anyone with a GonnaOrder account.

### Duplicate detection + GonnaOrder error envelope properly parsed

Real-world 1683-row import surfaced two related issues on 2026-06-05:

1. **My error parser was wrong.** GonnaOrder returns errors as `{ errors: [{ message, code }], ... }`, but `create-vouchers.js` was checking `parsed.detail || parsed.message || parsed.error` — none of which exist on their responses, so the user saw raw HTTP-400 JSON instead of friendly text.
2. **Chunk timeouts had been silently lying.** The previous 1683-row run reported "1500 failed". Re-importing showed all 1683 returning `CUSTOMER_VOUCHER_ALREADY_PRESENT` — the chunks had actually succeeded server-side but Netlify's 10s function timeout cut the response short.

Fixes:
- `create-vouchers.js`: extract `errors[0].message` and `errors[0].code` properly; thrown Error now carries `errorCode` + `httpStatus` properties.
- `vouchers/index.html`: new `duplicate` status (yellow `c4b5fd` badge) for `CUSTOMER_VOUCHER_ALREADY_PRESENT`, distinct from red `failed`. Summary counters split into `Total / Created / Duplicates / Failed`.
- CLAUDE.md: documents the error envelope shape, the known error codes worth special-casing, and the chunk-timeout lying behaviour.

The chunk-timeout-lying issue is now documented (so future-Claude knows to expect this) but not "fixed" structurally — a real fix would require either splitting the function into a stateful queue or pre-fetching existing codes via list-vouchers and skipping client-side. Both are bigger work. For now, the duplicate counter makes the recovery obvious: re-import and the 'duplicate' column tells you what was actually created server-side.

### Post-deploy fix: wrong enum strings (WELCOME5 row)

First live test (store 5770) imported 2/3 sample rows. The third — `WELCOME5`, the only non-percentile non-multi-use row — returned `400 "Failed to read request"`.

**False start:** I guessed `discountType` was `"FIXED"` and patched the function to set `initialValue = discount` for FIXED. Both wrong.

**Real cause (from a working API payload Ioustinos pasted):** two enum strings I'd guessed are wrong:
- `discountType`: API uses `MONETARY` (not `FIXED`) for monetary vouchers. UI label is "Monetary" so it actually matches — I'd over-thought it.
- `type`: API uses `ONE_TIME_USE` (not `SINGLE_USE`). UI label is "Single Use" but the API enum is the longer phrase.

`initialValue` is `null` for both PERCENTILE and MONETARY in the working payload — no need to compute it from discount. Reverted that change.

Fix: corrected both enums in `netlify/functions/create-vouchers.js`, in the row normalizer + validation in `public/index.html`, and in `public/sample-vouchers.csv`. The frontend still accepts the older aliases (`FIXED`, `SINGLE_USE`, `%`, etc.) and normalizes them so CSVs that used my wrong values still work.

Lesson logged in CLAUDE.md: a generic `400 "Failed to read request"` from voucher create almost always means an unknown enum string — the deserializer doesn't give field-level errors.
