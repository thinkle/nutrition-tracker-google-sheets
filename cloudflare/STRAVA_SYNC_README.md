# Strava Nutrition Sync

This is the Strava side of the nutrition activity workflow.

## Pieces

- `CloudflareStravaSync.js`: Cloudflare Worker with Strava OAuth, token refresh, manual sync, and scheduled sync.
- `wrangler-strava.toml`: Worker config template.
- `../scripts/strava-backfill.mjs`: local one-time historical import script.

## GAS First

Before using Strava import:

1. `clasp push` the Apps Script changes.
2. Reload the spreadsheet.
3. Run `Nutrition Tools -> Setup Activities Sheet`.
4. Run `Nutrition Tools -> Migrate Negative Log Rows to Activities`.
5. Verify:
   - `Activities` exists.
   - `Activity Migration Backup` exists.
   - old negative `Log` exercise rows became positive `Activities` rows.
   - `Summary` still has plausible gross, adjusted, net, kcal burned, and carbs burned numbers.

## Historical Backfill

Use the local script first because it is easier to observe and rerun.

```bash
STRAVA_CLIENT_ID=... \
STRAVA_CLIENT_SECRET=... \
NUTRITION_API_BASE=https://nutrition.tmhinkle.workers.dev \
node scripts/strava-backfill.mjs --after 2024-12-10 --before 2026-05-31 --skip-rides --dry-run
```

If the dry run looks sane, run without `--dry-run`.

```bash
STRAVA_CLIENT_ID=... \
STRAVA_CLIENT_SECRET=... \
NUTRITION_API_BASE=https://nutrition.tmhinkle.workers.dev \
node scripts/strava-backfill.mjs --after 2024-12-10 --before 2026-05-31 --skip-rides --post-batch-size 25
```

The script reads `.strava-token.json` written by `scripts/strava-oauth.mjs`.

Review semantics:

- New clean source rows default to `ok` server-side.
- Unique legacy matches become `source_matched`.
- Ambiguous legacy matches become `needs_review`.

Strava returns a new refresh token whenever auth refreshes. The script updates `.strava-token.json` automatically.

## Worker OAuth Setup

Create or choose a KV namespace and put its id into `wrangler-strava.toml`.

Set secrets:

```bash
wrangler secret put --config cloudflare/wrangler-strava.toml API_KEY
wrangler secret put --config cloudflare/wrangler-strava.toml STRAVA_CLIENT_ID
wrangler secret put --config cloudflare/wrangler-strava.toml STRAVA_CLIENT_SECRET
wrangler secret put --config cloudflare/wrangler-strava.toml NUTRITION_API_BASE
```

Deploy:

```bash
wrangler deploy --config cloudflare/wrangler-strava.toml
```

Authorize:

1. Visit `https://<worker-host>/auth/start`.
2. Approve Strava scopes.
3. The callback stores `STRAVA_ACCESS_TOKEN`, `STRAVA_REFRESH_TOKEN`, and `STRAVA_EXPIRES_AT` in KV.

Manual sync:

```bash
curl -H "X-API-KEY: $API_KEY" "https://<worker-host>/sync?days=7"
```

Safe debug dry run (does not post to Apps Script and does not advance cursor):

```bash
curl -H "X-API-KEY: $API_KEY" "https://<worker-host>/sync?days=7&dryRun=1&includeIds=1"
```

Sync health and last run status:

```bash
curl -H "X-API-KEY: $API_KEY" "https://<worker-host>/sync/status"
```

The status payload now includes:

- last run source (`scheduled_cron` vs `manual_http`)
- `fetched` vs `posted`
- downstream Apps Script status summary (`created`, `updated`, `matched_legacy`, `error`)
- cursor and token health

Reliability knobs (Worker env vars):

- `STRAVA_SYNC_OVERLAP_SEC` default `86400` (24h): each run re-fetches this much recent history to recover missed writes and updates.
- `NUTRITION_POST_MAX_ATTEMPTS` default `3`: retries each batch post on transient failures.
- `NUTRITION_POST_RETRY_BASE_MS` default `750`: exponential backoff base delay between retries.
- `NUTRITION_POST_BATCH_SIZE` default `10`: batch size for POST /activities.

Scheduled sync runs every 15 minutes.
