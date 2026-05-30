#!/usr/bin/env bash
set -u -o pipefail

# Re-exec under bash if invoked with sh
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

# Config (override via env if desired)
WORKER_URL=${CF_WORKER_URL:-"https://xert.tmhinkle.workers.dev/"}
API_KEY=${CF_API_KEY:-"your-api-key-here"}  # set CF_API_KEY env var or edit this
ZWO_PATH="./TestWorkout.zwo"

mkdir -p ./_worker_test

step() { echo; echo "==> $1"; }
run_curl() {
  local url="$1"; shift
  local hdrs="$1"; shift
  local out="$1"; shift
  curl -sS -D "$hdrs" -o "$out" -H "X-API-KEY: ${API_KEY}" "$@" "$url" || true
}
status_of() { head -n1 "$1" | awk '{print $2}'; }
has_redirect_flag() { grep -Ei 'redirect=1' "$1" >/dev/null 2>&1; }

echo "Worker URL: ${WORKER_URL}"

# 1) Sanity check: ping a simple route (known working — commenting out to focus on JSON builder)
# step "Sanity: GET /recentRides?days=1"
# HDRS=./_worker_test/sanity.headers
# OUT=./_worker_test/sanity.body.json
# run_curl "${WORKER_URL%/}/recentRides?days=1" "$HDRS" "$OUT" -X GET
# S1=$(status_of "$HDRS")
# echo "HTTP: ${S1:-unknown} (saved to $HDRS / $OUT)"
# if [[ "${S1}" == "404" ]]; then
#   echo "Note: 404 suggests the URL is not your Worker service name."
# fi

# 2) File upload: /import-workout-file (known working — commenting out to focus on JSON builder)
# step "Upload: POST /import-workout-file (ZWO file)"
# HDRS=./_worker_test/file_upload.headers
# OUT=./_worker_test/file_upload.body.html
# if [[ -f "$ZWO_PATH" ]]; then
#   curl -sS -D "$HDRS" -o "$OUT" \
#     -H "X-API-KEY: ${API_KEY}" \
#     -X POST "${WORKER_URL%/}/import-workout-file" \
#     -F "files[]=@${ZWO_PATH};type=application/octet-stream" \
#     -F "convert_above_ftp=mmp" \
#     -F "convert_below_ftp=xssr" || true
#   S2=$(status_of "$HDRS")
#   echo "HTTP: ${S2:-unknown} (saved to $HDRS / $OUT)"
#   if has_redirect_flag "$OUT"; then
#     echo "Note: Response contains redirect=1 (likely upstream auth issue)."
#   fi
# else
#   echo "Missing file: $ZWO_PATH"
# fi

# 3) JSON upload: /import-workout-json — exercise rich ZWO builder with segments
step "Upload: POST /import-workout-json (rich segments JSON -> ZWO -> upload)"
HDRS=./_worker_test/json_segments.headers
OUT=./_worker_test/json_segments.body.html
JSON_FILE=./_worker_test/json_segments.payload.json
cat > "$JSON_FILE" <<'JSON'
{
  "name": "Builder Segments Demo",
  "description": "Warmup, steady, intervalsT, ramp, freeride, cooldown with cadence and text events",
  "steps": [
    { "type": "warmup",     "duration": 300, "start": 0.5, "end": 0.7,  "cadence": 85 },
    { "type": "steady",     "duration": 600, "target": 0.85,              "cadence": 90 },
    { "type": "intervalst", "repeat": 3,  "onDuration": 120, "offDuration": 60, "onPower": 1.1, "offPower": 0.55, "cadence": 95, "cadenceResting": 85 },
    { "type": "ramp",       "duration": 180, "start": 0.7, "end": 1.0 },
    { "type": "freeride",   "duration": 120 },
    { "type": "cooldown",   "duration": 300, "start": 0.6, "end": 0.4,  "cadence": 80 }
  ],
  "textEvents": [
    { "timeOffset": 60,  "message": "Drink" },
    { "timeOffset": 660, "message": "Focus on form" }
  ]
}
JSON
curl -sS -D "$HDRS" -o "$OUT" \
  -H "X-API-KEY: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -X POST "${WORKER_URL%/}/import-workout-json" \
  --data-binary @"$JSON_FILE" || true
S3=$(status_of "$HDRS")
echo "HTTP: ${S3:-unknown} (saved to $HDRS / $OUT)"
if has_redirect_flag "$OUT"; then
  echo "Note: Response contains redirect=1 (likely upstream auth issue)."
fi

echo
echo "Summary:"
printf "  Sanity /recentRides        -> %s\n" "${S1:-n/a}"
printf "  File  /import-workout-file -> %s\n" "${S2:-n/a}"
printf "  JSON (segments)            -> %s\n" "${S3:-unknown}"
