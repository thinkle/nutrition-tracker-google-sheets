// CloudflareStravaSync.js
//
// Strava -> Nutrition Tracker activity sync.
//
// Required Worker secrets / env:
//   API_KEY                 protects manual HTTP routes via X-API-KEY
//   STRAVA_CLIENT_ID
//   STRAVA_CLIENT_SECRET
//   NUTRITION_API_BASE      e.g. https://nutrition.tmhinkle.workers.dev
// Optional:
//   NUTRITION_API_TOKEN     appended as ?token=... for direct GAS deployments
//
// Required KV binding:
//   SECRET_STORE
//
// KV keys managed by this worker:
//   STRAVA_ACCESS_TOKEN
//   STRAVA_REFRESH_TOKEN
//   STRAVA_EXPIRES_AT
//   STRAVA_LAST_SYNC_AFTER

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_API_BASE = "https://www.strava.com/api/v3";
const LAST_SYNC_STATUS_KEY = "STRAVA_LAST_SYNC_STATUS";

function parseBoolParam(value) {
  if (value === null || value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function makeRunId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeNutritionBatches(nutrition) {
  const summary = {
    batches: Array.isArray(nutrition && nutrition.batches) ? nutrition.batches.length : 0,
    statuses: {},
    created: 0,
    updated: 0,
    matchedLegacy: 0,
    errors: 0,
    unknown: 0,
  };

  const batches = Array.isArray(nutrition && nutrition.batches) ? nutrition.batches : [];
  for (const batch of batches) {
    const items = (batch && batch.result && Array.isArray(batch.result.results)) ? batch.result.results : [];
    for (const item of items) {
      const status = String(item && item.status ? item.status : "unknown");
      summary.statuses[status] = (summary.statuses[status] || 0) + 1;
      if (status === "created") summary.created += 1;
      else if (status === "updated") summary.updated += 1;
      else if (status === "matched_legacy") summary.matchedLegacy += 1;
      else if (status === "error") summary.errors += 1;
      else summary.unknown += 1;
    }
  }

  return summary;
}

async function writeLastSyncStatus(env, status) {
  try {
    await env.SECRET_STORE.put(LAST_SYNC_STATUS_KEY, JSON.stringify(status));
  } catch (err) {
    console.log(`[syncStatus] Failed to persist status: ${err.message}`);
  }
}

async function getLastSyncStatus(env) {
  const raw = await env.SECRET_STORE.get(LAST_SYNC_STATUS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return { ok: false, error: "Invalid JSON in last sync status", raw: raw.slice(0, 500) };
  }
}

async function getSyncHealth(env) {
  const now = Math.floor(Date.now() / 1000);
  const [
    lastStatus,
    lastAfter,
    expiresAtRaw,
    accessToken,
    refreshToken,
  ] = await Promise.all([
    getLastSyncStatus(env),
    env.SECRET_STORE.get("STRAVA_LAST_SYNC_AFTER"),
    env.SECRET_STORE.get("STRAVA_EXPIRES_AT"),
    env.SECRET_STORE.get("STRAVA_ACCESS_TOKEN"),
    env.SECRET_STORE.get("STRAVA_REFRESH_TOKEN"),
  ]);

  const expiresAt = Number(expiresAtRaw || 0);
  return {
    now,
    cursor: {
      stravaLastSyncAfter: Number(lastAfter || 0),
    },
    token: {
      hasAccessToken: !!accessToken,
      hasRefreshToken: !!refreshToken,
      expiresAt,
      expiresInSec: expiresAt ? (expiresAt - now) : null,
      expired: expiresAt ? expiresAt <= now : null,
    },
    lastStatus,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireApiKey(request, env) {
  if (request.headers.get("X-API-KEY") !== env.API_KEY) {
    return new Response("Unauthorized", { status: 403 });
  }
  return null;
}

function redirectUri(request) {
  const url = new URL(request.url);
  url.pathname = "/auth/callback";
  url.search = "";
  return url.toString();
}

async function saveTokenSet(env, tokenData) {
  if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.expires_at) {
    throw new Error(`Malformed Strava token response: ${JSON.stringify(tokenData)}`);
  }
  await env.SECRET_STORE.put("STRAVA_ACCESS_TOKEN", tokenData.access_token);
  await env.SECRET_STORE.put("STRAVA_REFRESH_TOKEN", tokenData.refresh_token);
  await env.SECRET_STORE.put("STRAVA_EXPIRES_AT", String(tokenData.expires_at));
}

async function exchangeCode(request, env, code) {
  const body = new URLSearchParams();
  body.set("client_id", env.STRAVA_CLIENT_ID);
  body.set("client_secret", env.STRAVA_CLIENT_SECRET);
  body.set("code", code);
  body.set("grant_type", "authorization_code");

  const resp = await fetch(STRAVA_TOKEN_URL, { method: "POST", body });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Strava token exchange failed ${resp.status}: ${JSON.stringify(data)}`);
  await saveTokenSet(env, data);
  return data;
}

async function refreshAccessToken(env) {
  const refreshToken = await env.SECRET_STORE.get("STRAVA_REFRESH_TOKEN");
  if (!refreshToken) throw new Error("Missing STRAVA_REFRESH_TOKEN. Visit /auth/start first.");

  const body = new URLSearchParams();
  body.set("client_id", env.STRAVA_CLIENT_ID);
  body.set("client_secret", env.STRAVA_CLIENT_SECRET);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);

  const resp = await fetch(STRAVA_TOKEN_URL, { method: "POST", body });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Strava refresh failed ${resp.status}: ${JSON.stringify(data)}`);
  await saveTokenSet(env, data);
  return data.access_token;
}

async function getAccessToken(env) {
  const accessToken = await env.SECRET_STORE.get("STRAVA_ACCESS_TOKEN");
  const expiresAtRaw = await env.SECRET_STORE.get("STRAVA_EXPIRES_AT");
  const expiresAt = Number(expiresAtRaw || 0);
  const now = Math.floor(Date.now() / 1000);
  if (accessToken && expiresAt > now + 600) return accessToken;
  return refreshAccessToken(env);
}

async function stravaGet(env, path, params = {}) {
  const token = await getAccessToken(env);
  const url = new URL(`${STRAVA_API_BASE}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  if (resp.status === 429) {
    const err = new Error(`Strava rate limit exceeded on ${path}: ${JSON.stringify(data)}`);
    err.rateLimited = true;
    throw err;
  }
  if (!resp.ok) throw new Error(`Strava GET ${path} failed ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

async function fetchActivities(env, { after, before, perPage = 100, maxPages = 10 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = await stravaGet(env, "/athlete/activities", {
      after,
      before,
      page,
      per_page: perPage,
    });
    if (!Array.isArray(items) || items.length === 0) break;
    out.push(...items);
    if (items.length < perPage) break;
  }
  return out;
}

async function fetchDetailedActivities(env, summaries) {
  const out = [];
  for (const summary of summaries) {
    try {
      const detail = await stravaGet(env, `/activities/${summary.id}`, {
        include_all_efforts: false,
      });
      out.push(detail);
    } catch (err) {
      if (err.rateLimited) throw err;
      out.push({ ...summary, _detailError: err.message });
    }
  }
  return out;
}

function normalizeStravaActivity(activity, { review = "" } = {}) {
  const start = activity.start_date_local || activity.start_date || "";
  const date = start ? start.slice(0, 10) : "";
  const totalKcal = activity.calories ?? activity.kilojoules ?? "";
  const type = activity.sport_type || activity.type || "Activity";
  const description = activity.description || "";
  const out = {
    ActivityKey: `strava:${activity.id}`,
    Date: date,
    StartTime: start,
    Type: type,
    Name: activity.name || type,
    Description: [
      description,
      activity.distance ? `${Math.round(activity.distance)} meters` : "",
      activity.moving_time ? `${activity.moving_time} sec moving` : "",
    ].filter(Boolean).join("; "),
    TotalKcal: totalKcal,
    CarbGrams: extractCarbGrams(description),
    Source: "strava",
    SourceID: String(activity.id),
    StravaID: String(activity.id),
    ReviewNote: activity._detailError ? `Detail fetch failed: ${activity._detailError}` : "",
    DistanceMeters: activity.distance || "",
    DurationSec: activity.elapsed_time || activity.moving_time || "",
    RawJSON: truncateForSheet_(JSON.stringify(activity)),
    // Enforce ID-only dedupe for Strava sync inserts/updates.
    DisableLegacyMatch: true,
  };
  if (review) out.Review = review;
  return out;
}

function extractCarbGrams(description) {
  if (!description) return "";
  const match = description.match(/carbs?\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*g/i);
  return match ? Number(match[1]) : "";
}

function truncateForSheet_(value, maxLen = 45000) {
  if (!value || value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}...[truncated ${value.length - maxLen} chars]`;
}

function nutritionUrl(env, path) {
  const base = (env.NUTRITION_API_BASE || "").replace(/\/$/, "");
  if (!base) throw new Error("Missing NUTRITION_API_BASE");
  const url = new URL(`${base}/${path.replace(/^\//, "")}`);
  if (env.NUTRITION_API_TOKEN) url.searchParams.set("token", env.NUTRITION_API_TOKEN);
  return url.toString();
}

function toPositiveNumber(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, parsed);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function countItemErrors(batchResponse) {
  const results = batchResponse && Array.isArray(batchResponse.results) ? batchResponse.results : [];
  return results.filter(item => String(item && item.status || "") === "error").length;
}

async function postBatchWithRetries(env, targetUrl, useBinding, chunk, batchMeta, retryConfig) {
  const maxAttempts = retryConfig.maxAttempts;
  const baseDelayMs = retryConfig.baseDelayMs;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const req = new Request(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: chunk }),
      });
      const resp = useBinding ? await env.NUTRITION.fetch(req) : await fetch(req);
      const rawBody = await resp.text();
      console.log(`[postActivitiesToNutrition] Batch offset=${batchMeta.offset} attempt=${attempt}/${maxAttempts} status=${resp.status} body=${rawBody.slice(0, 500)}`);

      let data;
      try {
        data = JSON.parse(rawBody);
      } catch (_) {
        throw new Error(`Nutrition API returned non-JSON (status ${resp.status}): ${rawBody.slice(0, 300)}`);
      }

      if (!resp.ok) {
        throw new Error(`Nutrition activity batch failed ${resp.status}: ${JSON.stringify(data)}`);
      }

      const itemErrors = countItemErrors(data);
      if (itemErrors > 0) {
        throw new Error(`Nutrition activity batch returned ${itemErrors} item errors: ${JSON.stringify(data).slice(0, 800)}`);
      }

      return { result: data, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      console.log(`[postActivitiesToNutrition] Batch offset=${batchMeta.offset} attempt=${attempt}/${maxAttempts} failed: ${err.message}; retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }

  throw new Error(`Batch offset=${batchMeta.offset} failed after ${maxAttempts} attempts: ${lastError ? lastError.message : "unknown error"}`);
}

async function postActivitiesToNutrition(env, activities) {
  if (!activities.length) return { results: [] };
  const batchSize = toPositiveNumber(env.NUTRITION_POST_BATCH_SIZE, 10, 1);
  const retryConfig = {
    maxAttempts: toPositiveNumber(env.NUTRITION_POST_MAX_ATTEMPTS, 3, 1),
    baseDelayMs: toPositiveNumber(env.NUTRITION_POST_RETRY_BASE_MS, 750, 100),
  };
  const batches = [];
  const targetUrl = nutritionUrl(env, "/activities");
  const useBinding = !!env.NUTRITION;
  console.log(`[postActivitiesToNutrition] Posting ${activities.length} activities in batches of ${batchSize} to ${targetUrl} (binding=${useBinding}, maxAttempts=${retryConfig.maxAttempts})`);
  for (let i = 0; i < activities.length; i += batchSize) {
    const chunk = activities.slice(i, i + batchSize);
    console.log(`[postActivitiesToNutrition] Batch offset=${i} count=${chunk.length}`);
    const posted = await postBatchWithRetries(
      env,
      targetUrl,
      useBinding,
      chunk,
      { offset: i, count: chunk.length },
      retryConfig
    );
    batches.push({ offset: i, count: chunk.length, attempts: posted.attempts, result: posted.result });
  }
  return { batches };
}

async function syncStrava(env, options = {}) {
  const runId = options.runId || makeRunId();
  const source = options.source || "manual";
  const startedAt = new Date().toISOString();
  const now = Math.floor(Date.now() / 1000);
  const defaultAfter = now - 3 * 86400;
  const storedAfterRaw = await env.SECRET_STORE.get("STRAVA_LAST_SYNC_AFTER");
  const storedAfter = Number(storedAfterRaw || defaultAfter);
  const requestedAfter = options.after ?? storedAfter;
  const overlapSec = toPositiveNumber(
    options.overlapSec !== undefined ? options.overlapSec : env.STRAVA_SYNC_OVERLAP_SEC,
    24 * 3600,
    0
  );
  const overlapAfter = now - overlapSec;
  const after = overlapSec > 0 ? Math.min(requestedAfter, overlapAfter) : requestedAfter;
  console.log(`[syncStrava:${runId}] source=${source} requestedAfter=${requestedAfter} effectiveAfter=${after} overlapSec=${overlapSec} nutritionBase=${env.NUTRITION_API_BASE} hasToken=${!!env.NUTRITION_API_TOKEN} dryRun=${!!options.dryRun}`);
  const before = options.before;
  const review = options.review || "";
  const maxPages = options.maxPages || 10;
  const includeIds = !!options.includeIds;

  try {
    const summaries = await fetchActivities(env, { after, before, maxPages });
    const details = await fetchDetailedActivities(env, summaries);
    const normalized = details.map(activity => normalizeStravaActivity(activity, { review }));
    const nutrition = options.dryRun
      ? { dryRun: true, skippedPost: true, batches: [] }
      : await postActivitiesToNutrition(env, normalized);
    const nutritionSummary = summarizeNutritionBatches(nutrition);

    const cursorUpdatedTo = now - 3600;
    if (!options.dryRun) {
      await env.SECRET_STORE.put("STRAVA_LAST_SYNC_AFTER", String(cursorUpdatedTo));
    }

    const finishedAt = new Date().toISOString();
    const result = {
      runId,
      source,
      startedAt,
      finishedAt,
      requestedAfter,
      after,
      overlapSec,
      before,
      fetched: summaries.length,
      posted: normalized.length,
      dryRun: !!options.dryRun,
      cursorUpdated: !options.dryRun,
      cursorUpdatedTo: options.dryRun ? null : cursorUpdatedTo,
      nutrition,
      nutritionSummary,
      idSamples: summaries.slice(0, 20).map(item => String(item.id)),
    };
    if (includeIds) {
      result.ids = summaries.map(item => String(item.id));
    }

    await writeLastSyncStatus(env, {
      ok: true,
      ...result,
      idSamples: result.idSamples,
      ids: undefined,
      fetchedIdsCount: summaries.length,
    });

    return result;
  } catch (err) {
    const failedAt = new Date().toISOString();
    const failure = {
      ok: false,
      runId,
      source,
      startedAt,
      failedAt,
      after,
      before,
      dryRun: !!options.dryRun,
      error: err.message,
      stack: err.stack,
    };
    await writeLastSyncStatus(env, failure);
    throw err;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/auth/start") {
        const auth = new URL(STRAVA_AUTH_URL);
        auth.searchParams.set("client_id", env.STRAVA_CLIENT_ID);
        auth.searchParams.set("redirect_uri", redirectUri(request));
        auth.searchParams.set("response_type", "code");
        auth.searchParams.set("approval_prompt", "force");
        auth.searchParams.set("scope", "read,activity:read_all");
        return Response.redirect(auth.toString(), 302);
      }

      if (path === "/auth/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (error) return json({ error }, 400);
        if (!code) return json({ error: "Missing code" }, 400);
        const tokenData = await exchangeCode(request, env, code);
        return json({
          status: "authorized",
          athlete: tokenData.athlete ? {
            id: tokenData.athlete.id,
            username: tokenData.athlete.username,
            firstname: tokenData.athlete.firstname,
            lastname: tokenData.athlete.lastname,
          } : null,
          expires_at: tokenData.expires_at,
        });
      }

      const unauthorized = requireApiKey(request, env);
      if (unauthorized) return unauthorized;

      if (path === "/sync/status" && request.method === "GET") {
        return json(await getSyncHealth(env));
      }

      if (path === "/sync" && (request.method === "GET" || request.method === "POST")) {
        const days = Number(url.searchParams.get("days") || "");
        const afterParam = url.searchParams.get("after");
        const beforeParam = url.searchParams.get("before");
        const after = afterParam ? Number(afterParam) : (days ? Math.floor(Date.now() / 1000) - days * 86400 : undefined);
        const before = beforeParam ? Number(beforeParam) : undefined;
        const review = url.searchParams.get("review") || "";
        const maxPages = Number(url.searchParams.get("maxPages") || 10);
        const dryRun = parseBoolParam(url.searchParams.get("dryRun")) || parseBoolParam(url.searchParams.get("dry"));
        const includeIds = parseBoolParam(url.searchParams.get("includeIds"));
        return json(await syncStrava(env, { after, before, review, maxPages, dryRun, includeIds, source: "manual_http" }));
      }

      if (path === "/activities/recent") {
        const days = Number(url.searchParams.get("days") || 7);
        const after = Math.floor(Date.now() / 1000) - days * 86400;
        const summaries = await fetchActivities(env, { after, maxPages: Number(url.searchParams.get("maxPages") || 2) });
        return json({ items: summaries });
      }

      return json({ error: "Not found", path }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      syncStrava(env, { maxPages: 3, source: "scheduled_cron" }).catch(err => {
        console.log(`[scheduled] sync failed: ${err.message}`);
      })
    );
  },
};
