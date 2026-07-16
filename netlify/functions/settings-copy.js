// netlify/functions/settings-copy.js
//
// Copy store settings from one GonnaOrder store to another, in two passes:
//
//   1. mode "export"   — pull EVERYTHING copyable from a source store and
//                        return it as one JSON blob (the UI saves it to file).
//   2. mode "snapshot" — same reads against the TARGET store, so the UI can
//                        diff base vs target before applying.
//   3. mode "apply-settings"  — PUT selected settings keys to the target.
//   4. mode "apply-details"   — PATCH store details (full flat payload).
//   5. mode "apply-schedules" — POST schedules to the target, remap ids,
//                               then POST the special-schedule assignments.
//
// Auth: every mode accepts { username, password } OR { token } (a JWT from a
// previous call in this session — every response echoes `token` so the UI can
// reuse it and skip re-login). Credentials are used once and discarded.
//
// API facts (verified live on test store 6979, 2026-07-16 — see CLAUDE.md
// "Store settings API notes"):
//   GET  /api/v1/stores/{id}                     → full store incl. settings map
//   PUT  /api/v1/stores/{id}/settings            → body [{key, value}, ...]  (MERGE)
//   PATCH /api/v1/stores/{id}                    → full flat details payload only
//   GET/POST /api/v1/stores/{id}/schedules       → schedule objects
//   GET/POST /api/v1/stores/{id}/schedules/special → {type, scheduleId}
//   GET  /api/v2/stores/{id}/zones               → delivery zones (v2!)

const DEFAULT_API_BASE = "https://admin.gonnaorder.com";

const SPECIAL_TYPES = [
  "OPENING_HOURS",
  "SERVING_HOURS",
  "PICKUP_HOURS",
  "ADDRESS_DELIVERY_HOURS",
];

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

  const mode = body.mode;
  const apiRoot = normalizeApiBase(body.apiBase);
  const goApi = `${apiRoot}/api/v1`;
  const goApiV2 = `${apiRoot}/api/v2`;

  const storeId = Number(body.storeId);
  if (!Number.isInteger(storeId) || storeId <= 0) {
    return json(400, { error: "storeId must be a positive integer" });
  }

  // ── auth: reuse token if provided, else login ──────────────────────────
  let jwt = typeof body.token === "string" && body.token ? body.token : null;
  if (!jwt) {
    if (!body.username || !body.password) {
      return json(400, { error: "username and password (or token) are required" });
    }
    try {
      jwt = await authenticate(goApi, body.username, body.password);
    } catch (e) {
      return json(502, { error: `GonnaOrder auth failed: ${e.message}` });
    }
  }
  const H = { authorization: `Bearer ${jwt}` };
  const HJ = { ...H, "content-type": "application/json" };

  try {
    switch (mode) {
      // ────────────────────────────────────────────────────────────────
      case "export":
      case "snapshot": {
        const store = await goGet(`${goApi}/stores/${storeId}`, H);
        const schedules = await goGet(`${goApi}/stores/${storeId}/schedules`, H).catch(() => []);
        const specials = {};
        for (const t of SPECIAL_TYPES) {
          specials[t] = await goGet(
            `${goApi}/stores/${storeId}/schedules/special?type=${t}`, H
          ).catch(() => []);
        }
        let zones = null;
        try {
          const z = await goGet(`${goApiV2}/stores/${storeId}/zones`, H);
          zones = Array.isArray(z?.zones) ? z.zones : (Array.isArray(z) ? z : []);
        } catch {}

        return json(200, {
          token: jwt,
          exportedAt: new Date().toISOString(),
          apiBase: apiRoot,
          storeId,
          storeName: store?.name || null,
          store,
          schedules: Array.isArray(schedules) ? schedules : [],
          specialSchedules: specials,
          zones,
        });
      }

      // ────────────────────────────────────────────────────────────────
      case "apply-settings": {
        const entries = body.settings;
        if (!Array.isArray(entries) || !entries.length) {
          return json(400, { error: "settings must be a non-empty [{key,value}] array" });
        }
        for (const e of entries) {
          if (!e || typeof e.key !== "string") {
            return json(400, { error: "each settings entry needs a string key" });
          }
        }
        const res = await fetch(`${goApi}/stores/${storeId}/settings`, {
          method: "PUT",
          headers: HJ,
          body: JSON.stringify(entries.map((e) => ({ key: e.key, value: e.value }))),
        });
        if (!res.ok) {
          return json(res.status, { token: jwt, error: await errDetail(res) });
        }
        const store = await res.json().catch(() => null);
        return json(200, {
          token: jwt,
          applied: entries.length,
          settings: store?.settings || null,
        });
      }

      // ────────────────────────────────────────────────────────────────
      case "apply-details": {
        const details = body.details;
        if (!details || typeof details !== "object") {
          return json(400, { error: "details object is required" });
        }
        // The PATCH silently ignores partial bodies — the CLIENT builds the
        // full payload (target's own values for unchecked fields). We just
        // sanity-check a couple of always-required fields are present.
        for (const req of ["name", "countryId", "languageId"]) {
          if (details[req] === undefined) {
            return json(400, { error: `details.${req} missing — the PATCH needs the full flat payload (partial bodies are silently ignored by GonnaOrder)` });
          }
        }
        const res = await fetch(`${goApi}/stores/${storeId}`, {
          method: "PATCH",
          headers: HJ,
          body: JSON.stringify(details),
        });
        if (!res.ok) {
          return json(res.status, { token: jwt, error: await errDetail(res) });
        }
        const store = await res.json().catch(() => null);
        return json(200, { token: jwt, store: pickDetails(store) });
      }

      // ────────────────────────────────────────────────────────────────
      case "apply-schedules": {
        // body.schedules: [{name, availabilities:[{startTime,endTime,daysOfWeek,dates?}]}]
        //   (source ids are ignored — target gets fresh ones)
        // body.specials:  [{type, scheduleName}] — resolved to NEW ids by name
        const schedules = Array.isArray(body.schedules) ? body.schedules : [];
        const specials = Array.isArray(body.specials) ? body.specials : [];

        // Existing target schedules — reuse by name instead of duplicating.
        const existing = await goGet(`${goApi}/stores/${storeId}/schedules`, H).catch(() => []);
        const nameToId = new Map(
          (Array.isArray(existing) ? existing : []).map((s) => [s.name, s.id])
        );

        const results = [];
        for (const s of schedules) {
          if (!s || typeof s.name !== "string" || !Array.isArray(s.availabilities)) {
            results.push({ name: s?.name || "?", status: "skipped", detail: "malformed schedule" });
            continue;
          }
          if (nameToId.has(s.name)) {
            results.push({ name: s.name, status: "exists", id: nameToId.get(s.name) });
            continue;
          }
          const payload = {
            id: -1,
            name: s.name,
            availabilities: s.availabilities.map((a, i) => ({
              id: Date.now() + i, // client temp id, same trick as the admin UI
              startTime: trimSeconds(a.startTime),
              endTime: trimSeconds(a.endTime),
              daysOfWeek: a.daysOfWeek || [],
              ...(a.dates ? { dates: a.dates } : {}),
            })),
          };
          const res = await fetch(`${goApi}/stores/${storeId}/schedules`, {
            method: "POST",
            headers: HJ,
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            results.push({ name: s.name, status: "failed", detail: await errDetail(res) });
            continue;
          }
          const created = await res.json().catch(() => null);
          // Response may be the schedule or the full list — resolve the id.
          let newId = created?.id;
          if (!newId) {
            const after = await goGet(`${goApi}/stores/${storeId}/schedules`, H).catch(() => []);
            newId = (Array.isArray(after) ? after : []).find((x) => x.name === s.name)?.id;
          }
          if (newId) nameToId.set(s.name, newId);
          results.push({ name: s.name, status: newId ? "created" : "created (id unresolved)", id: newId || null });
        }

        const specialResults = [];
        for (const sp of specials) {
          if (!sp || !SPECIAL_TYPES.includes(sp.type)) {
            specialResults.push({ type: sp?.type || "?", status: "skipped", detail: "unknown type" });
            continue;
          }
          const sid = nameToId.get(sp.scheduleName);
          if (!sid) {
            specialResults.push({ type: sp.type, status: "failed", detail: `no schedule named "${sp.scheduleName}" on target` });
            continue;
          }
          const res = await fetch(`${goApi}/stores/${storeId}/schedules/special`, {
            method: "POST",
            headers: HJ,
            body: JSON.stringify({ type: sp.type, scheduleId: sid }),
          });
          specialResults.push({
            type: sp.type,
            scheduleName: sp.scheduleName,
            status: res.ok ? "assigned" : "failed",
            ...(res.ok ? {} : { detail: await errDetail(res) }),
          });
        }

        return json(200, { token: jwt, schedules: results, specials: specialResults });
      }

      default:
        return json(400, { error: `Unknown mode: ${mode}` });
    }
  } catch (e) {
    return json(502, { token: jwt, error: e.message });
  }
};

// ── helpers ────────────────────────────────────────────────────────────────

function trimSeconds(t) {
  // API returns "11:00:00" but the create payload sends "11:00".
  if (typeof t === "string" && /^\d{2}:\d{2}:\d{2}$/.test(t)) return t.slice(0, 5);
  return t;
}

function pickDetails(store) {
  if (!store || typeof store !== "object") return null;
  const { id, name, description, aliasName, externalId, phoneNumber, timeZone, address } = store;
  return { id, name, description, aliasName, externalId, phoneNumber, timeZone, address };
}

async function goGet(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url.replace(/^https?:\/\/[^/]+/, "")} → HTTP ${res.status}: ${await errDetail(res)}`);
  return res.json();
}

async function errDetail(res) {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text);
    return (
      parsed?.errors?.[0]?.message ||
      parsed.detail || parsed.title || parsed.message || parsed.error ||
      text.slice(0, 300)
    );
  } catch {
    return text.slice(0, 300) || `HTTP ${res.status}`;
  }
}

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
