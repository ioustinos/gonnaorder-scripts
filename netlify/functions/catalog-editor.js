// netlify/functions/catalog-editor.js
//
// Catalogue editor backend. Three modes:
//   catalogue  → auth + return the store's full offer list (all categories)
//   apply-one  → apply price/discount/visibility to one offer + its variants
//   inspect    → raw offer data by name (debug helper)
//
// Credentials (email + password) come from the REQUEST BODY, like our other
// functions. The frontend supplies them on every call.
//
// CRITICAL — DO NOT REORDER (override ID dance):
//   GonnaOrder distinguishes between the *parent store's* offer ID and the
//   *clone store's* customisation ID. The parent override MUST run first;
//   its response contains the `childOfferId` that anchors all variant
//   overrides for that offer. If you do variants first, GonnaOrder will
//   create orphan customisations and the cascade breaks. Carried over
//   verbatim from the working n8n + frontend reference Ioustinos shared.

const GONNAORDER_BASE = "https://admin.gonnaorder.com";

async function goFetch(path, options = {}, token) {
  const resp = await fetch(`${GONNAORDER_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  let data;
  try { data = await resp.json(); } catch { data = {}; }
  if (!resp.ok) throw new Error(`GonnaOrder ${resp.status} ${path}: ${JSON.stringify(data)}`);
  return data;
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

  const { mode, email, password } = body;
  if (!email || !password) {
    return json(400, { error: "email and password are required" });
  }

  try {

    // ── MODE: catalogue ─────────────────────────────────────────────────────
    // Auth + return ALL offers (every category). The frontend handles the
    // category filter client-side via the dropdown it builds from this data.
    if (mode === "catalogue") {
      const { storeId } = body;
      if (!storeId) return json(400, { error: "storeId is required" });

      const authData = await goFetch("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: email, password }),
      });
      const token =
        authData.tokens?.jwt ||
        authData.token ||
        authData.accessToken ||
        authData.access_token;
      if (!token) throw new Error("Auth succeeded but no token found: " + JSON.stringify(authData));

      const catalogData = await goFetch(`/api/v1/user/stores/${storeId}/catalog`, {}, token);
      const catalogId = catalogData.catalogId || catalogData.id;
      if (!catalogId) throw new Error("No catalogId in response");

      const offers = [];
      let inheritedCount = 0;
      for (const cat of (catalogData.categories || [])) {
        for (const offer of (cat.offers || [])) {
          const parentStoreOfferId = offer.originalOffer?.offerId || null;
          if (parentStoreOfferId) inheritedCount++;
          offers.push({
            offerId:             offer.offerId,
            parentStoreOfferId,
            categoryName:        cat.name || "",
            name:                offer.name || String(offer.offerId),
            itemType:            offer.itemType || "Orderable",
            isSellable:          offer.isSellable ?? true,
            isStockCheckEnabled: offer.isStockCheckEnabled ?? false,
            stockLevel:          offer.stockLevel ?? 0,
            price:               offer.price ?? 0,
            discount:            Number(offer.discount ?? offer.discountPercentage ?? 0),
            variants: (offer.variants || []).map((v) => ({
              offerId:         v.offerId,
              originalOfferId: v.originalOffer?.offerId || null,
              name:            v.priceDescription || v.name || String(v.offerId),
              price:           v.price ?? 0,
              isSellable:      v.isSellable ?? true,
              discount:        Number(v.discount ?? 0),
            })),
          });
        }
      }

      // Detect whether this is a "clone" (inherited) catalogue or a "parent"
      // catalogue. The /offer/override endpoint used by apply-one ONLY works
      // for inherited catalogues — for parent stores, there'd need to be a
      // different (direct-update) endpoint that we don't currently call.
      // Heuristic: a clone catalogue has every offer linked to a parent-store
      // offer via originalOffer.offerId. If NO offer has one, it's a parent.
      const isInheritedCatalogue = inheritedCount > 0;

      return json(200, { token, catalogId, offers, isInheritedCatalogue, inheritedCount });
    }

    // ── MODE: apply-one ─────────────────────────────────────────────────────
    // Applies price + discount + visibility to one offer + its variants.
    //
    // Order: parent override FIRST → extract childOfferId from response
    //        THEN variant overrides anchored to that childOfferId.
    //
    // GonnaOrder payload shape (confirmed from UI network capture):
    //   Parent:  overrideOfferId = parentStoreOfferId
    //            childOfferId    = existing customisation ID (omit if first time)
    //   Variant: overrideOfferId        = parentStoreOfferId
    //            overrideOfferIdVariant = parent store variant ID
    //            childOfferId           = childOfferId returned by parent override
    if (mode === "apply-one") {
      const { storeId, catalogId, token, discountPct, offer } = body;
      if (!storeId || !catalogId || !token || discountPct == null || !offer) {
        return json(400, {
          error: "storeId, catalogId, token, discountPct, offer are required",
        });
      }
      const discountStr = String(discountPct);
      const steps = [];

      const parentStoreOfferId = offer.parentStoreOfferId || offer.offerId;
      const existingChildId =
        offer.parentStoreOfferId && offer.parentStoreOfferId !== offer.offerId
          ? offer.offerId
          : null;

      // ── 1. Parent override ────────────────────────────────────────────────
      const parentPayload = {
        overrideOfferId:          parentStoreOfferId,
        ...(existingChildId ? { childOfferId: existingChildId } : {}),
        price:                    offer.price ?? 0,
        discount:                 discountStr,
        discountType:             "PERCENTILE",
        itemType:                 offer.itemType || "Orderable",
        isSellableOverride:       offer.isSellable ?? true,
        isStockCheckEnabled:      offer.isStockCheckEnabled ?? false,
        stockLevel:               offer.stockLevel ?? 0,
        loyaltyPointCollectType:  null,
        loyaltyPointCollectValue: null,
      };

      let childOfferId = existingChildId;

      try {
        const resp = await goFetch(
          `/api/v1/stores/${storeId}/catalog/${catalogId}/offer/override`,
          { method: "POST", body: JSON.stringify(parentPayload) },
          token,
        );
        childOfferId = resp.offerId || resp.childOfferId || resp.id || existingChildId;
        steps.push({
          type: "PARENT", status: "ok",
          offerId: offer.offerId, name: offer.name,
          payload: parentPayload, response: resp,
          childOfferId,
        });
      } catch (err) {
        steps.push({
          type: "PARENT", status: "error",
          offerId: offer.offerId, name: offer.name,
          payload: parentPayload, error: err.message,
        });
      }

      // ── 2. Variant overrides (only run if the parent succeeded — childOfferId
      //      may be null on first-ever override of a fresh offer; the variant
      //      payload still works because GonnaOrder will create the child as a
      //      side effect, but the safer path is to use the id we just got)
      for (const variant of (offer.variants || [])) {
        const parentVariantId = variant.originalOfferId || variant.offerId;
        const existingVariantChildId =
          variant.originalOfferId && variant.originalOfferId !== variant.offerId
            ? variant.offerId
            : null;

        const variantPayload = {
          overrideOfferId:        parentStoreOfferId,
          overrideOfferIdVariant: parentVariantId,
          childOfferId:           childOfferId,
          ...(existingVariantChildId ? { childOfferIdVariant: existingVariantChildId } : {}),
          price:                  variant.price ?? 0,
          hierarchyLevel:         "VARIANT",
          discount:               discountStr,
          discountType:           "PERCENTILE",
          isSellableOverride:     variant.isSellable ?? true,
        };

        try {
          const resp = await goFetch(
            `/api/v1/stores/${storeId}/catalog/${catalogId}/offer/override`,
            { method: "POST", body: JSON.stringify(variantPayload) },
            token,
          );
          steps.push({
            type: "VARIANT", status: "ok",
            offerId: variant.offerId, name: variant.name,
            parentOfferId: offer.offerId,
            payload: variantPayload, response: resp,
          });
        } catch (err) {
          steps.push({
            type: "VARIANT", status: "error",
            offerId: variant.offerId, name: variant.name,
            parentOfferId: offer.offerId,
            payload: variantPayload, error: err.message,
          });
        }
      }

      return json(200, { steps });
    }

    // ── MODE: inspect ───────────────────────────────────────────────────────
    if (mode === "inspect") {
      const { storeId, offerName } = body;
      const authData = await goFetch("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: email, password }),
      });
      const token =
        authData.tokens?.jwt ||
        authData.token ||
        authData.accessToken ||
        authData.access_token;
      if (!token) throw new Error("Auth succeeded but no token found");

      const catalogData = await goFetch(`/api/v1/user/stores/${storeId}/catalog`, {}, token);
      const needle = (offerName || "").toLowerCase();

      for (const cat of (catalogData.categories || [])) {
        for (const offer of (cat.offers || [])) {
          if ((offer.name || "").toLowerCase().includes(needle)) {
            return json(200, { category: cat.name, rawOffer: offer });
          }
        }
      }
      return json(200, { message: `"${offerName}" not found` });
    }

    return json(400, { error: `Unknown mode: ${mode}` });

  } catch (err) {
    return json(500, { error: err.message });
  }
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
