// netlify/functions/create-vouchers.js
//
// Bulk-creates customer vouchers in a GonnaOrder store.
// Body: { username, password, storeId: number, rows: VoucherRow[], apiBase? }
// Returns: { results: [{ code, ok, error?, voucherId? }] }
//
// Auth: the caller passes their GonnaOrder credentials in the request body.
// We log in once to get a JWT, reuse it for every voucher in the batch, then
// discard it. Credentials are never logged or persisted server-side.
//
// apiBase defaults to https://admin.gonnaorder.com — the caller can override
// it from the UI for staging / other deployments. We strip any trailing
// slash and any accidental /api/v1 suffix.

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

  const { username, password, storeId, rows } = body;
  if (!username || !password) {
    return json(400, { error: "username and password are required" });
  }
  if (!storeId || !Number.isInteger(Number(storeId))) {
    return json(400, { error: "storeId must be an integer" });
  }
  if (!Array.isArray(rows) || !rows.length) {
    return json(400, { error: "rows must be a non-empty array" });
  }
  if (rows.length > 100) {
    return json(400, { error: "Maximum 100 rows per batch — the UI chunks larger imports automatically" });
  }

  const apiBase = normalizeApiBase(body.apiBase);
  const goApi = `${apiBase}/api/v1`;

  // 1. Authenticate
  let jwt;
  try {
    jwt = await authenticate(goApi, username, password);
  } catch (e) {
    return json(502, { error: `GonnaOrder auth failed: ${e.message}` });
  }

  // 2. Create vouchers sequentially. Sequential keeps things simple and
  //    avoids overwhelming the GonnaOrder API. Real-world GonnaOrder voucher-
  //    create latency runs 50–120ms (often >100ms) and Netlify caps functions
  //    at 10s, so 300 was too aggressive — observed 5/6 chunks timing out on
  //    an 1683-row import 2026-06-04. Capping at 100 gives ~3–5x headroom.
  //    Larger imports are chunked client-side by `public/vouchers/index.html`.
  const results = [];
  for (const row of rows) {
    try {
      const voucher = await createVoucher(goApi, jwt, storeId, row);
      results.push({ code: row.code, ok: true, voucherId: voucher?.id ?? null });
    } catch (e) {
      results.push({
        code: row.code,
        ok: false,
        error: e.message,
        errorCode: e.errorCode || null,
        httpStatus: e.httpStatus || null,
      });
    }
  }

  return json(200, { results });
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

async function createVoucher(goApi, jwt, storeId, row) {
  const now = new Date();
  const sixMonthsLater = new Date(now);
  sixMonthsLater.setMonth(sixMonthsLater.getMonth() + 6);

  // GonnaOrder API enums (the UI labels and the API enum strings don't match):
  //   UI "Percentage"  → API "PERCENTILE"
  //   UI "Monetary"    → API "MONETARY"
  //   UI "Multi Use"   → API "MULTI_USE"
  //   UI "Single Use"  → API "ONE_TIME_USE"
  // Verified from a real working POST payload Ioustinos shared 2026-05-28.

  const payload = {
    code: String(row.code),
    startDate: row.startDate ? toIso(row.startDate) : now.toISOString(),
    endDate: row.endDate ? toIso(row.endDate) : sixMonthsLater.toISOString(),
    discount: Number(row.discount),
    orderMinAmount: Number(row.orderMinAmount) || 0,
    initialValue: null,  // null for both PERCENTILE and MONETARY — confirmed from working payload
    type: row.type || "MULTI_USE",
    discountType: row.discountType || "PERCENTILE",
    isActive: row.isActive === false ? false : true,
    categoryIds: null,
    scheduleId: "null",
    externalId: row.externalId || null,
    durationInMonths: null,
  };

  const res = await fetch(`${goApi}/stores/${encodeURIComponent(storeId)}/customer-voucher`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // GonnaOrder's error envelope:
    //   { status, time, path, method, errors: [{ message, code }], tenant }
    // Pull the first error's message + code; fall back through other common
    // shapes; last resort is the raw text.
    let detail = text.slice(0, 300);
    let errorCode = null;
    try {
      const parsed = JSON.parse(text);
      const first = parsed?.errors?.[0];
      errorCode = first?.code || null;
      detail = first?.message
            || first?.code
            || parsed.detail
            || parsed.message
            || parsed.error
            || detail;
    } catch {}
    const err = new Error(`HTTP ${res.status}: ${detail}`);
    err.errorCode = errorCode;
    err.httpStatus = res.status;
    throw err;
  }
  // Some endpoints return 204; others return the created object.
  if (res.status === 204) return {};
  return res.json().catch(() => ({}));
}

// Accept "YYYY-MM-DD" or full ISO; always return full ISO.
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
