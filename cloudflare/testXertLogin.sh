#!/bin/bash
set -euo pipefail

# Config (set these in your environment before running)
USERNAME="$XERT_USERNAME"
PASSWORD="$XERT_PASSWORD"
if [[ -z "${USERNAME}" || -z "${PASSWORD}" ]]; then
  echo "XERT_USERNAME and XERT_PASSWORD must be set in the environment." >&2
  exit 1
fi

BASE_URL="https://www.xertonline.com"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36"

# Files
COOKIE_JAR="cookies.txt"
LOGIN_PAGE="login.html"

echo "1) Fetching login page and CSRF token…"
curl -sSL --compressed -c "$COOKIE_JAR" -H "User-Agent: $UA" "$BASE_URL/" -o "$LOGIN_PAGE"

CSRF_TOKEN=$(sed -n 's/.*name="_token" value="\([^"]*\)".*/\1/p' "$LOGIN_PAGE" | head -1)
echo "Got CSRF token: ${CSRF_TOKEN:-<none>}"
if [[ -z "${CSRF_TOKEN}" ]]; then
  echo "Failed to extract CSRF token. Exiting." >&2
  exit 1
fi

echo "2) Logging in…"
curl -sSL --compressed -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  -H "User-Agent: $UA" \
  -H "Referer: $BASE_URL/" \
  -H "Origin: $BASE_URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "_token=$CSRF_TOKEN&username=$(printf %s "$USERNAME" | sed 's/%/%25/g')&password=$(printf %s "$PASSWORD" | sed 's/%/%25/g')&timezone=" \
  -X POST "$BASE_URL/auth/login" -o login_response.html

echo "3) Verifying login by loading import page…"
curl -sSL --compressed -b "$COOKIE_JAR" -H "User-Agent: $UA" "$BASE_URL/workouts/import" -o import_page.html

# If we still see the login form or a meta refresh to ?redirect=1, auth failed
if grep -qi 'action="/auth/login"' import_page.html || grep -qi 'redirect=1' import_page.html; then
  echo "Login verification failed (import page not accessible). See login_response.html and import_page.html." >&2
  exit 1
fi

# Extract import CSRF token
IMPORT_CSRF_TOKEN=$(sed -n 's/.*name="_token" value="\([^"]*\)".*/\1/p' import_page.html | head -1)
echo "Import CSRF token: ${IMPORT_CSRF_TOKEN:-<none>}"
if [[ -z "${IMPORT_CSRF_TOKEN}" ]]; then
  echo "Failed to extract CSRF token from import page." >&2
  exit 1
fi

echo "4) Uploading workout if present…"
if [[ -f "./TestWorkout.zwo" ]]; then
  # Try to include X-XSRF-TOKEN header from cookie if available (Laravel)
  XSRF_COOKIE=$(awk '$6 ~ /XSRF-TOKEN/ { val=$7 } END{ print val }' "$COOKIE_JAR" || true)
  XSRF_HEADER=()
  if [[ -n "${XSRF_COOKIE:-}" ]]; then
    XSRF_HEADER=( -H "X-XSRF-TOKEN: $XSRF_COOKIE" )
  fi
  curl -sS -v --compressed -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
    -H "User-Agent: $UA" \
    -H "Referer: $BASE_URL/workouts/import" \
    -H "Origin: $BASE_URL" \
    "${XSRF_HEADER[@]}" \
    -F "_token=$IMPORT_CSRF_TOKEN" \
    -F "convert_above_ftp=mmp" \
    -F "convert_below_ftp=xssr" \
    -F "files[]=@./TestWorkout.zwo;type=application/octet-stream" \
    "$BASE_URL/workouts/import" \
    -o import_response.html || true
  echo "Import response saved to import_response.html"
else
  echo "TestWorkout.zwo not found in current directory" >&2
  exit 1
fi

echo "Done."