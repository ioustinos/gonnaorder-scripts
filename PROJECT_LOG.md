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

### Credentials handling (revised, pre-deploy)

Initial design stored `GONNAORDER_USERNAME` and `GONNAORDER_PASSWORD` as Netlify env vars sourced from the n8n flow — Ioustinos pointed out this hardcodes the tool to his account. Switched to per-request credentials in the body: user types email + password in the UI, function uses them once, discards them. Browser remembers only the email in `localStorage`.

Env vars deleted from Netlify. Tool is now usable by anyone with a GonnaOrder account.

### Post-deploy fix: FIXED vouchers need `initialValue`

First live test (store 5770) imported 2/3 sample rows. The third — `WELCOME5`, the only `FIXED + SINGLE_USE` row — returned `400 "Failed to read request"`.

Cause: the n8n flow always sent `initialValue: null` because it was only ever used for PERCENTILE vouchers. The API quietly requires `initialValue` to equal the discount amount for FIXED vouchers (the voucher's monetary worth). Sending null trips a deserialization failure that surfaces as the unhelpful generic 400.

Fix: in `create-vouchers.js`, compute `initialValue` as `discount` when `discountType === "FIXED"`, otherwise `null`. Also improved error surfacing — the function now pulls the `detail`/`message` field out of the GonnaOrder error envelope so per-row errors in the UI are readable. Documented in CLAUDE.md API gotchas.
