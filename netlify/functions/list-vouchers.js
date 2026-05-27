// netlify/functions/list-vouchers.js
//
// GETs the first N existing customer vouchers from a GonnaOrder store and
// returns the raw API response. Used by the "Inspect" button on the page to
// surface things like the real `discountType` / `type` enum strings.
//
// Body: { username, password, storeId, size? }
// Returns: { count, vouchers: [...] }  ← unaltered from the GonnaOrder response

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

  const { username, password, storeId } = body;
  const size = Math.min(Number(body.size) || 20, 100);
  if (!username || !password) return json(400, { error: "username and password are required" });
  if (!storeId || !Number.isInteger(Number(storeId))) {
    return json(400, { error: "storeId must be an integer" });
  }

  let jwt;
  try {
    jwt = await authenticate(username, password);
  } catch (e) {
    return json(502, { error: `GonnaOrder auth failed: ${e.message}` });
  }

  const url = `${GO_API}/stores/${encodeURIComponent(storeId)}/customer-voucher?size=${size}`;
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

function json(status, body) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
