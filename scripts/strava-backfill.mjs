#!/usr/bin/env node

/**
 * One-time Strava historical backfill into the Nutrition Tracker Activities API.
 *
 * Required env:
 *   STRAVA_CLIENT_ID
 *   STRAVA_CLIENT_SECRET
 *   NUTRITION_API_BASE      e.g. https://nutrition.tmhinkle.workers.dev
 *
 * Auth:
 *   Reads STRAVA_REFRESH_TOKEN from env or .strava-token.json.
 *
 * Optional env:
 *   NUTRITION_API_TOKEN
 *   REVIEW                 optional override; new rows default to ok server-side
 *
 * Usage:
 *   STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... STRAVA_REFRESH_TOKEN=... \
 *   NUTRITION_API_BASE=https://nutrition.tmhinkle.workers.dev \
 *   node scripts/strava-backfill.mjs --after 2024-12-10 --before 2026-05-31 --dry-run
 */

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_API_BASE = "https://www.strava.com/api/v3";
const DEFAULT_TOKEN_FILE = ".strava-token.json";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] || fallback;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

async function optionalTokenFile() {
  const file = arg("token-file", DEFAULT_TOKEN_FILE);
  try {
    const fs = await import("node:fs/promises");
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    return {};
  }
}

async function getRefreshToken() {
  if (process.env.STRAVA_REFRESH_TOKEN) return process.env.STRAVA_REFRESH_TOKEN;
  const token = await optionalTokenFile();
  if (token.refresh_token) return token.refresh_token;
  throw new Error("Missing STRAVA_REFRESH_TOKEN env or .strava-token.json refresh_token");
}

function toEpoch(value) {
  if (!value) return "";
  if (/^\d+$/.test(value)) return Number(value);
  return Math.floor(new Date(`${value}T00:00:00`).getTime() / 1000);
}

async function refreshAccessToken() {
  const body = new URLSearchParams();
  body.set("client_id", requireEnv("STRAVA_CLIENT_ID"));
  body.set("client_secret", requireEnv("STRAVA_CLIENT_SECRET"));
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", await getRefreshToken());

  const resp = await fetch(STRAVA_TOKEN_URL, { method: "POST", body });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Strava refresh failed ${resp.status}: ${JSON.stringify(data)}`);
  await saveTokenFile_(data);
  console.error("Refreshed Strava token and updated .strava-token.json");
  return data.access_token;
}

async function saveTokenFile_(data) {
  const existing = await optionalTokenFile();
  const file = arg("token-file", DEFAULT_TOKEN_FILE);
  const fs = await import("node:fs/promises");
  await fs.writeFile(file, JSON.stringify({
    ...existing,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    updated_at: new Date().toISOString(),
  }, null, 2) + "\n", { mode: 0o600 });
}

async function stravaGet(token, path, params = {}) {
  const url = new URL(`${STRAVA_API_BASE}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json();
  if (resp.status === 429) {
    const err = new Error(`Strava rate limit exceeded on ${path}: ${JSON.stringify(data)}`);
    err.rateLimited = true;
    throw err;
  }
  if (!resp.ok) throw new Error(`Strava GET ${path} failed ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

async function fetchAllActivities(token, after, before, maxPages) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = await stravaGet(token, "/athlete/activities", {
      after,
      before,
      page,
      per_page: 100,
    });
    console.error(`Fetched page ${page}: ${items.length} activities`);
    if (!items.length) break;
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

async function fetchDetails(token, summaries) {
  const out = [];
  for (const summary of summaries) {
    try {
      out.push(await stravaGet(token, `/activities/${summary.id}`, { include_all_efforts: false }));
    } catch (err) {
      if (err.rateLimited) throw err;
      console.error(`Detail fetch failed for ${summary.id}: ${err.message}`);
      out.push({ ...summary, _detailError: err.message });
    }
  }
  return out;
}

function normalize(activity, review) {
  const start = activity.start_date_local || activity.start_date || "";
  const type = activity.sport_type || activity.type || "Activity";
  const description = activity.description || "";
  const out = {
    ActivityKey: `strava:${activity.id}`,
    Date: start ? start.slice(0, 10) : "",
    StartTime: start,
    Type: type,
    Name: activity.name || type,
    Description: [
      description,
      activity.distance ? `${Math.round(activity.distance)} meters` : "",
      activity.moving_time ? `${activity.moving_time} sec moving` : "",
    ].filter(Boolean).join("; "),
    TotalKcal: activity.calories ?? activity.kilojoules ?? "",
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

function nutritionUrl(path) {
  const base = requireEnv("NUTRITION_API_BASE").replace(/\/$/, "");
  const url = new URL(`${base}/${path.replace(/^\//, "")}`);
  if (process.env.NUTRITION_API_TOKEN) url.searchParams.set("token", process.env.NUTRITION_API_TOKEN);
  return url;
}

async function postBatch(items) {
  if (!items.length) return { results: [] };
  const resp = await fetch(nutritionUrl("/activities"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Nutrition API failed ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

async function postBatches(items, batchSize) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const result = await postBatch(chunk);
    results.push({ offset: i, count: chunk.length, result });
    console.error(`Posted ${Math.min(i + chunk.length, items.length)}/${items.length} activities`);
  }
  return results;
}

async function main() {
  const after = toEpoch(arg("after"));
  const before = toEpoch(arg("before"));
  const maxPages = Number(arg("max-pages", "20"));
  const dryRun = process.argv.includes("--dry-run");
  const skipRides = process.argv.includes("--skip-rides");
  const noDetails = process.argv.includes("--no-details");
  const maxDetails = Number(arg("max-details", "0"));
  const postBatchSize = Number(arg("post-batch-size", "25"));
  const review = process.env.REVIEW || arg("review", "");

  const token = await refreshAccessToken();
  const summaries = await fetchAllActivities(token, after, before, maxPages);
  let selectedSummaries = summaries.filter(activity => !skipRides || !isRide_(activity));
  if (maxDetails > 0) selectedSummaries = selectedSummaries.slice(0, maxDetails);
  const details = noDetails ? selectedSummaries : await fetchDetails(token, selectedSummaries);
  const activities = details.map(activity => normalize(activity, review));

  if (dryRun) {
    console.log(JSON.stringify({
      fetched: summaries.length,
      skipped: summaries.length - selectedSummaries.length,
      count: activities.length,
      activities
    }, null, 2));
    return;
  }

  const result = await postBatches(activities, postBatchSize);
  console.log(JSON.stringify({
    fetched: summaries.length,
    skipped: summaries.length - selectedSummaries.length,
    count: activities.length,
    result
  }, null, 2));
}

function isRide_(activity) {
  const type = String(activity.sport_type || activity.type || "").toLowerCase();
  return type.indexOf("ride") !== -1 || type.indexOf("cycling") !== -1;
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
