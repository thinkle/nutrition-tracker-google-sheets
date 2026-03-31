// CloudflareSpedianceProxy.js
//
// Proxy worker for the Speediance gym app API.
//
// Hard-coded device preferences for this user's setup:
//   - Exercise library is always fetched from deviceType=1 (Gym Monster),
//     because the user has pulleys that let them use GM-style movements.
//   - All workout templates and scheduling target deviceType=2 (Gym Pal).
//
// Workout preset modes (compiled from canonical model → Speediance CSV-string payload):
//   - "hypertrophy" : 3 sets × 12 reps @ 13RM, 60s rest
//   - "strength"    : 5 sets × 5 reps  @ 6RM,  90s rest
//   - "custom"      : caller specifies sets, reps, weight (lbs), rest
//
// Auth: credentials stored in KV (SPEEDIANCE_EMAIL / SPEEDIANCE_PASSWORD).
//       Session token cached in KV (speediance_token / speediance_user_id, 23h TTL).
//       On Speediance code=91 (unauthorized): invalidates cache, re-logins, retries once.

const API_BASE = "https://api2.speediance.com";

// Device types — do not change these without understanding the setup above.
const LIBRARY_DEVICE_TYPE = 1; // Gym Monster — used for exercise listings only
const WORKOUT_DEVICE_TYPE = 2; // Gym Pal    — used for all templates / scheduling

// Static headers that mimic the Speediance mobile client.
const STATIC_HEADERS = {
  "Content-Type": "application/json",
  "Versioncode": "31408",
  "Mobiledevices": JSON.stringify({
    brand: "google",
    device: "emulator64_arm64",
    deviceType: "Android SDK built for arm64",
    os: "",
    os_version: "29",
    manufacturer: "Google",
  }),
  "User-Agent": "Dart/3.7 (dart:io)",
  "Host": "api2.speediance.com",
  "Accept-Language": "en",
  "Utc_offset": "-0500",
  "Timezone": "America/New_York",
  "App_type": "SOFTWARE",
};

function authHeaders(token, appUserId) {
  return {
    ...STATIC_HEADERS,
    "Token": token,
    "App_user_id": String(appUserId),
    "Timestamp": String(Date.now()),
  };
}

// ---------------------------------------------------------------------------
// Payload compiler: canonical exercise → Speediance API format
// ---------------------------------------------------------------------------
// Canonical exercise fields:
//   groupId          number  — from exercise library (required)
//   actionLibraryId  number  — specific variant ID (required)
//   mode             string  — "hypertrophy" | "strength" | "custom"
//   sets             number? — override default set count
//   rest             number? — rest time in seconds (override default)
//   reps             number? — (custom only) reps per set
//   weight           number? — (custom only) weight in lbs
function compileExercise(ex) {
  const { groupId, actionLibraryId } = ex;

  let sets, reps, restSec, isRm, rm;

  if (ex.mode === "hypertrophy") {
    sets    = ex.sets ?? 3;
    reps    = 12;
    restSec = ex.rest ?? 60;
    isRm    = true;
    rm      = 13;
  } else if (ex.mode === "strength") {
    sets    = ex.sets ?? 5;
    reps    = 5;
    restSec = ex.rest ?? 90;
    isRm    = true;
    rm      = 6;
  } else {
    // custom
    sets    = ex.sets    ?? 3;
    reps    = ex.reps    ?? 10;
    restSec = ex.rest    ?? 60;
    isRm    = false;
  }

  const repeat = (v) => Array(sets).fill(String(v)).join(",");

  const payload = {
    groupId,
    actionLibraryId,
    templatePresetId: isRm ? 1 : -1,
    setsAndReps:              repeat(reps),
    breakTime:                repeat(restSec),
    breakTime2:               repeat(restSec),
    sportMode:                repeat(1),
    leftRight:                repeat(0),
    selectCompletionMethod:   repeat(1),
    completionMethod:         repeat(1),
    countType:                repeat(1),
    level:                    repeat(0),
    capacity:                 0,
  };

  if (isRm) {
    payload.counterweight2 = repeat(rm);
    payload.counterweight  = repeat(rm);
    payload.weights        = repeat(0);
  } else {
    // Custom: weight already in lbs (Speediance internal unit)
    const w = Math.round(ex.weight ?? 0);
    payload.weights        = repeat(w);
    payload.counterweight  = "";
    payload.counterweight2 = "";
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // Authenticate the caller (MCP server sends X-API-KEY via service binding)
    if (request.headers.get("X-API-KEY") !== env.API_KEY) {
      return new Response("Unauthorized", { status: 403 });
    }

    // -----------------------------------------------------------------------
    // Session helpers
    // -----------------------------------------------------------------------
    async function login() {
      const email    = await env.SECRET_STORE.get("SPEEDIANCE_EMAIL");
      const password = await env.SECRET_STORE.get("SPEEDIANCE_PASSWORD");

      const resp = await fetch(`${API_BASE}/api/app/v2/login/byPass`, {
        method:  "POST",
        headers: STATIC_HEADERS,
        body:    JSON.stringify({ userIdentity: email, password, type: 2 }),
      });
      const data = await resp.json();
      if (data.code !== 0) {
        throw new Error(`Speediance login failed (${data.code}): ${data.message}`);
      }

      const { token, appUserId } = data.data;
      // Cache session for 23 hours (token expiry unknown; 91 forces re-login anyway)
      await env.SECRET_STORE.put("speediance_token",   token,           { expirationTtl: 82800 });
      await env.SECRET_STORE.put("speediance_user_id", String(appUserId), { expirationTtl: 82800 });
      return { token, appUserId };
    }

    async function getSession() {
      const token     = await env.SECRET_STORE.get("speediance_token");
      const appUserId = await env.SECRET_STORE.get("speediance_user_id");
      if (token && appUserId) return { token, appUserId };
      return login();
    }

    // Makes a request to the Speediance API.
    // On code=91 (unauthorized) it clears the cached session and retries once.
    async function spReq(endpoint, options = {}, _retry = true) {
      const { token, appUserId } = await getSession();
      const resp = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers: { ...authHeaders(token, appUserId), ...(options.headers ?? {}) },
      });

      if (!resp.ok) {
        throw new Error(`Speediance HTTP ${resp.status} on ${endpoint}`);
      }

      const data = await resp.json();

      if (data.code === 91 && _retry) {
        await env.SECRET_STORE.delete("speediance_token");
        await env.SECRET_STORE.delete("speediance_user_id");
        return spReq(endpoint, options, false);
      }

      if (data.code !== 0) {
        throw new Error(`Speediance error ${data.code}: ${data.message}`);
      }

      return data.data;
    }

    function jsonResp(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // -----------------------------------------------------------------------
    // Routes
    // -----------------------------------------------------------------------
    try {

      // GET /exercises
      // Returns the full exercise library from deviceType=1 (Gym Monster).
      // Result is grouped by category tab → muscle group → exercises.
      if (path === "/exercises" && request.method === "GET") {
        const tabs = await spReq(`/api/app/actionLibraryTab/list?deviceType=${LIBRARY_DEVICE_TYPE}`);
        const library = await Promise.all(
          (tabs ?? []).map(async (tab) => {
            const groups = await spReq(
              `/api/app/actionLibraryGroup/trainingPartGroup?tabId=${tab.id}&deviceTypeList=${LIBRARY_DEVICE_TYPE}`
            );
            return { tabId: tab.id, tabName: tab.name, groups };
          })
        );
        return jsonResp({ deviceType: LIBRARY_DEVICE_TYPE, library });
      }

      // GET /exercise/:groupId
      // Full detail for one exercise group, including action variants.
      // Use the actionLibraryId from the variant list when building workout payloads.
      if (path.startsWith("/exercise/") && request.method === "GET") {
        const groupId = path.split("/")[2];
        const detail  = await spReq(`/api/app/actionLibraryGroup/${groupId}?isDisplay=1`);
        return jsonResp(detail);
      }

      // GET /workouts
      // Lists all custom workout templates (deviceType=2, Gym Pal).
      if (path === "/workouts" && request.method === "GET") {
        const data = await spReq(
          `/api/app/v4/customTrainingTemplate/appPage?pageNo=1&pageSize=-1&deviceTypes=${WORKOUT_DEVICE_TYPE}`
        );
        return jsonResp(data);
      }

      // GET /workout/:code
      // Full template detail including all exercises and sets.
      if (path.startsWith("/workout/") && request.method === "GET") {
        const code   = path.split("/").slice(2).join("/");
        const detail = await spReq(`/api/app/v3/customTrainingTemplate/detailByCode?code=${encodeURIComponent(code)}`);
        return jsonResp(detail);
      }

      // POST /workout/byname
      // Like POST /workout but exercises are identified by name instead of raw IDs.
      // Resolves each name → groupId → actionLibraryId automatically.
      // Body:
      //   name      string  — workout name
      //   exercises array   — { name, mode, sets?, rest?, reps?, weight? }
      if (path === "/workout/byname" && request.method === "POST") {
        const body = await request.json();
        const { name, exercises = [] } = body;
        if (!name) return new Response("name is required", { status: 400 });
        if (!exercises.length) return new Response("exercises cannot be empty", { status: 400 });

        // Build a flat lowercase-title → groupId map from the exercise library.
        // Library structure: tabs → groups (trainingPartId2 + actionLibraryGroupList)
        //                    → exercises (id=groupId, title=exercise name)
        const tabs = await spReq(`/api/app/actionLibraryTab/list?deviceType=${LIBRARY_DEVICE_TYPE}`);
        const nameToGroupId = {};
        for (const tab of tabs ?? []) {
          const groups = await spReq(
            `/api/app/actionLibraryGroup/trainingPartGroup?tabId=${tab.id}&deviceTypeList=${LIBRARY_DEVICE_TYPE}`
          );
          for (const group of groups ?? []) {
            for (const ex of group.actionLibraryGroupList ?? []) {
              if (ex.id && ex.title) {
                nameToGroupId[ex.title.toLowerCase()] = ex.id;
              }
            }
          }
        }

        // Resolve each exercise name → (groupId, actionLibraryId)
        const resolved = await Promise.all(exercises.map(async (ex) => {
          const needle = ex.name.toLowerCase();
          let groupId = nameToGroupId[needle];
          if (!groupId) {
            // Try substring match in both directions
            const key = Object.keys(nameToGroupId).find(
              k => k.includes(needle) || needle.includes(k)
            );
            if (!key) throw new Error(`Exercise not found in library: "${ex.name}"`);
            groupId = nameToGroupId[key];
          }
          const detail = await spReq(`/api/app/actionLibraryGroup/${groupId}?isDisplay=1`);
          const variants = detail?.actionLibraryList ?? [];
          if (!variants.length) throw new Error(`No variants found for exercise: "${ex.name}" (groupId ${groupId})`);
          const variant = variants.find(v => v.isDisplay === 1) ?? variants[0];
          return { ...ex, groupId, actionLibraryId: variant.id };
        }));

        const actionLibraryList = resolved.map(compileExercise);
        const payload = {
          name,
          actionLibraryList,
          totalCapacity: 0,
          deviceType:    WORKOUT_DEVICE_TYPE,
          bgColor:       0,
        };
        const result = await spReq("/api/app/v2/customTrainingTemplate", {
          method: "POST",
          body:   JSON.stringify(payload),
        });
        return jsonResp(result);
      }

      // POST /workout
      // Create a workout template from a canonical model.
      //
      // Body:
      //   name      string    — workout name
      //   exercises array     — list of canonical exercise objects:
      //     groupId          number  — from exercise library
      //     actionLibraryId  number  — specific variant ID
      //     mode             string  — "hypertrophy" | "strength" | "custom"
      //     sets             number? — override default set count
      //     rest             number? — rest seconds (override default)
      //     reps             number? — (custom) reps per set
      //     weight           number? — (custom) weight in lbs
      //
      // Preset defaults:
      //   hypertrophy  →  3 sets × 12 reps @ 13RM,  60s rest
      //   strength     →  5 sets × 5 reps  @ 6RM,   90s rest
      if (path === "/workout" && request.method === "POST") {
        const body = await request.json();
        const { name, exercises = [] } = body;

        if (!name) return new Response("name is required", { status: 400 });

        const actionLibraryList = exercises.map(compileExercise);
        const payload = {
          name,
          actionLibraryList,
          totalCapacity: 0,
          deviceType:    WORKOUT_DEVICE_TYPE,
          bgColor:       0,
        };

        const result = await spReq("/api/app/v2/customTrainingTemplate", {
          method: "POST",
          body:   JSON.stringify(payload),
        });
        return jsonResp(result);
      }

      // DELETE /workout/:id
      // Delete a custom template by its numeric ID.
      if (path.startsWith("/workout/") && request.method === "DELETE") {
        const id = path.split("/")[2];
        await spReq(`/api/app/customTrainingTemplate?ids=${id}`, { method: "DELETE" });
        return jsonResp({ success: true });
      }

      // GET /calendar?month=YYYY-MM
      // Monthly training calendar (Gym Pal / deviceType=2).
      if (path === "/calendar" && request.method === "GET") {
        const month = url.searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
        const data  = await spReq(
          `/api/app/v5/trainingCalendar/monthNew?date=${month}&selectedDeviceType=${WORKOUT_DEVICE_TYPE}`
        );
        return jsonResp(data);
      }

      // POST /schedule
      // Schedule a template on a specific date (Gym Pal / deviceType=2).
      // Body: { templateCode: string, date: "YYYY-MM-DD", status?: number }
      if (path === "/schedule" && request.method === "POST") {
        const { templateCode, date, status = 1 } = await request.json();
        if (!templateCode || !date) {
          return new Response("templateCode and date are required", { status: 400 });
        }
        const result = await spReq("/api/app/templateReservation", {
          method: "POST",
          body:   JSON.stringify({
            status,
            deviceType:   WORKOUT_DEVICE_TYPE,
            thatDay:      date,
            templateCode,
          }),
        });
        return jsonResp(result);
      }

      // GET /history?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
      // Training session records for a date range.
      if (path === "/history" && request.method === "GET") {
        const startDate = url.searchParams.get("startDate");
        const endDate   = url.searchParams.get("endDate");
        if (!startDate || !endDate) {
          return new Response("startDate and endDate are required", { status: 400 });
        }
        const data = await spReq(
          `/api/mobile/v2/report/userTrainingDataRecord?startDate=${startDate}&endDate=${endDate}`
        );
        return jsonResp(data);
      }

      // GET /history/stats?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
      // Aggregate training stats for a date range.
      if (path === "/history/stats" && request.method === "GET") {
        const startDate = url.searchParams.get("startDate");
        const endDate   = url.searchParams.get("endDate");
        if (!startDate || !endDate) {
          return new Response("startDate and endDate are required", { status: 400 });
        }
        const data = await spReq(
          `/api/mobile/v2/report/userTrainingDataStat?startDate=${startDate}&endDate=${endDate}`
        );
        return jsonResp(data);
      }

      // GET /training/:id
      // Detail for a single completed training session.
      if (path.startsWith("/training/") && request.method === "GET") {
        const id   = path.split("/")[2];
        const data = await spReq(`/api/app/trainingInfo/cttTrainingInfoDetail/${id}`);
        return jsonResp(data);
      }

      return new Response("Not found", { status: 404 });

    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
