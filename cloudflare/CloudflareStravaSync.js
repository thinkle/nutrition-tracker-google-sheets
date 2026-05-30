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

async function postActivitiesToNutrition(env, activities) {
  if (!activities.length) return { results: [] };
  const batchSize = Number(env.NUTRITION_POST_BATCH_SIZE || 10);
  const batches = [];
  const targetUrl = nutritionUrl(env, "/activities");
  const useBinding = !!env.NUTRITION;
  console.log(`[postActivitiesToNutrition] Posting ${activities.length} activities in batches of ${batchSize} to ${targetUrl} (binding=${useBinding})`);
  for (let i = 0; i < activities.length; i += batchSize) {
    const chunk = activities.slice(i, i + batchSize);
    console.log(`[postActivitiesToNutrition] Batch offset=${i} count=${chunk.length}`);
    const req = new Request(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: chunk }),
    });
    const resp = useBinding ? await env.NUTRITION.fetch(req) : await fetch(req);
    const rawBody = await resp.text();
    console.log(`[postActivitiesToNutrition] Response status=${resp.status} body=${rawBody.slice(0, 500)}`);
    let data;
    try {
      data = JSON.parse(rawBody);
    } catch (_) {
      throw new Error(`Nutrition API returned non-JSON (status ${resp.status}): ${rawBody.slice(0, 300)}`);
    }
    if (!resp.ok) throw new Error(`Nutrition activity batch failed ${resp.status}: ${JSON.stringify(data)}`);
    batches.push({ offset: i, count: chunk.length, result: data });
  }
  return { batches };
}

async function syncStrava(env, options = {}) {
  const now = Math.floor(Date.now() / 1000);
  const defaultAfter = now - 3 * 86400;
  const storedAfter = await env.SECRET_STORE.get("STRAVA_LAST_SYNC_AFTER");
  const after = options.after ?? Number(storedAfter || defaultAfter);
  console.log(`[syncStrava] after=${after} nutritionBase=${env.NUTRITION_API_BASE} hasToken=${!!env.NUTRITION_API_TOKEN}`);
  const before = options.before;
  const review = options.review || "";
  const maxPages = options.maxPages || 10;

  const summaries = await fetchActivities(env, { after, before, maxPages });
  const details = await fetchDetailedActivities(env, summaries);
  const normalized = details.map(activity => normalizeStravaActivity(activity, { review }));
  const nutrition = await postActivitiesToNutrition(env, normalized);

  if (!options.dryRun) {
    await env.SECRET_STORE.put("STRAVA_LAST_SYNC_AFTER", String(now - 3600));
  }

  return {
    after,
    before,
    fetched: summaries.length,
    posted: normalized.length,
    nutrition,
  };
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

      if (path === "/sync" && (request.method === "GET" || request.method === "POST")) {
        const days = Number(url.searchParams.get("days") || "");
        const afterParam = url.searchParams.get("after");
        const beforeParam = url.searchParams.get("before");
        const after = afterParam ? Number(afterParam) : (days ? Math.floor(Date.now() / 1000) - days * 86400 : undefined);
        const before = beforeParam ? Number(beforeParam) : undefined;
        const review = url.searchParams.get("review") || "";
        const maxPages = Number(url.searchParams.get("maxPages") || 10);
        return json(await syncStrava(env, { after, before, review, maxPages }));
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
    ctx.waitUntil(syncStrava(env, { maxPages: 3 }));
  },
};
