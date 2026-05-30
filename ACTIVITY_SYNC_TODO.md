# Activity Sync / Nutrition Energy Model TODO

Context: nutrition food logs live in the Google Sheet `Log` tab through Apps Script. Strength workout detail already has dedicated `Strength Workouts` and `Strength Sets` sheets. Rides have historically been logged into `Log` manually as negative kcal/carbs entries from Xert. Walks, hikes, and most strength sessions are missing from the nutrition energy ledger.

## Design Position

Use polling first, not Strava webhooks.

Reasons:

- Strava webhooks still require OAuth token refresh because webhook payloads only contain activity IDs.
- Strava access tokens expire after roughly 6 hours; the refresh token must be stored and rotated after refresh.
- Webhooks are useful for low latency, but nutrition accounting does not need sub-minute updates.
- Polling and historical backfill can share one idempotent ingestion path.
- A future webhook can be added later as an early trigger that enqueues the same delayed fetch/upsert.

Use raw activity storage plus derived nutrition formulas. Keep negative `Log` rows as a compatibility/projection layer during migration, not as the long-term source of activity identity.

Reasons:

- Raw activity facts should not change when the calorie-credit convention changes.
- Nutrition-facing numbers can evolve from carb-only credit to total-burn haircut without rewriting source history.
- Maintenance, weekly deficit, and target calories should be spreadsheet/API views over stable raw data.

## Target Architecture

### 1. Source Poller

Run a Cloudflare Worker on a Cron Trigger.

Responsibilities:

- Refresh Strava OAuth tokens when needed and persist the newest refresh token.
- Poll `/athlete/activities` with a moving sync cursor.
- Fetch detailed activity data for new/changed Strava IDs.
- Pull source-specific enrichment where useful:
  - Xert for ride substrate/carb-burn data, matched by activity start time or Xert activity ID if available.
  - Speediance for strength workout calories and detail, using existing Speediance worker/API path.
- Normalize everything into one activity payload.
- Send idempotent upserts to Apps Script.

Store worker state in Cloudflare KV or D1:

- `STRAVA_ACCESS_TOKEN`
- `STRAVA_REFRESH_TOKEN`
- `STRAVA_EXPIRES_AT`
- `STRAVA_LAST_SYNC_AFTER`
- optional backfill cursors by source/date range

### 2. Activity Ledger In Apps Script

Add a dedicated activity ledger instead of writing all synced activity directly as anonymous `Log` rows.

Suggested sheet: `Activities`

Suggested columns:

- `ActivityKey` such as `strava:123`, `speediance:456`, `xert:789`
- `PrimarySource`
- `SourceID`
- `StravaID`
- `XertID`
- `SpeedianceID`
- `StartTime`
- `EndTime`
- `Date`
- `Type`
- `Name`
- `DurationSec`
- `DistanceMeters`
- `TotalKcal`
- `CarbKcal`
- `CarbGrams`
- `FatKcal`
- `ProteinKcal`
- `CreditOverrideKcal`
- `CreditPolicy`
- `NutritionLogID`
- `LegacyMatchedLogID`
- `SyncStatus`
- `ReviewStatus`
- `RawJSON`
- `UpdatedAt`

Rules:

- Upsert by `ActivityKey`.
- Prefer source-native IDs over fuzzy matching.
- Keep `TotalKcal`, `CarbKcal`, and raw payload immutable unless the source record changes.
- Compute normal credit from global/report policy, not from per-row manual edits. Use `CreditOverrideKcal` only as an explicit exception.
- Link to `Log` via `NutritionLogID` only if the activity is represented in the food/nutrition log as a negative-calorie row.

### 3. Nutrition Log Projection / Compatibility

Decide whether `Log` remains the source for summary formulas or becomes a projection. The existing workbook already handles negative `Log` rows well:

- positive kcal/carbs are gross food intake.
- negative kcal are full exercise burn.
- negative carbs are carb burn.
- `Summary` derives gross, adjusted, net, kcal burned, and carbs burned from those signs.

So the benefit of `Activities` is not better daily arithmetic. The benefit is source identity, idempotent sync, reviewable migration, and the ability to change exercise-credit policy without rewriting imported facts.

Pragmatic v1:

- Keep `Log` as-is.
- For each accepted activity, create/update one `Log` row with:
  - `Meal = Exercise` or a more specific activity marker.
  - negative `kcal` equal to `-TotalKcal` if existing summary formulas expect full burn.
  - negative `carbs` equal to carb burn grams or kcal-derived carb grams if existing adjusted formulas expect carb burn.
  - protein/fat/fiber/etc. at zero.
  - stable link back to `Activities.ActivityKey` in a new column if feasible.

Better v2:

- Make `Summary` draw food intake from `Log` and exercise burn from `Activities`.
- Stop storing synced exercise as fake food rows.
- Preserve old manual exercise rows for legacy compatibility until formulas are migrated.

Compatibility API behavior:

- `POST /logs` should continue to accept legacy negative exercise entries for now.
- If an incoming entry has `Meal = Exercise` or negative `kcal`/`carbs`, route it through activity ingestion and then create/update the projected `Log` row.
- Do not route arbitrary negative values silently unless they are activity-like; return a structured validation warning for suspicious negative food entries.
- New automation should call explicit activity endpoints instead of relying on negative food rows.

## Migration Strategy

Bias toward false negatives in matching. Never let a script auto-merge ambiguous keyless history.

### Existing Data Classes

- Food rows: ignore for activity migration.
- Legacy ride rows in `Log`: mostly already covered manually from Xert; avoid re-importing historical rides unless reconciling IDs.
- Strength detail rows: already have stable Speediance IDs in `Strength Workouts`, but most are not represented in nutrition `Log`; backfill nutrition activity credit from these.
- Walks/hikes: mostly missing from nutrition `Log`; backfill from Strava.
- Big manual hikes/walks: possible duplicates in `Log`; route to review if a Strava activity appears to match.

### Backfill Phases

1. Inventory legacy exercise rows from `Log`.
   - Query rows where `Meal` or description indicates exercise.
   - Parse date, name/type hints, negative kcal, negative carbs.
   - Do not mutate yet.

2. Backfill strength from Speediance.
   - Insert/upsert `Activities` rows keyed by `speediance:{ID}`.
   - If nutrition `Log` lacks a matching exercise row on the date, create a linked nutrition projection row.
   - Because routine strength was mostly not logged in nutrition, default behavior should be insert.

3. Backfill walks/hikes from Strava.
   - Insert/upsert `Activities` rows keyed by `strava:{ID}`.
   - For obvious no-match days, create nutrition projection rows.
   - For same-day manual exercise rows with similar kcal/duration/name, mark `ReviewStatus = needs_review` and do not auto-create the duplicate projection until reviewed.

4. Handle rides forward-only at first.
   - Pick a cutover date.
   - Poll and ingest rides after that date only.
   - Leave legacy ride rows alone unless/until a separate reconciliation pass stamps source IDs onto them.

5. Optional legacy ride reconciliation.
   - Match Xert/Strava rides to existing manual `Log` rows by date, time, total kcal, carb burn, and duration.
   - Auto-stamp only high-confidence one-to-one matches.
   - Export ambiguous candidates for human review.

## Review Workflow

Use the `Review` and `ReviewNote` columns directly inside `Activities`; do not create a separate review ledger.

Suggested `Review` values:

- `ok`
- `legacy_only`
- `source_matched`
- `needs_review`
- `duplicate`
- `ignore`

Historical import should bias toward visible review rows:

- confident source match: update the existing migrated activity row and set `Review = source_matched`.
- ambiguous possible duplicate: keep both rows in `Activities` and set `Review = needs_review`.
- clear no-match: insert a new row with `Review = ok`.

The first Strava backfill can conservatively insert imported historical rows as `needs_review`; then manual filtering by date/review in the single `Activities` tab is enough to resolve duplicates.

## Calorie Credit Policy

Keep these as derived policy fields, not as source facts.

Suggested starting policy:

- Rides: keep Xert carb burn and total burn; nutrition credit can be a configurable haircut of total burn.
- Walks/hikes: credit a conservative fraction of total Strava/Garmin burn.
- Strength: credit a conservative fraction of Speediance calories.
- Default haircut: start around 0.33 unless data suggests another value.

This supports two separate ledgers:

- `TotalKcal`: used for observed maintenance / energy model.
- computed credit kcal: used for daily eating allowance / target behavior.
- `CreditOverrideKcal`: optional per-activity manual override.

## Spreadsheet / API Reporting Changes

Add summary/reporting fields after activity ingestion is stable:

- Settings-driven activity credit mode and rate.
- 7-day rolling gross kcal.
- 7-day rolling total activity burn.
- 7-day rolling credited activity burn.
- 7-day rolling net kcal.
- dynamic maintenance estimate.
- target kcal for loss/maintenance based on current weight and observed results.
- weekly deficit/surplus against dynamic maintenance.
- expected weekly weight change.
- observed smoothed weekly weight change.
- divergence between expected and observed change.

Longer-term model:

- Maintenance should be self-calibrated from logged intake, activity, and smoothed weight change.
- Weight-dependent targets should ratchet down as body weight falls.
- Do not try to infer local maxima/minima live; use leading energy-balance signals and trailing weight trends.

Current settings model:

- `Settings!activity_credit_mode`: `percent_total`, `carb_only`, or `none`.
- `Settings!activity_credit_rate`: fraction of total activity kcal credited when mode is `percent_total`.
- `Settings!carb_kcal_per_gram`: carb-burn conversion for carb-only mode.
- `Summary!Weighted kcal`: gross kcal minus computed activity credit.
- `Summary!Activity credit kcal`: the computed credit.

## Phase Analysis / Target Calibration

Add a `Phase Analysis` or `Energy Model` report that lets the exercise discount vary and recalculates reality-anchored targets.

Inputs:

- phase start date.
- phase end date.
- target loss rate, e.g. `0.5 lb/week`.
- exercise discount, e.g. `0.63`.
- optional weight smoothing method/window.

For each phase and discount `p`:

- `gross_avg = average daily gross kcal`.
- `exercise_avg = average daily total activity kcal`.
- `credited_net_avg = gross_avg - p * exercise_avg`.
- `observed_loss_rate = -(end_weight - start_weight) / weeks`.
- `maintenance_at_discount = credited_net_avg + 500 * observed_loss_rate`.
- `target_for_goal = maintenance_at_discount - 500 * target_loss_rate`.

This means a past phase can answer: "under a 63% exercise discount, what target would have produced roughly 0.5 lb/week?"

Optional "best discount" analysis:

- Build weekly rows with gross intake, total activity burn, smoothed weight change, and inferred maintenance.
- Grid-search discount values from 0.00 to 1.00.
- Prefer the discount that minimizes variance in inferred maintenance across weeks/phases, subject to sane priors.
- Report it as a fitted convention, not a physiological truth, because exercise estimates, food logging bias, compensation, and behavior all move together.

## Implementation Order

1. Add Apps Script `Activities` sheet setup helpers.
2. Add Apps Script activity upsert endpoint.
3. Add Apps Script endpoint to list legacy exercise rows from `Log`.
4. Add Cloudflare Strava OAuth/token-refresh module.
5. Build Strava polling/backfill script against a dry-run JSON output first.
6. Build Speediance-to-activity backfill using existing strength data/API path.
7. Use `Activities.Review` / `ReviewNote` for possible manual duplicates.
8. Implement accepted activity to nutrition `Log` projection.
9. Turn on scheduled forward sync.
10. Add weekly energy-balance and dynamic-target summary/reporting fields.

## Open Decisions

- Whether `Activities` should live in the existing nutrition spreadsheet or a separate sheet/workbook.
- Whether Cloudflare state should use KV only or D1 for better queryability/audit.
- Whether activity projection should keep using negative rows in `Log` or move `Summary` formulas to read `Activities` directly.
- Which exact activity types should receive eat-back credit and at what haircut.
- Cutover date for forward-only ride sync.
- How much legacy ride reconciliation is worth doing now versus later.
