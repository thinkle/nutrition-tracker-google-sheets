#!/usr/bin/env node

/**
 * Get a Strava refresh token for local backfill / Worker setup.
 *
 * Usage:
 *   STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... node scripts/strava-oauth.mjs auth-url
 *   STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... node scripts/strava-oauth.mjs exchange --code AUTH_CODE
 *   STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... node scripts/strava-oauth.mjs exchange --callback-url CALLBACK_URL
 *
 * If your Strava app's Authorization Callback Domain is not localhost, pass the
 * same redirect URI to both commands:
 *   --redirect-uri https://example.com/callback
 */

const STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const DEFAULT_TOKEN_FILE = ".strava-token.json";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] || fallback;
}

function tokenFile() {
  return arg("token-file", DEFAULT_TOKEN_FILE);
}

function redirectUri() {
  return arg("redirect-uri", "http://localhost/exchange_token");
}

function authUrl() {
  const url = new URL(STRAVA_AUTH_URL);
  url.searchParams.set("client_id", requireEnv("STRAVA_CLIENT_ID"));
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("approval_prompt", "force");
  url.searchParams.set("scope", "read,activity:read_all");
  return url.toString();
}

async function exchangeCode() {
  const callbackUrl = arg("callback-url");
  const callbackCode = callbackUrl ? new URL(callbackUrl).searchParams.get("code") : "";
  const code = arg("code", callbackCode || "");
  if (!code) throw new Error("Missing --code");

  const body = new URLSearchParams();
  body.set("client_id", requireEnv("STRAVA_CLIENT_ID"));
  body.set("client_secret", requireEnv("STRAVA_CLIENT_SECRET"));
  body.set("code", code);
  body.set("grant_type", "authorization_code");

  const resp = await fetch(STRAVA_TOKEN_URL, { method: "POST", body });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Strava token exchange failed ${resp.status}: ${JSON.stringify(data)}`);

  const safeData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    athlete: data.athlete ? {
      id: data.athlete.id,
      username: data.athlete.username,
      firstname: data.athlete.firstname,
      lastname: data.athlete.lastname,
    } : null,
    created_at: new Date().toISOString(),
  };

  const fs = await import("node:fs/promises");
  await fs.writeFile(tokenFile(), JSON.stringify(safeData, null, 2) + "\n", { mode: 0o600 });

  console.log(JSON.stringify({
    token_file: tokenFile(),
    expires_at: data.expires_at,
    athlete: safeData.athlete,
    has_refresh_token: Boolean(data.refresh_token),
  }, null, 2));
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "auth-url") {
    console.log(authUrl());
    return;
  }
  if (cmd === "exchange") {
    await exchangeCode();
    return;
  }
  console.error("Usage: node scripts/strava-oauth.mjs auth-url|exchange");
  process.exit(1);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
