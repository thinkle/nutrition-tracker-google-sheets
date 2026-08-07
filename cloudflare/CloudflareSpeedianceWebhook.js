// CloudflareSpeedianceWebhook.js
//
// Webhook receiver for the Speediance workout tracker PWA
// (github: speediance-hardware). After a workout finishes and syncs to
// Firestore, the app POSTs its session summary here (no raw telemetry —
// see createSessionSummary() in the app's lib/report.js). This worker
// transforms that summary into the shape the nutrition-tracker GAS backend
// expects for /logStrengthWorkout and relays it there.
//
// Auth: caller must send X-API-KEY matching env.API_KEY. This is the only
// auth boundary in the chain — the GAS endpoint itself has none (see
// secrets.txt), so this worker is what keeps the public PWA from being able
// to write arbitrary data into the sheet.
//
// Expected POST body: either
//   { workout: { id, name, startedAt, completedAt, estimatedCaloriesKcal, sets: [...] } }
// or the bare `workout` object itself — see createSessionSummary()'s output
// shape in the Speediance app for the exact fields consumed below.

function nutritionUrl(env, path) {
  const base = (env.NUTRITION_API_BASE || "").replace(/\/$/, "");
  if (!base) throw new Error("Missing NUTRITION_API_BASE");
  const url = new URL(`${base}/${path.replace(/^\//, "")}`);
  if (env.NUTRITION_API_TOKEN) url.searchParams.set("token", env.NUTRITION_API_TOKEN);
  return url.toString();
}

function toEpochSeconds(isoString) {
  if (!isoString) return null;
  const ms = new Date(isoString).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Mirrors the "log_manual_strength" transform in cloudflare-mcp/src/index.js. */
function transformToGasPayload(workout) {
  const startTimestamp = toEpochSeconds(workout.startedAt);
  const endTimestamp = toEpochSeconds(workout.completedAt) ?? startTimestamp;
  const workoutId = workout.id || workout.workoutId || `speediance-${endTimestamp || Date.now()}`;

  const exercises = new Map();
  for (const set of workout.sets || []) {
    const exercise = set.exercise || {};
    const key = exercise.id || exercise.name || "Unknown exercise";
    if (!exercises.has(key)) {
      exercises.set(key, {
        id: `${workoutId}-ex${exercises.size + 1}`,
        actionLibraryId: exercise.catalogId || null,
        actionLibraryName: exercise.name || "Unknown exercise",
        primaryMuscles: Array.isArray(exercise.primaryMuscles) ? exercise.primaryMuscles : [],
        secondaryMuscles: Array.isArray(exercise.secondaryMuscles) ? exercise.secondaryMuscles : [],
        weights: [],
        finishedReps: [],
      });
    }
    const entry = exercises.get(key);
    const weight = typeof set.actualLoadLb === "number"
      ? set.actualLoadLb
      : typeof set.plannedLoadLb === "number" ? set.plannedLoadLb : null;
    if (typeof weight === "number") entry.weights.push(weight);
    entry.finishedReps.push({
      ix: entry.finishedReps.length + 1,
      isFinish: true,
      finishedCount: set.completedReps ?? null,
      targetCount: set.targetReps ?? set.completedReps ?? null,
      ...(set.actualDurationSeconds ? { time: set.actualDurationSeconds } : {}),
      ...(weight != null ? { avgWeight: weight, weightDetail: String(weight) } : {}),
    });
  }

  const cttActionLibraryTrainingInfoList = [...exercises.values()].map((entry) => ({
    id: entry.id,
    actionLibraryId: entry.actionLibraryId,
    actionLibraryName: entry.actionLibraryName,
    ...(entry.primaryMuscles.length ? { primaryMuscles: entry.primaryMuscles } : {}),
    ...(entry.secondaryMuscles.length ? { secondaryMuscles: entry.secondaryMuscles } : {}),
    ...(entry.weights.length ? {
      maxWeight: Math.max(...entry.weights),
      avgWeight: entry.weights.reduce((total, value) => total + value, 0) / entry.weights.length,
    } : {}),
    finishedReps: entry.finishedReps,
  }));

  return {
    data: {
      id: workoutId,
      templateName: workout.name || "Speediance workout",
      startTimestamp,
      endTimestamp,
      ...(workout.estimatedCaloriesKcal != null ? { calorie: workout.estimatedCaloriesKcal } : {}),
      trainingCount: cttActionLibraryTrainingInfoList.length,
      cttActionLibraryTrainingInfoList,
    },
  };
}

// The Speediance PWA calls this from whatever origin it's hosted/dev-served
// on. Auth is by X-API-KEY, not origin, so a permissive CORS policy doesn't
// weaken the actual security boundary.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-KEY",
};

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
    }
    if (request.headers.get("X-API-KEY") !== env.API_KEY) {
      return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
    }

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return jsonResponse({ error: "Invalid JSON body", message: err.message }, 400);
    }

    const workout = body?.workout || body;
    if (!workout || typeof workout !== "object") {
      return jsonResponse({ error: "Missing workout payload" }, 400);
    }

    let payload;
    try {
      payload = transformToGasPayload(workout);
    } catch (err) {
      return jsonResponse({ error: "Failed to transform payload", message: err.message }, 400);
    }

    try {
      const useBinding = !!env.NUTRITION;
      const req = new Request(nutritionUrl(env, "logStrengthWorkout"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const resp = useBinding ? await env.NUTRITION.fetch(req) : await fetch(req);
      const text = await resp.text();
      return new Response(text, {
        status: resp.status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    } catch (err) {
      console.log(`[speediance-webhook] relay failed: ${err.message}`);
      return jsonResponse({ error: "Failed to relay to nutrition tracker", message: err.message }, 502);
    }
  },
};
