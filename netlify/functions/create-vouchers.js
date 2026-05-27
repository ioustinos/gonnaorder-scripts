// netlify/functions/create-vouchers.js
//
// Bulk-creates customer vouchers in a GonnaOrder store.
// Body: { username, password, storeId: number, rows: VoucherRow[] }
// Returns: { results: [{ code, ok, error?, voucherId? }] }
//
// Auth: the caller passes their GonnaOrder credentials in the request body.
// We log in once to get a JWT, reuse it for every voucher in the batch, then
// discard it. Credentials are never logged or persisted server-side.

const GO_API = "https://admin.gonnaorder.com/api/v1";

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
  if (rows.length > 500) {
    return json(400, { error: "Maximum 500 rows per batch" });
  }

  // 1. Authenticate
  let jwt;
  try {
    jwt = await authenticate(username, password);
  } catch (e) {
    return json(502, { error: `GonnaOrder auth failed: ${e.message}` });
  }

  // 2. Create vouchers sequentially. Sequential keeps things simple and avoids
  //    overwhelming the GonnaOrder API; for 500 rows this still fits well
  //    inside the 10s function budget assuming ~50ms/request.
  const results = [];
  for (const row of rows) {
    try {
      const voucher = await createVoucher(jwt, storeId, row);
      results.push({ code: row.code, ok: true, voucherId: voucher?.id ?? null });
    } catch (e) {
      results.push({ code: row.code, ok: false, error: e.message });
    }
  }

  return json(200, { results });
};

async function authenticate(username, password) {
  const res = await fetch(`${GO_API}/auth/login`, {
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

async function createVoucher(jwt, storeId, row) {
  const now = new Date();
  const sixMonthsLater = new Date(now);
  sixMonthsLater.setMonth(sixMonthsLater.getMonth() + 6);

  const discountType = row.discountType || "PERCENTILE";
  const discount = Number(row.discount);

  const payload = {
    code: String(row.code),
    startDate: row.startDate ? toIso(row.startDate) : now.toISOString(),
    endDate: row.endDate ? toIso(row.endDate) : sixMonthsLater.toISOString(),
    discount,
    orderMinAmount: Number(row.orderMinAmount) || 0,
    // For FIXED-amount vouchers, the API expects the monetary worth of the voucher
    // in initialValue. For PERCENTILE vouchers it stays null. (Discovered the hard
    // way — the n8n flow only ever did PERCENTILE, so it always sent null.)
    initialValue: discountType === "FIXED" ? discount : null,
    type: row.type || "MULTI_USE",
    discountType,
    isActive: row.isActive === false ? false : true,
    categoryIds: null,
    scheduleId: "null",
    externalId: row.externalId || null,
    durationInMonths: null,
  };

  const res = await fetch(`${GO_API}/stores/${encodeURIComponent(storeId)}/customer-voucher`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Try to pull a friendlier message out of the GonnaOrder error envelope.
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.detail || parsed.message || parsed.error || detail;
    } catch {}
    throw new Error(`HTTP ${res.status}: ${detail}`);
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
