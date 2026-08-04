// netlify/functions/list-vouchers.js
//
// GETs existing customer vouchers from a GonnaOrder store.
//
// Two modes:
// 1. Default (Inspect button): first N vouchers, raw.
//    Body: { username, password, storeId, size?, apiBase? }
//    Returns: { count, vouchers: [...] }
// 2. mode: "code-map" (upsert support in the importer): pages through ALL
//    vouchers and returns just { codeToId: { CODE: id, ... }, total }.
//    Pagination metadata confirmed live 2026-08-04: the list response is
//    { totalPages, totalElements, pageNumber, pageSize, data: [...] }.
//    (`size=-1` is NOT honored — the server fell back to pageSize 20 — so
//    we page explicitly with size=100.)

const DEFAULT_API_BASE = "https://admin.gonnaorder.com";

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
  const size = Math.min(Number(body.size) || 20, 100);
  if (!username || !password) return json(400, { error: "username and password are required" });
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

  if (body.mode === "code-map") {
    // Page through everything and return a code → id map for upserts.
    // 100ms/page × size 100 ⇒ ~1s per 1000 vouchers; MAX_PAGES caps us
    // safely inside Netlify's 10s budget even on huge stores.
    const MAX_PAGES = 60;
    const codeToId = {};
    let total = 0;
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(
        `${goApi}/stores/${encodeURIComponent(storeId)}/customer-voucher?size=100&page=${page}`,
        { method: "GET", headers: { authorization: `Bearer ${jwt}` } }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return json(res.status, { error: `voucher list HTTP ${res.status}: ${text.slice(0, 200)}` });
      }
      const data = await res.json().catch(() => ({}));
      const vouchers = Array.isArray(data?.data) ? data.data : [];
      for (const v of vouchers) {
        if (v && v.code != null && v.id != null) codeToId[String(v.code)] = v.id;
      }
      total = Number(data?.totalElements) || Object.keys(codeToId).length;
      const totalPages = Number(data?.totalPages) || 1;
      if (page >= totalPages - 1 || vouchers.length === 0) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }
    return json(200, { codeToId, total, truncated });
  }

  const url = `${goApi}/stores/${encodeURIComponent(storeId)}/customer-voucher?size=${size}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.detail || parsed.message || parsed.error || detail;
    } catch {}
    return json(res.status, { error: `HTTP ${res.status}: ${detail}` });
  }

  const data = await res.json().catch(() => ({}));
  // Paginated response shape: { data: [...], pagination: {...} } (matches the n8n flow's expectation)
  const vouchers = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return json(200, { count: vouchers.length, vouchers });
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
