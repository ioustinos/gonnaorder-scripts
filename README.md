# GonnaOrder Scripts

Small web utilities that interact with the GonnaOrder admin API.

Each script is a single-page tool deployed on Netlify. Frontend is plain
HTML + vanilla JS — no build step. The actual API calls happen in Netlify
Functions, where credentials live as env vars.

**Live:** https://gonnaorder-scripts.netlify.app

## Currently shipping

### Home (`/`)

Card-based hub listing every script in the repo. Each script lives at its
own URL (`/vouchers/`, `/products/`, etc.) and links back to the hub via
a "← All scripts" link.

### Voucher Importer (`/vouchers/`)

Bulk-create customer vouchers in a GonnaOrder store from a CSV or Excel file.

1. Enter your GonnaOrder email + password (sent to the function only, never stored)
2. Enter the numeric store ID
3. Download the sample CSV (or upload your own)
4. Drop the file — rows are validated client-side
5. Click "Import" — per-row results show inline

### Catalogue Editor (`/catalogue/`)

Load a clone store's full catalogue and edit price, discount %, and
visibility per item (or in bulk across the selected rows).

1. Enter email + password + the clone store ID, click **Load Catalogue**
2. Filter by category (dropdown is built from the loaded catalogue, no extra API call)
3. Edit a row's price/discount inline — click **Apply** to push that one item
4. Or expand the row to edit variant prices and visibility individually
5. Select multiple rows → bulk-apply discount, or bulk show/hide
6. Every API call lands in the **Apply Log** at the bottom with collapsible payload/response

The visibility toggle applies immediately (no Apply click needed). Variant
discounts inherit the parent's. The token from Load Catalogue is reused for
every Apply in that session — if it expires, hit Load again.

CSV columns:

| column | required | default | accepts |
|---|---|---|---|
| `code` | yes | — | string |
| `discount` | yes | — | number |
| `discountType` | no | `PERCENTILE` | `PERCENTILE`, `MONETARY` (also accepts `PERCENTAGE`, `FIXED`, `%`, `€`) |
| `type` | no | `MULTI_USE` | `MULTI_USE`, `ONE_TIME_USE` (also accepts `SINGLE_USE`) |
| `orderMinAmount` | no | `0` | number |
| `startDate` | no | today | `YYYY-MM-DD` |
| `endDate` | no | today + 6 months | `YYYY-MM-DD` |
| `isActive` | no | `true` | `true`/`false`, `yes`/`no` |
| `externalId` | no | empty | string |

## Architecture

```
public/
  index.html             ← home: card grid linking to each script
  vouchers/
    index.html           ← Voucher Importer (drag/drop + per-row preview)
  catalogue/
    index.html           ← Catalogue Editor (load store, edit, apply per-row or bulk)
  sample-vouchers.csv    ← shared starter file (kept at root so it's /sample-vouchers.csv)
netlify/
  functions/
    create-vouchers.js   ← POST: auths with GonnaOrder, loops over rows
    list-vouchers.js     ← POST: GETs existing vouchers (used by the Inspect button)
    catalog-editor.js    ← POST: catalogue / apply-one / inspect modes
netlify.toml             ← publish dir + /api/* → functions rewrite
```

**Adding a new script:** create `public/<slug>/index.html`, add one or more
matching functions under `netlify/functions/`, then add a new card to the
home page in `public/index.html` (change the `class="card soon"` placeholder
to `class="card live"` with the right `href`).

## Conventions

- One Netlify site per repo.
- Credentials never in the repo — only in Netlify env vars.
- Sequential API calls inside the function (simpler, stays under the 10s budget for normal batches).
- Per-function-call cap: 300 rows. The UI chunks larger imports automatically and shows progress across batches.

## Credentials

Each user enters their GonnaOrder email + password in the UI. The function
uses them once to grab a JWT, then discards them — they're never stored
server-side and never written to logs. The browser remembers only the
email in `localStorage` for convenience.

No env vars required.

## Adding a new script

1. Create a new HTML page in `public/`
2. Create a matching function in `netlify/functions/`
3. Link to it from `public/index.html`
4. Add a Linear issue under the `GO` project

See `CLAUDE.md` for more on the patterns.
