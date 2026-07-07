// netlify/functions/vouchers-export.js
//
// Pulls EVERY customer voucher from a GonnaOrder store and returns them raw,
// so the page can flatten them to CSV. This is the "export all" companion to
// list-vouchers.js (which only ever grabs the first N for inspection).
//
// Body: { username, password, storeId, apiBase? }
// Returns: { vouchers: [...], total, pages, truncated, paginationSupported }
//
// Endpoint (from Ioustinos's live n8n "Gonna Order Vouchers Update" flow):
//   GET /api/v1/stores/{storeId}/customer-voucher?size=100   (Bearer JWT)
//   → { data: [ { id, code, discount, discountType, type,
//                 startDate, endDate, isActive, initialValue, ... } ] }
//
// PAGINATION CAVEAT: the n8n flow only ever fetched a single page with
// `size=100` — it never sent `page`, so paging on this endpoint is UNPROVEN.
// We probe it: fetch page 0, and only advance to page 1+ while a full page
// comes back. We dedupe by `id` and, if a later page returns only ids we've
// already seen (i.e. the server ignored `page` and re-served page 0), we
// stop and report `paginationSupported: false` so the client can warn that
// stores with >PAGE_SIZE vouchers may be truncated. Credentials are used
// once to mint a JWT, then discarded. Never logged.

const DEFAULT_API_BASE = "https://admin.gonnaorder.com";

const PAGE_SIZE = 100; // matches the known-good size from the n8n flow
const MAX_PAGES = 50;  // 5000 vouchers safety cap; raise if a store exceeds it

function normalizeApiBase(b) {
  if (!b || typeof b !== "string") return DEFAULT_API_BASE;
  return b.trim().replace(/\/+$/, "").replace(/\/api\/v\d+$/, "");
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { username, password, storeId } = body;
  if (!username || !password) {
    return json(400, { error: "username and password are required" });
  }
  if (!storeId || !Number.isInteger(Number(storeId))) {
    return json(400, { error: "storeId must be an integer" });
  }

  const goApi = `${normalizeApiBase(body.apiBase)}/api/v1`;

  let jwt;
  try {
    jwt = await authenticate(goApi, username, password);
  } catch (e) {
    return json(502, { error: `GonnaOrder auth failed: ${e.message}` });
  }

  const base = `${goApi}/stores/${encodeURIComponent(storeId)}/customer-voucher`;
  const byId = new Map(); // id -> voucher (dedupe across pages)
  const seenNoId = [];    // fallback bucket for vouchers with no `id`
  let page = 0;
  let pages = 0;
  let truncated = false;
  let paginationSupported = true;

  try {
    for (; page < MAX_PAGES; page++) {
      const url = `${base}?size=${PAGE_SIZE}&page=${page}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let detail = text.slice(0, 300);
        try {
          const parsed = JSON.parse(text);
          detail =
            parsed?.errors?.[0]?.message ||
            parsed.detail || parsed.message || parsed.error || detail;
        } catch {}
        // Page 0 failing is a hard error; a later page failing just caps us.
        if (page === 0) return json(res.status, { error: `HTTP ${res.status}: ${detail}` });
        truncated = true;
        break;
      }

      const data = await res.json().catch(() => ({}));
      const batch = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data) ? data : [];
      pages = page + 1;

      if (!batch.length) break; // clean end

      // Count how many of this page are genuinely new (by id).
      let newThisPage = 0;
      for (const v of batch) {
        const id = v && (v.id ?? v.voucherId);
        if (id === undefined || id === null) {
          seenNoId.push(v);
          newThisPage++;
        } else if (!byId.has(id)) {
          byId.set(id, v);
          newThisPage++;
        }
      }

      // If a page beyond the first added nothing new, the server ignored
      // `page` and re-served an earlier page. Stop and flag.
      if (page > 0 && newThisPage === 0) {
        paginationSupported = false;
        break;
      }

      // Short page ⇒ last page. Done.
      if (batch.length < PAGE_SIZE) break;

      // A full page on page 0 that we're about to follow: if the very next
      // page turns out identical we'll catch it above. Keep going.
    }
    if (page >= MAX_PAGES) truncated = true;
  } catch (e) {
    return json(502, { error: `Voucher fetch failed: ${e.message}` });
  }

  const vouchers = [...byId.values(), ...seenNoId];

  // If we only ever fetched one full page and never confirmed paging works,
  // and the store returned a full page, warn the client it might be truncated.
  if (pages === 1 && vouchers.length >= PAGE_SIZE) {
    truncated = true;
    paginationSupported = false;
  }

  return json(200, {
    vouchers,
    total: vouchers.length,
    pages,
    truncated,
    paginationSupported,
  });
};

async function authenticate(goApi, username, password) {
  const res = await fetch(`${goApi}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const jwt = data?.tokens?.jwt;
  if (!jwt) throw new Error("No JWT in login response");
  return jwt;
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
