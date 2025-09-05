# Nutrition Tracker Shim for Working w/ AI

If you have the paid ChatGPT you can make a custom GPT which you give access to an API. This project leverages that capability to let you track nutritional data in a google sheet. It turns GPT into a running nutritionist and health advisor, which is pretty awesome.

This project stores NUTRITION data in Google Sheets (via a Google Apps Script) and CYCLING data in Xert (via Xert APIs). It exposes normalized HTTP endpoints GPT needs through Cloudflare Workers so that you can set up ChatGPT (or another AI capable of hitting OpenAPI documented endpoints) as the conversational UX to read, query, and update those data sources.

Quick overview

- Nutrition: daily logs, goals, and metrics live in a Google Sheet and are exposed by a spreadsheet-attached Google Apps Script.
- Cycling: ride data, imports, and scheduling are handled via Xert and proxied through a Cloudflare Worker that normalizes authentication and endpoints.
- ChatGPT: the repo provides OpenAPI specs so a custom GPT can ingest the API and act as the conversational UI for both systems.

Why this is special

- Turns a custom GPT into the live UX: GPT can read and write your data via an OpenAPI-driven interface, making interactions conversational rather than clicking around sheets or portals.
- Normalizes two different systems: Cloudflare Workers smooth over Apps Script quirks and Xert auth flows so GPT can use a simple, consistent API.
- Low friction, private automation: the custom GPT + Worker proxy model keeps the user experience simple while avoiding direct app-level credential sharing.

Most of the work here is around the Apps Script for Google Sheets and the Cloudflare Worker proxies that make both endpoints ChatGPT-friendly.

## Nutrition (Google Sheets + Apps Script)

What it is

- A Google Apps Script (GAS) attached to a Sheet that exposes a small REST-ish API for daily logs, goals, and metrics.
- A Cloudflare Worker proxy (`cloudflare/CloudflareGasProxy.js`) that normalizes requests for GPT/tools (handles missing HTTP verbs, preserves query strings, returns JSON).

Setup

- Deploy your Apps Script as a Web App (execute as you; accessible by anyone with link). Copy the “exec” URL.
- In `cloudflare/CloudflareGasProxy.js`, set GAS_EXEC_URL to your Web App URL and deploy it with Wrangler.
  - Optional: protect the Worker with Cloudflare Access or add a simple API key check.

Using it

- Point your custom GPT Action to the Worker URL. A GET to the base Apps Script URL returns the OpenAPI spec the GPT can ingest.
- Endpoints include summaries for today, logs, goals, and metrics. The Worker preserves query params and maps non-GET/POST methods to POST with a `method=` query param so GPT can "pretend" full CRUD.

Notes

- Apps Script requires following redirects and doesn’t support all HTTP verbs directly; the Worker smooths those edges.
- Keep your sheet’s sharing minimal; the Worker is the preferred surface for tools.

## Cycling (Xert via Cloudflare Worker)

What it is

- A Cloudflare Worker (`cloudflare/CloudflareXertProxy.js`) that talks to Xert using two paths:
  - OAuth bearer token for read-only data endpoints (e.g., recent rides).
  - Cookie + CSRF flow for web-only endpoints (file import, JSON import → ZWO, schedule workout).
- A complete OpenAPI spec lives in `XertOpenApiSpec.json` for GPT Actions.

Endpoints (Worker)

- GET `/recentRides?days=1` — recent activities from the past N days.
- POST `/import-workout-file` — multipart upload of one or more `.zwo`/`.erg` files (field `files[]`).
- POST `/import-workout-json` — send a JSON workout; the Worker generates ZWO and uploads.
  - Units: durations are seconds; power fields are fractions of FTP (e.g., 0.65 = 65% FTP); cadence is RPM; freeride has no target (ERG off).
  - Supported steps: steady, warmup, cooldown, ramp (auto-mapped up/down), intervalsT, freeride; optional text events.
- POST `/schedule-workout` — schedule a workout on your Xert calendar (payload: `id`, `type="workout"`, `start_date`, `end_date`; `forUser` optional/overridden).

Auth & config

- All Xert Worker endpoints require `X-API-KEY` header.
- Configure Cloudflare KV (named `SECRET_STORE` in `wrangler.toml`) with:
  - `XERT_USERNAME`, `XERT_PASSWORD` — your Xert web credentials.
  - Optional: `XERT_FORUSER` — default user alias; if set, the Worker enforces it in scheduling.
  - The Worker also caches `xert_access_token` short‑term for OAuth.
- Set a Worker secret/env `API_KEY` and pass it in the `X-API-KEY` header from GPT/tools.

OpenAPI for GPT Actions

- Use `XertOpenApiSpec.json` as the action spec; update the `servers[0].url` to your Worker URL if different.
- The spec documents the JSON schema for `/import-workout-json` steps and the normalized `/schedule-workout` response.
