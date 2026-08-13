// netlify/functions/schedule-assign.js
//
// Flexible Schedule Creator backend. Two modes:
//   load       → auth + return the store's schedules AND its catalogue offers
//                (with externalProductId + current scheduleId per offer)
//   apply-one  → assign one offer to one schedule via the DIRECT (parent-store)
//                offer-save endpoint
//
// API knowledge (captured live 2026-08-03 from the admin UI on store 6423):
//
//   • Schedules list: GET /api/v1/stores/{storeId}/schedules
//     Date-based schedules have availabilities of type "DATE_INCLUSIVE" with
//     a `date: "YYYY-MM-DD"` field (+ startTime/endTime). Day-of-week
//     schedules use type "DAYS_OF_WEEK" and have no `date` — this tool
//     ignores those for date matching.
//
//   • Offer read (v2!): GET /api/v2/user/stores/{storeId}/catalog/{catalogId}/offer/{offerId}
//     Returns the full offer incl. scheduleId, isSellable, attributeDtos.
//
//   • Offer save (v2!): POST /api/v2/stores/{storeId}/catalog/{catalogId}/offer/{offerId}
//     Body is the FULL offer payload (the admin UI always sends everything).
//     Returns 201 with the updated offer. Notable GET→POST field renames:
//     isSellable → sellable. Fields the GET doesn't return but the UI sends:
//     loyaltyPointCollectType/Value: null, giftCardTemplateId: "",
//     productId: null, countAgainstSlots (mirrors the COUNT_AGAINST_SLOT
//     attribute, string). CAUTION: if an offer ever has a linked product /
//     loyalty config / gift-card template, these defaults could reset it —
//     the captured UI save sent exactly these values on a normal dish.
//
//   • This endpoint is the DIRECT offer update — the opposite of
//     catalog-editor.js's /offer/override which only works on CLONE stores.
//     Verified on parent store 6423. Clone stores get a warning client-side.

const DEFAULT_API_BASE = "https://admin.gonnaorder.com";

function normalizeApiBase(b) {
  if (!b || typeof b !== "string") return DEFAULT_API_BASE;
  return b.trim().replace(/\/+$/, "").replace(/\/api\/v\d+$/, "");
}

async function goFetch(apiBase, path, options = {}, token) {
  const resp = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  let data;
  try { data = await resp.json(); } catch { data = {}; }
  if (!resp.ok) {
    // GonnaOrder error envelope: { status, errors: [{ message, code }], ... }
    const msg = data?.errors?.[0]?.message || JSON.stringify(data);
    const err = new Error(`GonnaOrder ${resp.status} ${path}: ${msg}`);
    err.goCode = data?.errors?.[0]?.code || null;
    err.status = resp.status;
    throw err;
  }
  return data;
}

async function login(apiBase, email, password) {
  const authData = await goFetch(apiBase, "/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: email, password }),
  });
  const token =
    authData.tokens?.jwt ||
    authData.token ||
    authData.accessToken ||
    authData.access_token;
  if (!token) throw new Error("Auth succeeded but no token found");
  return token;
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

  const { mode } = body;
  const apiBase = normalizeApiBase(body.apiBase);

  try {

    // ── MODE: load ──────────────────────────────────────────────────────────
    // Auth + schedules + catalogue in one call. The frontend does the
    // date-set matching client-side.
    if (mode === "load") {
      const { email, password, storeId } = body;
      if (!email || !password) return json(400, { error: "email and password are required" });
      if (!storeId) return json(400, { error: "storeId is required" });

      const token = await login(apiBase, email, password);

      const [schedulesRaw, catalogData] = await Promise.all([
        goFetch(apiBase, `/api/v1/stores/${storeId}/schedules`, {}, token),
        goFetch(apiBase, `/api/v1/user/stores/${storeId}/catalog`, {}, token),
      ]);

      // Classify schedules. A schedule is date-matchable only if ALL of its
      // availabilities are DATE_INCLUSIVE (mixed or DAYS_OF_WEEK schedules
      // can't be equated to a set of dates).
      const schedules = (Array.isArray(schedulesRaw) ? schedulesRaw : []).map((s) => {
        const avails = s.availabilities || [];
        const dateAvails = avails.filter((a) => a.type === "DATE_INCLUSIVE" && a.date);
        const isDateSchedule = avails.length > 0 && dateAvails.length === avails.length;
        return {
          id: s.id,
          name: s.name || String(s.id),
          isDateSchedule,
          // sorted unique dates, "YYYY-MM-DD"
          dates: [...new Set(dateAvails.map((a) => a.date))].sort(),
          availabilityCount: avails.length,
        };
      });

      const catalogId = catalogData.catalogId || catalogData.id;
      if (!catalogId) throw new Error("No catalogId in catalog response");

      const offers = [];
      for (const cat of (catalogData.categories || [])) {
        for (const offer of (cat.offers || [])) {
          offers.push({
            offerId:           offer.offerId,
            categoryName:      cat.name || "",
            name:              offer.name || String(offer.offerId),
            externalProductId: offer.externalProductId != null ? String(offer.externalProductId).trim() : "",
            scheduleId:        offer.scheduleId ?? null,
            isSellable:        offer.isSellable ?? false,
            hierarchyLevel:    offer.hierarchyLevel || "PARENT",
            variantCount:      (offer.variants || []).length,
          });
        }
      }

      return json(200, {
        token,
        catalogId,
        parentStoreId: catalogData.parentStoreId ?? null,
        schedules,
        offers,
      });
    }

    // ── MODE: apply-one ─────────────────────────────────────────────────────
    // Read the offer via v2 GET, echo the full payload back via v2 POST with
    // the new scheduleId. Full-payload echo is deliberate: the admin UI
    // always sends the complete object, and partial bodies are a known
    // GonnaOrder trap (silently ignored on PATCH /stores/{id}).
    if (mode === "apply-one") {
      const { storeId, catalogId, offerId, scheduleId, email, password, makeVisible } = body;
      let { token } = body;
      if (!token || !storeId || !catalogId || !offerId || scheduleId == null) {
        return json(400, { error: "token, storeId, catalogId, offerId, scheduleId are required" });
      }

      // GonnaOrder JWTs expire after ~10 minutes. Reviewing the preview
      // usually takes longer than that, so a 401 here is NORMAL, not an
      // error: re-login with the credentials (sent along by the frontend)
      // and retry once. The fresh token is returned so the client can use
      // it for the remaining rows.
      let refreshedToken = null;
      let g;
      try {
        g = await goFetch(
          apiBase,
          `/api/v2/user/stores/${storeId}/catalog/${catalogId}/offer/${offerId}`,
          {},
          token,
        );
      } catch (err) {
        if (err.status === 401 && email && password) {
          token = refreshedToken = await login(apiBase, email, password);
          g = await goFetch(
            apiBase,
            `/api/v2/user/stores/${storeId}/catalog/${catalogId}/offer/${offerId}`,
            {},
            token,
          );
        } else {
          throw err;
        }
      }

      // ── Build the payload by PASS-THROUGH, never by a hand-written list ──
      // 2026-08-11 incident: the payload used to be a fixed list of fields
      // copied from one captured admin-UI save. That capture was of a dish
      // with no `priceDescription`, so the field was missing from the list,
      // and every save silently CLEARED it on 31 dishes. A hand-written list
      // can only ever be correct for the exact object it was copied from.
      //
      // Now: start from everything the GET returned, drop only the keys the
      // POST is known to reject (server-derived / read-only), apply the known
      // GET→POST renames, and add the UI-only constants. Any field GonnaOrder
      // adds in future rides along automatically instead of being wiped.
      const NON_WRITABLE = new Set([
        "offerId", "position", "catalogPosition", "standardImage", "contentItemId",
        "variants", "isOrderable", "isDirectlyOrderable", "isExpandable", "isActive",
        "isSellable", "isClonedOffer", "formattedPrice", "formattedDiscountedPrice",
        "consumption", "originalOffer", "parentId",
      ]);
      const attrs = g.attributeDtos || [];
      const countAgainstSlots =
        attrs.find((a) => a.key === "COUNT_AGAINST_SLOT")?.value ?? "0";

      const payload = {};
      for (const [k, v] of Object.entries(g)) {
        if (!NON_WRITABLE.has(k)) payload[k] = v;   // ← carries priceDescription and anything new
      }
      // known GET→POST rename + UI-only fields the admin app always sends
      payload.sellable = makeVisible ? true : (g.isSellable ?? false);
      payload.countAgainstSlots = String(countAgainstSlots);
      payload.loyaltyPointCollectType = g.loyaltyPointCollectType ?? null;
      payload.loyaltyPointCollectValue = g.loyaltyPointCollectValue ?? null;
      payload.giftCardTemplateId = g.giftCardTemplateId ?? "";
      payload.productId = g.productId ?? null;
      payload.hierarchyLevel = g.hierarchyLevel || "PARENT";
      payload.attributeDtos = attrs;
      // the ONLY value this tool intends to change:
      payload.scheduleId = scheduleId;

      await goFetch(
        apiBase,
        `/api/v2/stores/${storeId}/catalog/${catalogId}/offer/${offerId}`,
        { method: "POST", body: JSON.stringify(payload) },
        token,
      );

      // ── Post-write audit: re-read and diff against the pre-write state ────
      // Trusting the POST response is not enough. Re-GET and compare every
      // field; anything that changed other than what we deliberately changed
      // is reported as a FAILURE so the caller can stop the batch.
      const after = await goFetch(
        apiBase,
        `/api/v2/user/stores/${storeId}/catalog/${catalogId}/offer/${offerId}`,
        {},
        token,
      );

      const INTENDED = new Set(["scheduleId", ...(makeVisible ? ["isSellable"] : [])]);
      const norm = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
      const collateral = [];
      for (const k of new Set([...Object.keys(g), ...Object.keys(after)])) {
        if (INTENDED.has(k)) continue;
        if (norm(g[k]) !== norm(after[k])) {
          collateral.push({ field: k, before: g[k] ?? null, after: after[k] ?? null });
        }
      }

      const applied = after.scheduleId === scheduleId;
      const visOk = !makeVisible || after.isSellable === true;
      const ok = applied && visOk && collateral.length === 0;

      return json(200, {
        ok,
        offerId,
        previousScheduleId: g.scheduleId ?? null,
        appliedScheduleId: after.scheduleId ?? null,
        isSellable: after.isSellable,
        ...(refreshedToken ? { token: refreshedToken } : {}),
        ...(collateral.length ? { collateralDamage: collateral } : {}),
        ...(ok ? {} : {
          warning: collateral.length
            ? `Save altered ${collateral.length} field(s) it should not have: ${collateral.map(c => c.field).join(", ")}`
            : "Save did not apply the requested schedule/visibility",
        }),
      });
    }

    return json(400, { error: `Unknown mode: ${mode}` });

  } catch (err) {
    return json(500, { error: err.message, goCode: err.goCode || null });
  }
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
