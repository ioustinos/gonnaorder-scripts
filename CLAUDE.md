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

- Base URL: `https://admin.gonnaorder.com/api/v1`
- Auth: `POST /auth/login` with `{ username, password }` → returns
  `{ tokens: { jwt } }`. Send `Authorization: Bearer <jwt>` on subsequent calls.
- Create voucher: `POST /stores/{storeId}/customer-voucher` with the payload
  shown in `netlify/functions/create-vouchers.js`. Fields worth knowing:
  - `discountType: "PERCENTILE" | "FIXED"` — note **PERCENTILE**, not
    PERCENTAGE. The UI says "Percentage" but the API uses "PERCENTILE".
  - `type: "MULTI_USE" | "SINGLE_USE"`
  - `scheduleId: "null"` — yes, the **string** `"null"`. That's what the n8n
    flow sends and what works.
  - Dates are full ISO strings.

## How to add a new script

1. Create `public/<script-slug>.html` (copy index.html's structure).
2. Create `netlify/functions/<script-slug>.js`.
3. Link to it from `public/index.html` (a small home page if there are many).
4. Add a Linear issue under project "GonnaOrder Scripts" describing the script.
5. Commit + push to `main`. Netlify deploys automatically.

## Conventions

- One function = one bulk operation. Sequential calls inside. Cap batches.
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
