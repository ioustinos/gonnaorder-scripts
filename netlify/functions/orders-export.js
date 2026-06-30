// netlify/functions/orders-export.js
//
// Pulls orders from a GonnaOrder store for a wishTime window and (optionally)
// fetches each order's full detail so line items are available for export.
//
// Two modes, selected by `mode` in the body (mirrors catalog-editor.js):
//
//   mode "search" (default):
//     Body: { username, password, storeId, wishTimeFrom, wishTimeTo,
//             status?: string[], apiBase? }
//     Authenticates, then pages through POST /orders/search until exhausted
//     (or a safety cap is hit) and returns every order object as-is.
//     Returns: { orders: [...], total, pages, truncated, jwt }
//     ^ jwt is handed back so the client can reuse it for "detail" calls
//       without re-authenticating per chunk.
//
//   mode "detail":
//     Body: { jwt | (username,password), storeId, uuids: string[], apiBase? }
//     GETs /orders/{uuid} for each uuid and returns the full objects (which
//     include orderItems). Chunked client-side to stay inside Netlify's 10s.
//     Returns: { details: [{ uuid, ok, order?, error? }] }
//
// Source of truth for the endpoints/shapes: Ioustinos's live n8n workflow
// "GonnaOrder Pollfish Order Check" (active in production). The date window
// filters on wishTime (requested delivery/pickup time), NOT order creation.
//
// Credentials are used once to mint a JWT, then discarded. Never logged.

const DEFAULT_API_BASE = "https://admin.gonnaorder.com";

// Valid GonnaOrder order statuses (from Ioustinos). Used to gate input.
const VALID_STATUSES = ["SUBMITTED", "CLOSED", "DRAFT", "UPDATED", "RECEIVED"];

// Paging: request this many per page. The n8n flow set size freely, so the
// API honours a caller-chosen size. Stop when a page returns fewer than this
// (last page) or when the page cap is hit (then `truncated: true`).
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // 5000 orders/window — narrow the window if you hit it.

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

  const goApi = `${normalizeApiBase(body.apiBase)}/api/v1`;
  const mode = body.mode === "detail" ? "detail" : "search";

  try {
    if (mode === "detail") return await handleDetail(goApi, body);
    return await handleSearch(goApi, body);
  } catch (e) {
    return json(e.httpStatus || 502, { error: e.message });
  }
};

// ── search ──────────────────────────────────────────────────────────────────
async function handleSearch(goApi, body) {
  const { username, password, storeId, wishTimeFrom, wishTimeTo } = body;
  if (!username || !password) {
    return json(400, { error: "username and password are required" });
  }
  if (!storeId || !Number.isInteger(Number(storeId))) {
    return json(400, { error: "storeId must be an integer" });
  }
  if (!wishTimeFrom || !wishTimeTo) {
    return json(400, { error: "wishTimeFrom and wishTimeTo are required" });
  }

  let status = Array.isArray(body.status) ? body.status : [];
  status = status.filter((s) => VALID_STATUSES.includes(s));

  const jwt = await authenticate(goApi, username, password);

  // Filter body. `isReady` is deliberately omitted: the n8n flow pins it to
  // false for its own narrow purpose, but for a general export we must not
  // constrain it or we'd silently drop ready orders.
  const filter = {
    wishTimeFrom: toIso(wishTimeFrom),
    wishTimeTo: toIso(wishTimeTo),
  };
  if (status.length) filter.status = status; // omit ⇒ all statuses

  const orders = [];
  let page = 0;
  let truncated = false;
  for (; page < MAX_PAGES; page++) {
    const url = `${goApi}/stores/${encodeURIComponent(storeId)}/orders/search`
      + `?size=${PAGE_SIZE}&page=${page}&sort=wishTime,desc`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify(filter),
    });
    if (!res.ok) throw await goError(res);
    const data = await res.json().catch(() => ({}));
    const chunk = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.content)
        ? data.content
        : Array.isArray(data)
          ? data
          : [];
    orders.push(...chunk);
    if (chunk.length < PAGE_SIZE) break; // last page
    if (page === MAX_PAGES - 1) truncated = true;
  }

  return json(200, {
    orders,
    total: orders.length,
    pages: Math.min(page + 1, MAX_PAGES),
    truncated,
    jwt, // reused by the client for detail calls; not persisted server-side
  });
}

// ── detail ──────────────────────────────────────────────────────────────────
async function handleDetail(goApi, body) {
  const { storeId, uuids } = body;
  if (!storeId || !Number.isInteger(Number(storeId))) {
    return json(400, { error: "storeId must be an integer" });
  }
  if (!Array.isArray(uuids) || !uuids.length) {
    return json(400, { error: "uuids must be a non-empty array" });
  }
  if (uuids.length > 40) {
    return json(400, { error: "Maximum 40 uuids per call — the UI chunks automatically" });
  }

  let jwt = body.jwt;
  if (!jwt) {
    if (!body.username || !body.password) {
      return json(400, { error: "Provide jwt, or username and password" });
    }
    jwt = await authenticate(goApi, body.username, body.password);
  }

  const details = [];
  for (const uuid of uuids) {
    try {
      const res = await fetch(
        `${goApi}/stores/${encodeURIComponent(storeId)}/orders/${encodeURIComponent(uuid)}`,
        { headers: { authorization: `Bearer ${jwt}` } }
      );
      if (!res.ok) throw await goError(res);
      const order = await res.json().catch(() => ({}));
      details.push({ uuid, ok: true, order });
    } catch (e) {
      details.push({ uuid, ok: false, error: e.message });
    }
  }
  return json(200, { details });
}

// ── shared ────────────────────────────────────────────────────────────────--
async function authenticate(goApi, username, password) {
  const res = await fetch(`${goApi}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`GonnaOrder auth failed: HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.httpStatus = 502;
    throw err;
  }
  const data = await res.json();
  const jwt = data?.tokens?.jwt;
  if (!jwt) {
    const err = new Error("No JWT in login response");
    err.httpStatus = 502;
    throw err;
  }
  return jwt;
}

// GonnaOrder error envelope: { errors: [{ message, code }], ... }
async function goError(res) {
  const text = await res.text().catch(() => "");
  let detail = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.errors?.[0]?.message || parsed?.errors?.[0]?.code
          || parsed.detail || parsed.message || parsed.error || detail;
  } catch {}
  const err = new Error(`HTTP ${res.status}: ${detail}`);
  err.httpStatus = res.status;
  return err;
}

// Accept "YYYY-MM-DD", "YYYY-MM-DDTHH:mm", or full ISO; return full ISO.
function toIso(d) {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return new Date(`${d}T00:00:00.000Z`).toISOString();
  return new Date(d).toISOString();
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
