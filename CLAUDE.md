# CLAUDE.md — GonnaOrder Scripts

## What this project is

A collection of small web utilities that interact with the GonnaOrder admin
API. Each script is a one-page tool: enter inputs, upload data, get results.

The user (Ioustinos) is the GonnaOrder admin for several stores. He uses these
scripts to do bulk operations the GonnaOrder dashboard doesn't offer one-click
solutions for (bulk voucher import, etc.).

## Stack

Deliberately minimal — these are tiny utilities, not products.

- **Frontend:** plain HTML + vanilla JS in `public/`. No React, no Vite, no
  build step. SheetJS loaded from a CDN for client-side CSV/XLSX parsing.
- **Backend:** Netlify Functions in `netlify/functions/`. Node 20 runtime
  (built-in `fetch`).
- **Hosting:** one Netlify site for the whole repo. Each script gets its own
  HTML page under `public/`.
- **Repo:** `github.com/ioustinos/gonnaorder-scripts`.
- **Tasks:** Linear project "GonnaOrder Scripts", team key `GO`.

## Why no Supabase / no React / no localhost

The user explicitly asked to skip these. These scripts:
- have no users to authenticate
- have no data to persist (results are shown and gone)
- have no UI state complex enough to need React
- can be developed by editing files and pushing — Netlify auto-deploys

If a future script ever needs accounts or persistence, revisit. For now,
keep it boring.

## Infrastructure

| Resource | Value |
|---|---|
| GitHub repo | git@github.com:ioustinos/gonnaorder-scripts.git |
| Netlify site name | `gonnaorder-scripts` |
| Netlify site ID | `62e7818c-5cfc-41e5-b85b-405faaa2ede7` |
| Netlify team | `ioustinos-sarris` (Wecook) |
| Production URL | https://gonnaorder-scripts.netlify.app |
| Linear team | GonnaOrder (key `GO`) |
| Linear project | GonnaOrder Scripts (id `9f4677fa-4da9-4cde-a68e-2c0a9e7776cb`) |
| Linear project URL | https://linear.app/wecook/project/gonnaorder-scripts-adcd4be1160d |

## Credentials

The user enters their GonnaOrder email + password in the UI on each visit.
The credentials are POSTed in the request body to the function, used once
to obtain a JWT, then discarded. They are NOT stored in Netlify env vars
and NOT logged.

The browser remembers only the email (in `localStorage`) so the user just
re-types the password each time.

Why this over env vars: the tool is now usable by anyone with a GonnaOrder
account — no redeploy needed when credentials change, and no shared
password baked into the site config.

## Env vars (Netlify, functions scope)

None — credentials flow through the request body. If we ever need other
server-side secrets (Sentry DSN, etc.), they go here.

## GonnaOrder API notes (learned the hard way)

- Base URL: `https://admin.gonnaorder.com` (default — every function accepts
  `apiBase` in the request body to override per call; the UI surfaces it as
  an "API base URL (advanced)" input on both tool pages, defaulted from
  `localStorage['gonnaorder.apiBase']` or the constant). Functions strip
  trailing slashes and any accidental `/api/v1` suffix so the field is
  forgiving.
- API path under base: `/api/v1`
- Auth: `POST /auth/login` with `{ username, password }` → returns
  `{ tokens: { jwt } }`. Send `Authorization: Bearer <jwt>` on subsequent calls.
- Create voucher: `POST /stores/{storeId}/customer-voucher` with the payload
  shown in `netlify/functions/create-vouchers.js`. Fields worth knowing:
  - `discountType: "PERCENTILE" | "MONETARY"` — the UI labels ("Percentage"
    and "Monetary") don't match the API enums. Both are subtly off:
    Percentage → **PERCENTILE** (yes, the statistical word), Monetary →
    **MONETARY** (UI label happens to match this one). Don't trust the UI
    label as a guide.
  - `type: "MULTI_USE" | "ONE_TIME_USE"` — same trap. UI says "Single Use"
    but the API enum is **ONE_TIME_USE** (not `SINGLE_USE`).
  - `scheduleId: "null"` — yes, the **string** `"null"`. That's what the n8n
    flow sends and what works.
  - Dates are full ISO strings.
  - `initialValue: null` for both PERCENTILE and MONETARY vouchers. Confirmed
    from a real working POST payload (Ioustinos pasted it 2026-05-28). My
    earlier guess that MONETARY needed `initialValue = discount` was wrong —
    don't reinstate it.
  - Generic `400 "Failed to read request"` from a voucher create almost
    always means one of the enum strings above is wrong — the API
    deserializer rejects unknown enum values with that opaque message
    instead of a field-level error.
  - Error envelope shape for validation/conflict errors:
    `{ status, time, path, method, errors: [{ message, code }], tenant }`
    — extract `errors[0].message` for human-readable text and
    `errors[0].code` for programmatic branching (NOT `detail` / `message`
    / `error` at the top level — those don't exist on GonnaOrder
    responses, my early code guessed wrong).
  - Known error codes worth handling specially:
    - `CUSTOMER_VOUCHER_ALREADY_PRESENT` — voucher with that code already
      exists in the store. Idempotent no-op; the importer surfaces this as
      a yellow `duplicate` status (NOT red `failed`) and has a separate
      counter for it.
  - **Chunk timeouts ≠ server-side failure.** When a Netlify function
    invocation times out at 10s, GonnaOrder has typically already created
    the vouchers it processed up to that point — the function just didn't
    get to return them. Marking the whole chunk as "failed" client-side is
    misleading; a re-import will surface the actual server state via
    `CUSTOMER_VOUCHER_ALREADY_PRESENT` per row. The user lived through
    this on 2026-06-04 (1683-row import: previous run's "1500 failed"
    were actually all server-side successes).

## Catalogue API notes

- Fetch full catalogue: `GET /api/v1/user/stores/{storeId}/catalog` (Bearer JWT).
  Returns `{ catalogId, categories: [{ name, offers: [...] }] }`. The frontend
  filters categories client-side — there is no per-category endpoint.
- Apply price/discount/visibility override: `POST /api/v1/stores/{storeId}/catalog/{catalogId}/offer/override`.
- **Critical: parent override first, then variants.** A "clone" store stores
  customisations against the parent store's offer IDs. The override payload
  uses `overrideOfferId` = parent-store offer ID and an optional `childOfferId`
  for the existing customisation. The parent override's response returns the
  `childOfferId` that ALL variant overrides for that offer must reference.
  If you do variants first, GonnaOrder creates orphan customisations and the
  cascade breaks. Do NOT reorder this in `catalog-editor.js`.
- Variant payload also needs `hierarchyLevel: "VARIANT"` and
  `overrideOfferIdVariant` (the parent store's variant ID). The function
  picks these up from `variant.originalOfferId`.
- Variants inherit the parent's discount — the UI shows "inherits X%" and
  the function applies the same `discount` string to each variant payload.
- The catalogue editor reuses one JWT for an entire session of "apply" calls
  (token returned by the `catalogue` mode is stored client-side and passed
  back in every `apply-one` body). If GonnaOrder rejects calls mid-session,
  reload the catalogue to get a fresh token.
- **Override endpoint only works for inherited (clone) catalogues**, not
  parent stores. The function detects this via `inheritedCount` (number of
  offers with `originalOffer.offerId` set) and returns
  `isInheritedCatalogue: boolean` in the `catalogue` response. The frontend
  shows a warning banner and disables Apply / vis-toggle / bulk buttons
  when `isInheritedCatalogue === false`. For parent stores, a different
  GonnaOrder endpoint would be needed (direct offer update) — not yet
  wired here. If we ever add it, branch on `isInheritedCatalogue` in
  `apply-one` and route to the right endpoint.

## Orders API notes

Source of truth: Ioustinos's live n8n workflow "GonnaOrder Pollfish Order
Check" (active in production). These endpoints are NOT independently
re-tested from a dev sandbox — the sandbox has no network route to
`admin.gonnaorder.com`. Verify against the live deploy.

- Search orders: `POST /api/v1/stores/{storeId}/orders/search?size=&page=&sort=wishTime,desc`
  (Bearer JWT). Body is a filter object:
  `{ wishTimeFrom, wishTimeTo, status?: string[], isReady?: boolean }`.
  - **The date window filters on `wishTime`** (requested delivery/pickup
    time) — full ISO strings — NOT order creation/submission time. It is the
    only date filter the order-search API exposes that we know of.
  - `status` is an **array** (multi-select). Valid values:
    `SUBMITTED`, `CLOSED`, `DRAFT`, `UPDATED`, `RECEIVED`. Omit the array
    (or send empty) ⇒ all statuses. `orders-export.js` filters input against
    this whitelist.
  - `isReady` — the n8n flow pins this to `false` for its own narrow purpose.
    `orders-export.js` deliberately **omits** it so a general export doesn't
    silently drop ready orders. Don't reinstate it as a hard-coded filter.
  - Response shape: `{ data: [...], ... }` — orders live under `data` (the
    n8n "Clean up array" node reads `items[0].json.data`). `orders-export.js`
    falls back to `content` / a bare array just in case.
  - Pagination: `page` is **0-indexed**; `size` is caller-chosen (n8n used 40;
    we use 100). We page until a page returns fewer than `size` (last page)
    or a `MAX_PAGES` safety cap (then `truncated: true`). We do NOT know the
    real pagination-metadata keys (total/last) — if GonnaOrder ever caps page
    size below our requested `size`, this under-fetches; re-measure before
    trusting large windows.
  - Order-level fields seen in search results: `uuid`, `customerName`,
    `paymentStatus`, `totalNonDiscountedPrice`, `totalDiscountedPrice`,
    `orderToken`, `voucherCode`, `voucherDiscount`, `wishTime`.
- Full order (incl. line items): `GET /api/v1/stores/{storeId}/orders/{uuid}`
  (Bearer JWT). Returns the order with `orderItems: [{ offer: { name, price },
  quantity, ... }]`, `comment`, etc. — a superset of the search object. The
  exporter fetches these only when "Include line items" is ticked, chunked
  client-side (≤40 uuids/call) and reusing the search JWT to avoid
  re-authenticating per chunk.

## Page layout

```
public/
  index.html             ← home: card grid linking to each script
  vouchers/
    index.html           ← Voucher Importer
  catalogue/
    index.html           ← Catalogue Editor (price / discount / visibility per item, bulk ops)
  orders/
    index.html           ← Orders Export (date-window order pull → raw-flatten CSV)
  sample-vouchers.csv    ← shared starter, kept at root so it's /sample-vouchers.csv
```

Each script lives in its own `public/<slug>/` folder so the URL is just
`/<slug>/`. The home page is a static card grid (no JS) — adding a new
script means swapping one `<div class="card soon">` placeholder for an
`<a class="card live" href="/<slug>/">`.

## How to add a new script

1. Create `public/<slug>/index.html` (copy `public/vouchers/index.html`'s
   structure — the dark theme, the "← All scripts" nav link, the panels).
2. Create one or more `netlify/functions/<slug>-*.js` files for the API calls.
3. In `public/index.html`, replace one of the "Coming soon" cards (or add a
   new card) pointing at `/<slug>/`. Bump from `class="card soon"` to
   `class="card live"` and from `<div>` to `<a href="/<slug>/">`.
4. Add a Linear issue under project "GonnaOrder Scripts" describing the script.
5. Commit + push to `main`. Netlify deploys automatically.

## Conventions

- One function = one bulk operation. Sequential calls inside. Cap batches —
  voucher importer is 100 rows per function call, chunked client-side for
  larger imports so each function invocation stays well inside Netlify's
  10s budget. (300 was tried first and burned 5/6 chunks on a real 1683-row
  import — GonnaOrder voucher-create latency is 50–120ms per call, not the
  ~30ms guess. Don't re-raise without re-measuring.)
- Validate inputs client-side AND server-side. Client side is for UX
  (show errors before submit); server side is the authoritative gate.
- Show per-row outcomes — never just "done" or "failed".
- Never log the password or full request payloads with auth headers.
- Money handled as either numbers (in display currency, with two decimals)
  or as the API expects — these scripts mirror the API, they don't model
  their own data.

## What this project does NOT do

- No user accounts, no auth on the page itself. The Netlify site is public
  but only useful to people who know GonnaOrder store IDs.
- No persistence. Each batch import is fire-and-forget — refresh and it's gone.
- No queue / retry. If a row fails, the user fixes the CSV and re-imports
  only the failed rows.
