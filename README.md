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
  sample-vouchers.csv    ← shared starter file (kept at root so it's /sample-vouchers.csv)
netlify/
  functions/
    create-vouchers.js   ← POST: auths with GonnaOrder, loops over rows
    list-vouchers.js     ← POST: GETs existing vouchers (used by the Inspect button)
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
- Per-batch cap: 500 rows.

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
