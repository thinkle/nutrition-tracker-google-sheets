import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mobile-client compatibility: Claude's mobile app sends array/object-typed
// tool parameters as JSON-encoded strings rather than parsed values (scalar
// string/number params are unaffected). Wrap any array/object schema so a
// string payload is JSON.parsed before validation runs. Leaves already-parsed
// values and non-string junk untouched (schema then reports a real error).
// ---------------------------------------------------------------------------

// Sentinel written into a goal field to mean "intentionally not tracked".
// A plain-language phrase so it can never be misread as a numeric target (0, none, -).
const GOAL_UNSET = "no goal set";

function jsonParsed(schema) {
  return z.preprocess((val) => {
    if (typeof val !== "string") return val;
    try {
      return JSON.parse(val);
    } catch {
      return val; // let the wrapped schema surface a clear validation error
    }
  }, schema);
}

// ---------------------------------------------------------------------------
// Recipe ingredients: a flat list of strings, or groups with nested lists.
// ---------------------------------------------------------------------------

// One ingredient: either the structured shape (preferred) or a plain line of
// text. Gourmet parses the text server-side, so a string is always safe --
// but send the parts when you know them and nothing has to be guessed.
const plainIngredient = z.union([
  z.string(),
  z
    .object({
      ingredient: z.string().optional().describe("Ingredient name and prep, e.g. 'flour, sifted'"),
      text: z.string().optional().describe("Same as `ingredient`; either key works"),
      amount: z
        .union([z.number(), z.string()])
        .optional()
        .describe("Number, or a parseable string like '1 1/2', '2-3' or 'two'"),
      unit: z.string().optional().describe("e.g. 'cups', 'tbsp', 'cloves'"),
      rangeAmount: z.number().optional().describe("Other end of a range, if not written into `amount`"),
    })
    .passthrough(),
]);

// A top-level entry may additionally be a group heading with its own sub-list.
const ingredientEntry = z.union([
  z
    .object({
      text: z.string().describe("Group heading, e.g. 'FOR THE DOUGH:'"),
      ingredients: z.array(plainIngredient),
    })
    .passthrough(),
  plainIngredient,
]);

const INGREDIENTS_DESC =
  "Ingredients. Preferred shape per entry: {amount, unit, ingredient} with the " +
  "parts separated, e.g. {amount: 1.5, unit: 'cups', ingredient: 'flour, sifted'}. " +
  "`amount` may be a number or a parseable string ('1 1/2', '2-3'); omit amount " +
  "and unit for things like 'salt to taste'. Keep the amount and unit OUT of " +
  "`ingredient` -- it is the name and prep only. " +
  "If you only have a line of text, send the plain string ('1 1/2 cups flour, " +
  "sifted') and the server parses the amount and unit out of it. " +
  "A group is {text: 'FOR THE DOUGH:', ingredients: [...]}; its nested list is " +
  "preserved as a real sub-list (not flattened or prefixed). Strings, structured " +
  "entries and groups can be mixed in the same list.";

// ---------------------------------------------------------------------------
// Build and connect a fresh McpServer for each request (stateless mode).
// ---------------------------------------------------------------------------

function buildServer(env) {
  const server = new McpServer({ name: "personal-mcp", version: "1.0.0" });

  // Use service bindings (env.NUTRITION / env.XERT) to call the proxy workers
  // directly, bypassing the HTTP routing layer that causes Cloudflare error 1042.
  const nutritionBase = "https://nutrition.tmhinkle.workers.dev";
  const xertBase = "https://xert.tmhinkle.workers.dev";
  const xertApiKey = env.XERT_API_KEY;
  const spedianceBase = "https://speediance.tmhinkle.workers.dev";
  const spedianceApiKey = env.SPEEDIANCE_API_KEY;
  const stravaSyncBase = "https://strava-nutrition-sync.tmhinkle.workers.dev";
  const stravaSyncApiKey = env.STRAVA_SYNC_API_KEY || env.STRAVA_API_KEY;
  // Recipe API is on Netlify (external), so regular fetch() works fine.
  const recipeBase = env.RECIPE_API_BASE;
  const recipeApiKey = env.RECIPE_API_KEY;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function nutritionRequest(endpoint, options = {}) {
    const response = await env.NUTRITION.fetch(`${nutritionBase}${endpoint}`, {
      headers: { "Content-Type": "application/json", ...options.headers },
      ...options,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Nutrition API ${response.status}: ${text}`);
    }
    return response.json();
  }

  async function spedianceRequest(endpoint, options = {}) {
    const response = await env.SPEEDIANCE.fetch(`${spedianceBase}${endpoint}`, {
      headers: { "X-API-KEY": spedianceApiKey, "Content-Type": "application/json", ...options.headers },
      ...options,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Speediance proxy ${response.status}: ${text}`);
    }
    return response.json();
  }

  async function xertRequest(endpoint, options = {}) {
    const response = await env.XERT.fetch(`${xertBase}${endpoint}`, {
      headers: {
        "X-API-KEY": xertApiKey,
        "Content-Type": "application/json",
        ...options.headers,
      },
      ...options,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Xert API ${response.status}: ${text}`);
    }
    const contentType = response.headers.get("content-type") || "";
    return contentType.includes("application/json")
      ? response.json()
      : response.text();
  }

  async function stravaSyncRequest(endpoint, options = {}) {
    if (!stravaSyncApiKey) {
      throw new Error("Missing STRAVA_SYNC_API_KEY secret for Strava sync diagnostics");
    }
    const target = `${stravaSyncBase}${endpoint}`;
    const request = new Request(target, {
      headers: {
        "X-API-KEY": stravaSyncApiKey,
        "Content-Type": "application/json",
        ...options.headers,
      },
      ...options,
    });
    const response = env.STRAVA_SYNC
      ? await env.STRAVA_SYNC.fetch(request)
      : await fetch(request);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Strava sync ${response.status}: ${text}`);
    }
    return response.json();
  }

  async function recipeRequest(path, body) {
    const response = await fetch(`${recipeBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": recipeApiKey },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Recipe API ${response.status}: ${text}`);
    }
    return response.json();
  }

  function ok(result) {
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  // The Speediance vendor app is currently broken, so the machine is not in
  // active use and its API is not a source of truth for anything. The tools
  // are kept wired up in case the vendor fixes the app, but agents should
  // treat them as dormant and reach for the direct strength tools instead.
  // Prefixing the descriptions (rather than deleting the tools) keeps the
  // plumbing intact while making the preference legible at tool-selection time.
  const SPEEDIANCE_DEPRECATION =
    "[DEPRECATED - DO NOT USE UNLESS EXPLICITLY ASKED] The Speediance machine and its vendor app are not currently in use, and this endpoint is dormant/unreliable. It is NOT a source of truth for what the user has actually trained: strength sessions now come from the direct strength tools. For strength history and analysis use list_strength_workouts / get_strength_sets / get_strength_workout / get_exercise_data; to record a session use log_manual_strength. Only call this tool if the user explicitly names Speediance or asks to work with the machine directly.";

  function deprecatedSpeediance(description) {
    return `${SPEEDIANCE_DEPRECATION}\n\n---\n\n${description}`;
  }

  function localDateString(timeZone = "America/New_York") {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  // -------------------------------------------------------------------------
  // Nutrition tools
  // -------------------------------------------------------------------------

  server.registerTool(
    "log_food",
    {
      description: "Log a meal entry to track nutrition. ALWAYS include the Date field — never omit it, even when logging a meal 'today'. Use today's actual date in YYYY-MM-DD format. After ALL items are logged (not after each one), call get_today_summary once to show the user their updated daily totals. If you do not already have the user's nutrition goals in context, call get_goals first so the summary can be compared against targets.",
      inputSchema: {
        Food: z.string().describe("Name of the food item"),
        Description: z.string().optional().describe("Additional description"),
        Meal: z.string().describe("Meal type (Breakfast, Lunch, Dinner, Snack)"),
        kcal: z.coerce.number().describe("Calories in kcal"),
        protein: z.coerce.number().describe("Protein in grams"),
        fat: z.coerce.number().describe("Fat in grams"),
        carbs: z.coerce.number().describe("Carbohydrates in grams"),
        fiber: z.coerce.number().optional().describe("Fiber in grams"),
        added_sugar: z.coerce.number().optional().describe("Added sugar in grams; do NOT include natural sugars such as lactose in milk or fructose in fruit."),
        Date: z.string().describe("Date in YYYY-MM-DD format. Required — always provide this, even for today's meals."),
      },
    },
    async ({ Food, Description, Meal, kcal, protein, fat, carbs, fiber, added_sugar, Date }) => {
      const body = { Food, Description, Meal, kcal, protein, fat, carbs, Date };
      if (fiber !== undefined) body.fiber = fiber;
      if (added_sugar !== undefined) body.added_sugar = added_sugar;
      return ok(await nutritionRequest("/log", { method: "POST", body: JSON.stringify(body) }));
    }
  );

  server.registerTool(
    "get_today_summary",
    { description: "Get today's nutrition totals including calories, macros, and comparison to goals. If you do not already have the user's nutrition goals in context, call get_goals alongside this so you can show progress against targets." },
    async () => ok(await nutritionRequest("/today"))
  );

  server.registerTool(
    "get_recent_logs",
    {
      description:
        "Get food log entries, newest-first. There are thousands of rows, so responses are paginated: " +
        "the reply includes `total`, `limit`, and `offset` — check `total` and page with `offset` when you need more than one page. " +
        "For analysis over a period, use start_date/end_date rather than paging blindly.",
      inputSchema: {
        date: z.string().optional().describe("Single date in YYYY-MM-DD format"),
        start_date: z.string().optional().describe("Range start (inclusive) in YYYY-MM-DD format"),
        end_date: z.string().optional().describe("Range end (inclusive) in YYYY-MM-DD format"),
        limit: z.coerce.number().optional().describe("Max items to return (default 50)"),
        offset: z.coerce.number().optional().describe("Items to skip (default 0)"),
      },
    },
    async ({ date, start_date, end_date, limit, offset }) => {
      const p = new URLSearchParams();
      if (date) p.set("date", date);
      if (start_date) p.set("start_date", start_date);
      if (end_date) p.set("end_date", end_date);
      if (limit !== undefined) p.set("limit", String(limit));
      if (offset !== undefined) p.set("offset", String(offset));
      const qs = p.toString();
      return ok(await nutritionRequest(`/logs${qs ? "?" + qs : ""}`));
    }
  );

  server.registerTool(
    "get_computed_calorie_target",
    {
      description:
        "Your calorie target COMPUTED FROM YOUR OWN DATA: what the last 56 days of logged intake " +
        "and actual weight change say your maintenance calories really are, plus the daily target " +
        "that implies for your goal rate. Contrast with get_goals, which returns the target you " +
        "have STATED. Comparing the two is how you tell whether a stated goal is still realistic.\n\n" +
        "Use this for: how much should I eat, is my calorie target still right, what is my TDEE or " +
        "maintenance, am I actually in a deficit, energy balance, weekly average intake versus " +
        "target, why has my weight stalled or plateaued, how fast am I really losing. It is already " +
        "computed server-side from the full history -- do not re-derive it by averaging raw logs.\n\n" +
        "Returns BOTH maintenanceGross (includes exercise) and maintenanceEffective (gross minus the " +
        "exercise discount, matching the tracker's 'Effective kcal' column). These differ by several " +
        "hundred kcal/day, so always say which you mean. targetAtGoalRate.effectivePerDay is a " +
        "REST-DAY figure; on a training day add dTarget * that day's burn.\n\n" +
        "maintenanceGrossSE is the within-window standard error; historicalSpread is the wider and " +
        "more honest uncertainty. One reading should not move a goal on its own.",
      inputSchema: {
        fresh: z.coerce.boolean().optional()
          .describe("Recompute now instead of serving the weekly cache. Slower; usually unnecessary."),
      },
    },
    async ({ fresh }) =>
      ok(await nutritionRequest(`/calibration${fresh ? "?fresh=true" : ""}`))
  );

  server.registerTool(
    "get_weight_trend_history",
    {
      description:
        "Weight history over time, segmented into loss / gain runs, with the average intake and " +
        "exercise burn during each. Answers 'what has happened over months' -- for the current " +
        "number use get_computed_calorie_target instead.\n\n" +
        "Use this for: am I still losing, when did progress stall, how fast was I losing before, " +
        "plateau or regain periods, long-term trend, what changed between periods.\n\n" +
        "Segment boundaries are a function of the detection settings, not facts. smoothDays " +
        "dominates: a centred average of N days erases swings shorter than about N before " +
        "detection runs, so lower it before lowering thresh. Re-run at two or three settings " +
        "before treating a segment as real.\n\n" +
        "The response includes a `guidance` array of interpretation caveats. Read it before drawing " +
        "conclusions -- in particular, kPerLb (how maintenance scales with body weight) CANNOT be " +
        "fitted from this data and attempting it yields a physiologically impossible negative value.",
      inputSchema: {
        thresh: z.coerce.number().optional().describe("Reversal in lb before a turn counts (default 2.0). Lower = more segments."),
        minWeeks: z.coerce.number().optional().describe("Discard segments shorter than this (default 2)."),
        smoothDays: z.coerce.number().optional().describe("Centred smoothing window before detection (default 28). The dominant knob."),
        dMeasure: z.coerce.number().optional().describe("Analysis exercise discount. Defaults to the stored setting."),
        dTarget: z.coerce.number().optional().describe("Target exercise discount. Defaults to the stored setting."),
        kPerLb: z.coerce.number().optional().describe("Assumed maintenance change per lb. An assumption, not a fit -- see guidance."),
        desiredRate: z.coerce.number().optional().describe("Target lb/week for computing a calorie target."),
      },
    },
    async (args) => {
      const p = new URLSearchParams();
      ["thresh", "minWeeks", "smoothDays", "dMeasure", "dTarget", "kPerLb", "desiredRate"]
        .forEach(function (k) { if (args[k] !== undefined) p.set(k, String(args[k])); });
      const qs = p.toString();
      return ok(await nutritionRequest(`/phases${qs ? "?" + qs : ""}`));
    }
  );

  server.registerTool(
    "nutrition_api",
    {
      description:
        "Read-only escape hatch: GET any Nutrition API endpoint directly, including query parameters that the " +
        "dedicated tools above may not expose yet. Use this when a dedicated tool lacks a filter you need " +
        "(for example a date range or a pagination offset) — it always reflects the current server, whereas the " +
        "dedicated tool schemas are fixed until the connector is reconnected.\n\n" +
        "Call with no endpoint to fetch the OpenAPI spec listing every available path and its parameters.\n\n" +
        "Common paths: /logs (supports date, start_date, end_date, limit, offset), /summaries, /metrics, " +
        "/activities, /goals, /goals/history, /strength/sets, /strength/workouts.\n\n" +
        "List responses are paginated and include `total`, `limit`, and `offset` — check `total` and page with " +
        "`offset` rather than assuming the first page is everything.\n\n" +
        "GET only, so this cannot create, update, or delete anything. Use the dedicated write tools for changes.",
      inputSchema: {
        endpoint: z
          .string()
          .optional()
          .describe(
            "Path with optional query string, e.g. '/logs?start_date=2026-08-01&end_date=2026-08-31&limit=200'. " +
              "Omit to fetch the OpenAPI spec."
          ),
      },
    },
    async ({ endpoint }) => {
      let path = (endpoint ?? "").trim();
      if (path && !path.startsWith("/")) path = `/${path}`;
      // Reject protocol-relative paths so the endpoint cannot be redirected off-host.
      if (path.startsWith("//")) {
        throw new Error("endpoint must be a path on the Nutrition API, e.g. '/logs?limit=10'");
      }
      return ok(await nutritionRequest(path, { method: "GET" }));
    }
  );

  server.registerTool(
    "get_summaries",
    {
      description:
        "Get per-day nutrition summaries, newest-first. Paginated: the reply includes `total`, `limit`, and `offset` — " +
        "page with `offset` when you need history beyond the first page.",
      inputSchema: {
        limit: z.coerce.number().optional().describe("Max items to return (default 50)"),
        offset: z.coerce.number().optional().describe("Items to skip (default 0)"),
      },
    },
    async ({ limit, offset }) => {
      const p = new URLSearchParams();
      if (limit !== undefined) p.set("limit", String(limit));
      if (offset !== undefined) p.set("offset", String(offset));
      const qs = p.toString();
      return ok(await nutritionRequest(`/summaries${qs ? "?" + qs : ""}`));
    }
  );

  server.registerTool(
    "log_weight",
    {
      description: "Log a weight measurement. After logging, call get_weight_history to show the user their recent trend.",
      inputSchema: {
        Date: z.string().describe("Date of measurement in YYYY-MM-DD format"),
        Weight: z.coerce.number().describe("Weight value"),
      },
    },
    async ({ Date, Weight }) =>
      ok(await nutritionRequest("/metrics", { method: "POST", body: JSON.stringify({ Date, Weight }) }))
  );

  server.registerTool(
    "get_weight_history",
    {
      description: "Get weight measurements over time, optionally filtered by date range.",
      inputSchema: {
        start_date: z.string().optional().describe("Start date in YYYY-MM-DD format (default: ~30 days ago)"),
        end_date: z.string().optional().describe("End date in YYYY-MM-DD format (default: today)"),
        limit: z.coerce.number().optional().describe("Max items to return (default 50)"),
        offset: z.coerce.number().optional().describe("Items to skip (default 0)"),
      },
    },
    async ({ start_date, end_date, limit, offset }) => {
      const p = new URLSearchParams();
      if (start_date) p.set("start_date", start_date);
      if (end_date) p.set("end_date", end_date);
      if (limit !== undefined) p.set("limit", String(limit));
      if (offset !== undefined) p.set("offset", String(offset));
      const qs = p.toString();
      return ok(await nutritionRequest(`/metrics${qs ? "?" + qs : ""}`));
    }
  );

  server.registerTool(
    "get_goals",
    {
      description:
        "Get the user's STATED nutrition goals -- the targets they have set for themselves. Call this at the start of any nutrition session so you can compare intake against targets. For what their data says the target SHOULD be, use get_computed_calorie_target and compare the two.\n\n" +
        "How goals work: each goal field is tracked independently, and each entry is dated. This endpoint returns the MOST RECENT value for each field. " +
        "Numeric fields (kcal, protein, fat, carbs, fiber, added_sugar, alcohol) are daily gram/calorie targets. " +
        "NutritionGoal, WeightGoal, and OtherGoal are free-text — use them for qualitative or computed goals that don't reduce to a single daily number " +
        "(e.g. \"14g fiber per 1000 kcal\"), and read Notes for caveats. " +
        "A field whose value is \"" + GOAL_UNSET + "\" has been intentionally untracked — treat it as \"no goal\", not zero.",
    },
    async () => ok(await nutritionRequest("/goals"))
  );

  server.registerTool(
    "get_goal_history",
    {
      description:
        "Get the history of past nutrition goal changes over time. Each row is a dated entry; blank fields were not touched by that entry. " +
        "Paginated: the reply includes `total`, `limit`, and `offset`.",
      inputSchema: {
        limit: z.coerce.number().optional().describe("Max items to return (default 50)"),
        offset: z.coerce.number().optional().describe("Items to skip (default 0)"),
      },
    },
    async ({ limit, offset }) => {
      const p = new URLSearchParams();
      if (limit !== undefined) p.set("limit", String(limit));
      if (offset !== undefined) p.set("offset", String(offset));
      const qs = p.toString();
      return ok(await nutritionRequest(`/goals/history${qs ? "?" + qs : ""}`));
    }
  );

  server.registerTool(
    "update_goals",
    {
      description:
        "Set or change the user's nutrition goals. Only include the fields you want to change — omitted fields keep their current value. " +
        "This appends a new dated entry, so partial updates are fine and fully expected. " +
        "Use the numeric fields for daily targets. Use NutritionGoal / WeightGoal / OtherGoal for qualitative or computed goals stated in plain language, " +
        "and Notes for any caveats an agent should know when reporting progress. " +
        "To stop tracking a goal, pass its name in `clear` (do NOT set it to 0).",
      inputSchema: {
        kcal: z.coerce.number().optional().describe("Daily calorie target"),
        protein: z.coerce.number().optional().describe("Daily protein target in grams"),
        fat: z.coerce.number().optional().describe("Daily fat target in grams"),
        carbs: z.coerce.number().optional().describe("Daily carbohydrate target in grams"),
        fiber: z.coerce.number().optional().describe("Daily fiber target in grams"),
        added_sugar: z.coerce.number().optional().describe("Daily added sugar target in grams"),
        alcohol: z.coerce.number().optional().describe("Daily alcohol target in grams"),
        NutritionGoal: z.string().optional().describe("Free-text nutrition goal, e.g. \"14g fiber per 1000 kcal gross intake\""),
        WeightGoal: z.string().optional().describe("Free-text weight goal"),
        OtherGoal: z.string().optional().describe("Free-text catch-all goal"),
        Notes: z.string().optional().describe("Caveats / context for interpreting the goals above"),
        clear: jsonParsed(
          z.array(
            z.enum([
              "kcal",
              "protein",
              "fat",
              "carbs",
              "fiber",
              "added_sugar",
              "alcohol",
              "NutritionGoal",
              "WeightGoal",
              "OtherGoal",
              "Notes",
            ])
          )
        )
          .optional()
          .describe("Goal fields to stop tracking. Writes a \"" + GOAL_UNSET + "\" marker so it overrides any earlier value."),
      },
    },
    async (fields) => {
      const { clear, ...rest } = fields;
      // ISO timestamp (not a bare date) so a same-day correction sorts after the
      // entry it replaces in the GAS "latest value wins per field" logic.
      const body = { Date: new Date().toISOString() };
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) body[k] = v;
      }
      for (const f of clear ?? []) {
        body[f] = GOAL_UNSET;
      }
      return ok(await nutritionRequest("/goals", { method: "POST", body: JSON.stringify(body) }));
    }
  );

  server.registerTool(
    "update_log",
    {
      description: "Update an existing food log entry. Use get_recent_logs first to find the entry ID.",
      inputSchema: {
        ID: z.string().describe("The ID of the log entry to update"),
        Food: z.string().optional(),
        Description: z.string().optional(),
        Meal: z.string().optional(),
        kcal: z.coerce.number().optional(),
        protein: z.coerce.number().optional(),
        fat: z.coerce.number().optional(),
        carbs: z.coerce.number().optional(),
        added_sugar: z.coerce.number().optional(),
        fiber: z.coerce.number().optional(),
        alcohol: z.coerce.number().optional(),
        Date: z.string().optional().describe("Updated date in YYYY-MM-DD format"),
      },
    },
    async (args) => {
      const { ID, ...rest } = args;
      const body = { ID };
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) body[k] = v;
      }
      return ok(await nutritionRequest("/log", { method: "PUT", body: JSON.stringify(body) }));
    }
  );

  server.registerTool(
    "delete_log",
    {
      description: "Delete a food log entry. Use get_recent_logs first to find the entry ID.",
      inputSchema: { ID: z.string().describe("The ID of the log entry to delete") },
    },
    async ({ ID }) =>
      ok(await nutritionRequest("/log", { method: "DELETE", body: JSON.stringify({ ID }) }))
  );

  server.registerTool(
    "log_activity",
    {
      description: "Record a completed activity to CREDIT calories/carbs toward the nutrition day (e.g. a big untracked step day at a convention, or an untracked walk/hike). This is the calorie-credit path. For a manual entry set Source='manual' and an ActivityKey like 'manual:2026-07-05-walk' for idempotency; Source/SourceID matter mainly for automated syncs. Use positive TotalKcal and CarbGrams. Do NOT use this if a watch/Strava already synced the same activity — the credit would double-count. To record a strength session for volume/history WITHOUT calorie credit, use log_manual_strength instead.",
      inputSchema: {
        ActivityKey: z.string().optional().describe("Stable key, e.g. strava:123 or manual:2026-05-30-walk"),
        Date: z.string().describe("Activity date in YYYY-MM-DD format"),
        Type: z.string().optional().describe("Activity type, e.g. Ride, Walk, Hike, Strength"),
        Name: z.string().describe("Activity name"),
        Description: z.string().optional(),
        TotalKcal: z.coerce.number().optional().describe("Positive total calories burned"),
        CarbGrams: z.coerce.number().optional().describe("Positive grams of carbohydrate burned"),
        CreditOverrideKcal: z.coerce.number().optional().describe("Optional explicit credit override; normally leave blank so Settings controls credit"),
        Source: z.string().optional().describe("Source system, e.g. manual, strava, speediance, xert"),
        SourceID: z.string().optional().describe("Stable source ID"),
        StravaID: z.string().optional(),
        XertID: z.string().optional(),
        SpeedianceID: z.string().optional(),
        Review: z.string().optional().describe("ok, needs_review, duplicate, ignore, legacy_only, source_matched"),
        DistanceMeters: z.coerce.number().optional(),
        DurationSec: z.coerce.number().optional(),
      },
    },
    async (fields) => {
      const body = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) body[k] = v;
      }
      return ok(await nutritionRequest("/activities", { method: "POST", body: JSON.stringify(body) }));
    }
  );

  server.registerTool(
    "get_activities",
    {
      description: "Get activity rows (all sources: Strava, Xert, Speediance, manual), optionally filtered by date, date range, or Review status. Results are newest-first. Returns every activity type — rides, walks, hikes, weight training, paddling — so use this, not the ride-specific tools, when summarizing overall training load for a period.",
      inputSchema: {
        date: z.string().optional().describe("Specific date in YYYY-MM-DD format"),
        start_date: z.string().optional().describe("Start date in YYYY-MM-DD format"),
        end_date: z.string().optional().describe("End date in YYYY-MM-DD format"),
        review: z.string().optional().describe("Review value to filter, e.g. needs_review"),
        limit: z.coerce.number().optional(),
        offset: z.coerce.number().optional(),
        include_raw: z.coerce.boolean().optional().describe("Include the RawJSON source payload for each row. Defaults to false. Each Strava payload is 4-45KB, so a single week can exceed the response size limit — only turn this on when debugging the sync itself for a handful of specific rows."),
      },
    },
    async ({ date, start_date, end_date, review, limit, offset, include_raw }) => {
      const p = new URLSearchParams();
      if (date) p.set("date", date);
      if (start_date) p.set("start_date", start_date);
      if (end_date) p.set("end_date", end_date);
      if (review) p.set("review", review);
      if (limit !== undefined) p.set("limit", String(limit));
      if (offset !== undefined) p.set("offset", String(offset));
      if (include_raw) p.set("include_raw", "true");
      const qs = p.toString();
      return ok(await nutritionRequest(`/activities${qs ? "?" + qs : ""}`));
    }
  );

  server.registerTool(
    "delete_activity",
    {
      description: "Delete an activity by ActivityKey. Use get_activities first if unsure.",
      inputSchema: { ActivityKey: z.string().describe("The activity key to delete") },
    },
    async ({ ActivityKey }) =>
      ok(await nutritionRequest("/activities", { method: "DELETE", body: JSON.stringify({ ActivityKey }) }))
  );

  server.registerTool(
    "update_activity",
    {
      description: "Update fields on an existing activity row (partial update). Identify the row by ActivityKey; ONLY the fields you pass are changed, everything else is preserved. Use get_activities first to find the ActivityKey. Common uses: fix a wrong calorie/carb estimate, correct the date/type/name, or mark a row as a duplicate via Review. To remove an activity entirely, use delete_activity instead. (If the ActivityKey doesn't exist, the backend will create it, so double-check the key.)",
      inputSchema: {
        ActivityKey: z.string().describe("Stable key identifying the activity to update, e.g. strava:123 or manual:2026-05-30-walk. Get it from get_activities."),
        Date: z.string().optional().describe("Activity date in YYYY-MM-DD format"),
        Type: z.string().optional().describe("Activity type, e.g. Ride, Walk, Hike, Strength"),
        Name: z.string().optional().describe("Activity name"),
        Description: z.string().optional(),
        TotalKcal: z.coerce.number().optional().describe("Positive total calories burned"),
        CarbGrams: z.coerce.number().optional().describe("Positive grams of carbohydrate burned"),
        CreditOverrideKcal: z.coerce.number().optional().describe("Explicit credit override; normally leave blank so Settings controls credit"),
        Review: z.string().optional().describe("ok, needs_review, duplicate, ignore, legacy_only, source_matched"),
        ReviewNote: z.string().optional(),
        DistanceMeters: z.coerce.number().optional(),
        DurationSec: z.coerce.number().optional(),
      },
    },
    async (fields) => {
      // DisableLegacyMatch keeps this a precise key-targeted update — no fuzzy
      // legacy matching. The GAS upsert changes only the fields we send.
      const body = { DisableLegacyMatch: true };
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) body[k] = v;
      }
      return ok(await nutritionRequest("/activities", { method: "POST", body: JSON.stringify(body) }));
    }
  );

  server.registerTool(
    "get_nutrition_settings",
    {
      description: "Get nutrition calculation settings such as activity_credit_mode and activity_credit_rate.",
      inputSchema: { key: z.string().optional().describe("Optional setting key") },
    },
    async ({ key }) => ok(await nutritionRequest(key ? `/settings?key=${encodeURIComponent(key)}` : "/settings"))
  );

  server.registerTool(
    "update_nutrition_settings",
    {
      description: "Update nutrition calculation settings. Use activity_credit_mode percent_total/carb_only/none and activity_credit_rate such as 0.5.",
      inputSchema: {
        activity_credit_mode: z.enum(["percent_total", "carb_only", "none"]).optional(),
        activity_credit_rate: z.coerce.number().optional(),
        carb_kcal_per_gram: z.coerce.number().optional(),
        target_loss_rate_lb_per_week: z.coerce.number().optional(),
      },
    },
    async (fields) => {
      const settings = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) settings[k] = v;
      }
      return ok(await nutritionRequest("/settings", { method: "POST", body: JSON.stringify({ settings }) }));
    }
  );

  // -------------------------------------------------------------------------
  // Strava sync diagnostics
  // -------------------------------------------------------------------------

  server.registerTool(
    "get_strava_sync_status",
    {
      description: "Inspect Strava -> Nutrition sync health, including token/cursor state and the last recorded sync result. Use this first when the user asks whether Strava sync is running or why an activity may not have synced.",
    },
    async () => ok(await stravaSyncRequest("/sync/status"))
  );

  server.registerTool(
    "diagnose_strava_activity_sync",
    {
      description: "Read-only Strava sync diagnostic. Dry-runs recent Strava activity fetches and compares returned Strava IDs with Nutrition Activities rows for a date. Does not post activities or advance the sync cursor.",
      inputSchema: {
        date: z.string().optional().describe("Nutrition activity date to compare in YYYY-MM-DD format. Defaults to today in the Nutrition sheet timezone if omitted by the caller."),
        days: z.coerce.number().optional().default(1).describe("How many days of recent Strava activity to dry-run fetch"),
        maxPages: z.coerce.number().optional().default(2).describe("Maximum Strava activity pages to fetch during the dry run"),
      },
    },
    async ({ date, days, maxPages }) => {
      const targetDate = date || localDateString();
      const dryRunParams = new URLSearchParams();
      dryRunParams.set("dryRun", "1");
      dryRunParams.set("includeIds", "1");
      dryRunParams.set("days", String(days || 1));
      dryRunParams.set("maxPages", String(maxPages || 2));

      const activityParams = new URLSearchParams();
      activityParams.set("date", targetDate);
      activityParams.set("limit", "100");

      const [status, dryRun, nutritionActivities] = await Promise.all([
        stravaSyncRequest("/sync/status"),
        stravaSyncRequest(`/sync?${dryRunParams.toString()}`),
        nutritionRequest(`/activities${activityParams.toString() ? "?" + activityParams.toString() : ""}`),
      ]);

      const stravaIds = Array.isArray(dryRun.ids)
        ? dryRun.ids.map(String)
        : (Array.isArray(dryRun.idSamples) ? dryRun.idSamples.map(String) : []);
      const nutritionItems = Array.isArray(nutritionActivities.items) ? nutritionActivities.items : [];
      const nutritionStravaIds = new Set(nutritionItems
        .map(item => item.StravaID || item.SourceID || String(item.ActivityKey || "").replace(/^strava:/, ""))
        .filter(Boolean)
        .map(String));
      const missingFromNutrition = stravaIds.filter(id => !nutritionStravaIds.has(id));

      return ok({
        status,
        dryRun: {
          runId: dryRun.runId,
          fetched: dryRun.fetched,
          after: dryRun.after,
          before: dryRun.before,
          ids: stravaIds,
        },
        nutritionActivities: {
          date: targetDate,
          total: nutritionActivities.total,
          stravaIds: Array.from(nutritionStravaIds),
          items: nutritionItems.map(item => ({
            ActivityKey: item.ActivityKey,
            StravaID: item.StravaID,
            SourceID: item.SourceID,
            StartTime: item.StartTime,
            Name: item.Name,
            TotalKcal: item.TotalKcal,
            CarbGrams: item.CarbGrams,
            Review: item.Review,
            UpdatedAt: item.UpdatedAt,
          })),
        },
        missingFromNutrition,
      });
    }
  );

  server.registerTool(
    "retry_strava_sync",
    {
      description: "Manually run Strava -> Nutrition sync. This can write/update Nutrition Activities rows and advance the sync cursor. Use only when the user explicitly asks to retry or force a sync.",
      inputSchema: {
        days: z.coerce.number().optional().default(1).describe("How many days of Strava activity to fetch and post"),
        maxPages: z.coerce.number().optional().default(2).describe("Maximum Strava activity pages to fetch"),
        review: z.string().optional().describe("Optional Review value to set on posted activities"),
      },
    },
    async ({ days, maxPages, review }) => {
      const params = new URLSearchParams();
      params.set("days", String(days || 1));
      params.set("maxPages", String(maxPages || 2));
      if (review) params.set("review", review);
      return ok(await stravaSyncRequest(`/sync?${params.toString()}`, { method: "POST" }));
    }
  );

  server.registerTool(
    "upsert_weight",
    {
      description: "Correct or create a weight entry for a date. Prefer this over log_weight when fixing an incorrect agent-entered weight.",
      inputSchema: {
        Date: z.string().describe("Date in YYYY-MM-DD format"),
        Weight: z.coerce.number().describe("Correct weight value"),
        Notes: z.string().optional(),
      },
    },
    async ({ Date, Weight, Notes }) => {
      const body = { action: "upsert", Date, Weight };
      if (Notes !== undefined) body.Notes = Notes;
      return ok(await nutritionRequest("/metrics", { method: "POST", body: JSON.stringify(body) }));
    }
  );

  server.registerTool(
    "delete_weight",
    {
      description: "Delete weight/metric rows for a date. Include Weight to narrow deletion when multiple entries exist.",
      inputSchema: {
        Date: z.string().describe("Date in YYYY-MM-DD format"),
        Weight: z.coerce.number().optional().describe("Optional exact weight value to narrow deletion"),
      },
    },
    async ({ Date, Weight }) => {
      const body = { action: "delete", Date };
      if (Weight !== undefined) body.Weight = Weight;
      return ok(await nutritionRequest("/metrics", { method: "POST", body: JSON.stringify(body) }));
    }
  );

  server.registerTool(
    "list_strength_workouts",
    {
      description: "List strength workout summaries, newest first. This is the primary source of truth for what strength sessions the user actually did — it covers BOTH machine-ingested and hand-logged sessions. Prefer it over any Speediance tool. Dates are YYYY-MM-DD and the range bounds are inclusive; omit them to get the most recent sessions.",
      inputSchema: {
        startDate: z.string().optional().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().optional().describe("End date in YYYY-MM-DD format"),
        limit: z.coerce.number().optional().describe("Max items to return (default 50)"),
        offset: z.coerce.number().optional().describe("Items to skip (default 0)"),
      },
    },
    async ({ startDate, endDate, limit, offset }) => {
      const p = new URLSearchParams();
      if (startDate) p.set("startDate", startDate);
      if (endDate) p.set("endDate", endDate);
      if (limit !== undefined) p.set("limit", String(limit));
      if (offset !== undefined) p.set("offset", String(offset));
      const qs = p.toString();
      return ok(await nutritionRequest(`/strength/workouts${qs ? "?" + qs : ""}`));
    }
  );

  server.registerTool(
    "get_strength_workout",
    {
      description: "Get a single strength workout and all its sets by workout ID",
      inputSchema: { id: z.coerce.number().describe("The workout ID") },
    },
    async ({ id }) => ok(await nutritionRequest(`/strength/workout?id=${id}`))
  );

  server.registerTool(
    "get_strength_sets",
    {
      description: "Query strength set rows filtered by time window, body focus, movement type, or exercise name. Use for exercise history and progress analysis.",
      inputSchema: {
        daysBack: z.coerce.number().optional().describe("How many days back to include (default 365)"),
        focus: z.string().optional().describe("Comma-separated body parts: quads, hams (or hamstrings), glutes, chest, back, shoulders, arms, core, calves"),
        movement: z.string().optional().describe("Partial match against movement type, e.g. 'Squat'"),
        exercise: z.string().optional().describe("Partial, case-insensitive match against exercise name"),
        limit: z.coerce.number().optional().describe("Max items to return (default 50)"),
        offset: z.coerce.number().optional().describe("Items to skip (default 0)"),
      },
    },
    async ({ daysBack, focus, movement, exercise, limit, offset }) => {
      const p = new URLSearchParams();
      if (daysBack !== undefined) p.set("daysBack", String(daysBack));
      if (focus) p.set("focus", focus);
      if (movement) p.set("movement", movement);
      if (exercise) p.set("exercise", exercise);
      if (limit !== undefined) p.set("limit", String(limit));
      if (offset !== undefined) p.set("offset", String(offset));
      const qs = p.toString();
      return ok(await nutritionRequest(`/strength/sets${qs ? "?" + qs : ""}`));
    }
  );

  server.registerTool(
    "list_strength_exercises",
    {
      description: "List all distinct exercises recorded in strength workouts",
      inputSchema: {
        limit: z.coerce.number().optional().describe("Max items to return (default 50)"),
        offset: z.coerce.number().optional().describe("Items to skip (default 0)"),
      },
    },
    async ({ limit, offset }) => {
      const p = new URLSearchParams();
      if (limit !== undefined) p.set("limit", String(limit));
      if (offset !== undefined) p.set("offset", String(offset));
      const qs = p.toString();
      return ok(await nutritionRequest(`/strength/exercises${qs ? "?" + qs : ""}`));
    }
  );

  server.registerTool(
    "get_strength_today",
    {
      description: "Get strength workouts completed in the last 24 hours",
      inputSchema: {
        limit: z.coerce.number().optional().describe("Max items to return (default 50)"),
        offset: z.coerce.number().optional().describe("Items to skip (default 0)"),
      },
    },
    async ({ limit, offset }) => {
      const p = new URLSearchParams();
      if (limit !== undefined) p.set("limit", String(limit));
      if (offset !== undefined) p.set("offset", String(offset));
      const qs = p.toString();
      return ok(await nutritionRequest(`/strength/today${qs ? "?" + qs : ""}`));
    }
  );

  server.registerTool(
    "get_exercise_data",
    {
      description: "Get all set rows for a specific exercise by ID or name, for progress tracking",
      inputSchema: {
        exerciseId: z.string().optional().describe("Exercise ID"),
        exerciseName: z.string().optional().describe("Exercise name (partial match)"),
        limit: z.coerce.number().optional().describe("Max items to return (default 50)"),
        offset: z.coerce.number().optional().describe("Items to skip (default 0)"),
      },
    },
    async ({ exerciseId, exerciseName, limit, offset }) => {
      const p = new URLSearchParams();
      if (exerciseId) p.set("exerciseId", exerciseId);
      if (exerciseName) p.set("exerciseName", exerciseName);
      if (limit !== undefined) p.set("limit", String(limit));
      if (offset !== undefined) p.set("offset", String(offset));
      const qs = p.toString();
      return ok(await nutritionRequest(`/strength/exerciseData${qs ? "?" + qs : ""}`));
    }
  );

  server.registerTool(
    "log_strength_workout",
    {
      description: "Ingest a raw Speediance workout payload (StrengthIngestWrapper format with 'data' property, or raw workout object) into strength HISTORY. This is the machine-export ingestion path and is rarely the right tool now that the Speediance app is out of use — it exists for automated syncs replaying a captured payload. To log a session the user describes in words (exercise names, sets, reps), use log_manual_strength instead. NOTE: strength logging records volume/history only and does NOT credit calories to the nutrition day.",
      inputSchema: { workoutData: z.string().describe("JSON string of the Speediance workout payload") },
    },
    async ({ workoutData }) =>
      ok(await nutritionRequest("/logStrengthWorkout", {
        method: "POST",
        body: JSON.stringify(JSON.parse(workoutData)),
      }))
  );

  server.registerTool(
    "log_manual_strength",
    {
      description: `Record a completed strength session described in plain terms (exercise names, sets, reps, optional weight/hold time) into strength HISTORY for volume and progress tracking (e.g. "how much pec work this month"). Queryable afterward via get_strength_sets / get_exercise_data by exercise name.

IMPORTANT — this does NOT credit calories to the nutrition day. Use it when a watch/Strava tracked (or will track) the workout and the calorie burn will arrive automatically via Strava sync, OR when you only care about tracking muscle work. If the activity was NOT tracked by any device and the user wants calorie credit, use log_activity instead (and do not double-log the same session in both if a device already supplied the burn).

For a circuit repeated N times, multiply into sets: a circuit of 8 push-ups done 3 times = one exercise "Push-ups" with sets=3, reps=8.`,
      inputSchema: {
        date: z.string().describe("Workout date in YYYY-MM-DD format"),
        name: z.string().optional().describe("Session name, e.g. 'Hotel bodyweight circuit'"),
        calories: z.coerce.number().optional().describe("Optional calorie estimate. Stored in strength history only for reference — NEVER credited to the nutrition day."),
        exercises: jsonParsed(z.array(z.object({
          name: z.string().describe("Exercise name, e.g. 'Push-ups', 'Wall sit', 'Bodyweight squat'"),
          sets: z.coerce.number().optional().describe("Number of sets performed (default 1)"),
          reps: z.coerce.number().optional().describe("Reps per set. Omit for a purely timed hold."),
          weight: z.coerce.number().optional().describe("Weight per rep in the user's usual unit. Omit for bodyweight."),
          time: z.coerce.number().optional().describe("Duration per set in seconds, for timed holds like a wall sit."),
          muscles: jsonParsed(z.array(z.string())).optional().describe(`Muscles this exercise works, e.g. ["arms"] for a curl or ["quads","glutes"] for a squat. STRONGLY RECOMMENDED: without it the exercise gets no body-focus tags, so it stays invisible to get_strength_sets(focus=...) and to any "how much arm work this month" analysis. Accepted: quads, hams, glutes, chest, back, shoulders, arms, core, calves (synonyms like biceps/abs/lats also work). List the main muscle first. Only fills blanks - never overwrites an existing classification.`),
        }))).describe("Exercises performed, in order"),
      },
    },
    async ({ date, name, calories, exercises }) => {
      const day = String(date || "").slice(0, 10);
      // Noon UTC keeps the calendar date stable across US timezones when the
      // GAS side reformats endTimestamp back to yyyy-MM-dd.
      const ts = Math.floor(new Date(`${day}T12:00:00Z`).getTime() / 1000);
      const workoutId = `manual-${day}-${Math.random().toString(36).slice(2, 8)}`;
      const list = (exercises || []).map((ex, exIdx) => {
        const setCount = ex.sets && ex.sets > 0 ? Math.round(ex.sets) : 1;
        const finishedReps = [];
        for (let i = 0; i < setCount; i++) {
          const set = { ix: i + 1, isFinish: true };
          if (ex.reps !== undefined) { set.finishedCount = ex.reps; set.targetCount = ex.reps; }
          if (ex.time !== undefined) set.time = ex.time;
          if (ex.weight !== undefined) { set.avgWeight = ex.weight; set.weightDetail = String(ex.weight); }
          finishedReps.push(set);
        }
        // primaryMuscles is the field the GAS ingest path already reads to
        // auto-populate the ExerciseMapping sheet, so passing it through here
        // makes a hand-logged exercise tag itself exactly like a machine
        // upload does. Omitted when absent so nothing is written blank.
        const entry = {
          id: `${workoutId}-ex${exIdx + 1}`,
          actionLibraryName: ex.name,
          maxWeight: ex.weight,
          avgWeight: ex.weight,
          finishedReps,
        };
        if (ex.muscles && ex.muscles.length) entry.primaryMuscles = ex.muscles;
        return entry;
      });
      const payload = {
        data: {
          id: workoutId,
          templateName: name || "Manual strength workout",
          startTimestamp: ts,
          endTimestamp: ts,
          calorie: calories,
          trainingCount: list.length,
          cttActionLibraryTrainingInfoList: list,
        },
      };
      return ok(await nutritionRequest("/logStrengthWorkout", {
        method: "POST",
        body: JSON.stringify(payload),
      }));
    }
  );


  // Muscle tagging -----------------------------------------------------------
  // The ExerciseMapping sheet is what gives every strength SET its body-focus
  // columns: the Sets sheet resolves them by exercise name at read time, so
  // tagging an exercise here retroactively categorizes every set ever logged
  // under that name. No backfill step exists or is needed.

  server.registerTool(
    "list_uncategorized_exercises",
    {
      description: `List exercises that appear in strength history but carry NO body-focus tags, so they are invisible to get_strength_sets(focus=...) and to any "how much arm work this month" style analysis. Ordered most-used first.

This is the worklist for tagging: call it, then call tag_exercise_muscles once per exercise. Because the sheet resolves focus columns by exercise name at read time, tagging an exercise fixes ALL of its past sets too - there is no backfill to run afterward.

Hand-logged sessions (log_manual_strength without muscles) are the usual reason something shows up here.`,
      inputSchema: {
        includeCategorized: z.coerce.boolean().optional().describe("Also return already-tagged exercises, each with its current tags and status. Default false."),
        daysBack: z.coerce.number().optional().describe("Only consider exercises with sets logged in the last N days. Omit to consider all history."),
        limit: z.coerce.number().optional(),
        offset: z.coerce.number().optional(),
      },
    },
    async ({ includeCategorized, daysBack, limit, offset }) => {
      const p = new URLSearchParams();
      if (includeCategorized) p.set("includeCategorized", "true");
      if (daysBack !== undefined) p.set("daysBack", String(daysBack));
      if (limit !== undefined) p.set("limit", String(limit));
      if (offset !== undefined) p.set("offset", String(offset));
      const qs = p.toString();
      return ok(await nutritionRequest(`/strength/exercises/uncategorized${qs ? "?" + qs : ""}`));
    }
  );

  server.registerTool(
    "tag_exercise_muscles",
    {
      description: `Classify one exercise by the muscles it works, so its sets become findable via get_strength_sets(focus=...). Keyed by exercise name, and applies retroactively to every set already logged under that name.

Accepted muscle terms: quads, hams (hamstrings), glutes, chest, back, shoulders, arms, core, calves - plus common synonyms (biceps, triceps, abs, lats, delts, pecs, quadriceps...). Anything unrecognized is reported back in ignoredMuscles rather than applied, so check the response.

SAFE: only blank cells are ever filled. An existing classification - including one the user corrected by hand - is never overwritten, so re-tagging cannot clobber their work. If the response says nothing was written, the exercise was already classified.

Use list_uncategorized_exercises to find what needs this.`,
      inputSchema: {
        exerciseName: z.string().describe("Exact exercise name as it appears in strength history, e.g. 'Suitcase-to-Curl (barbell)'. Get it from list_uncategorized_exercises."),
        primaryMuscles: jsonParsed(z.array(z.string())).describe(`Muscles this exercise mainly works. The first one determines Main Focus. e.g. ["arms"] for a curl.`),
        secondaryMuscles: jsonParsed(z.array(z.string())).optional().describe(`Muscles worked secondarily, e.g. ["core", "back"] for a suitcase carry variant. These get focus flags but do not set Main Focus.`),
      },
    },
    async ({ exerciseName, primaryMuscles, secondaryMuscles }) => {
      const body = { exerciseName, primaryMuscles };
      if (secondaryMuscles !== undefined) body.secondaryMuscles = secondaryMuscles;
      return ok(await nutritionRequest("/upsertExerciseMapping", {
        method: "POST",
        body: JSON.stringify(body),
      }));
    }
  );

  // -------------------------------------------------------------------------
  // Speediance tools - DEPRECATED / DORMANT
  // -------------------------------------------------------------------------
  // The vendor app broke, so the machine is not in active use. Everything here
  // is kept wired up (and working) in case the vendor fixes it, but each tool
  // description carries the deprecatedSpeediance() banner so agents prefer the
  // direct strength tools. If the machine comes back into use, drop the
  // deprecatedSpeediance() wrappers below and that preference disappears.
  // Device type note: exercise listings always use Gym Monster (deviceType=1)
  // because this user's pulley setup lets them use GM movements. All workout
  // templates and scheduling target Gym Pal (deviceType=2). This is baked into
  // the proxy — the MCP tools don't need to specify device type.

  server.registerTool(
    "list_exercises",
    {
      description: deprecatedSpeediance("List the Speediance exercise library, grouped by category and muscle group. Each exercise entry includes its name and groupId. IMPORTANT: groupId alone is not enough to build a workout — you also need an actionLibraryId, which is a separate value only available via get_exercise_detail(groupId). Alternatively, use create_speediance_workout (by name) to skip the ID lookup entirely."),
    },
    async () => ok(await spedianceRequest("/exercises"))
  );

  server.registerTool(
    "get_exercise_detail",
    {
      description: deprecatedSpeediance("Get full detail for one exercise group, including the actionLibraryList — the source of valid actionLibraryId values required by save_speediance_workout. Pick the first entry where isDisplay=1, or the first entry if none are marked. The groupId parameter is the id field from list_exercises."),
      inputSchema: { groupId: z.coerce.number().describe("The exercise groupId (the 'id' field from list_exercises)") },
    },
    async ({ groupId }) => ok(await spedianceRequest(`/exercise/${groupId}`))
  );

  server.registerTool(
    "list_speediance_workouts",
    {
      description: deprecatedSpeediance("List the user's saved custom Speediance workout templates."),
    },
    async () => ok(await spedianceRequest("/workouts"))
  );

  server.registerTool(
    "get_speediance_workout",
    {
      description: deprecatedSpeediance("Get the full detail of a saved Speediance workout template by its code."),
      inputSchema: { code: z.string().describe("The template code from list_speediance_workouts") },
    },
    async ({ code }) => ok(await spedianceRequest(`/workout/${code}`))
  );

  server.registerTool(
    "save_speediance_workout",
    {
      description: deprecatedSpeediance(`Create a new Speediance workout template. groupId and actionLibraryId are NOT the same value and cannot be guessed or duplicated from each other. Required workflow:
1. Call list_exercises → get groupId for the exercise
2. Call get_exercise_detail(groupId) → pick an actionLibraryId from actionLibraryList (prefer isDisplay=1, or first entry). Also read isLeftRight from the detail root (1 = unilateral/single-arm, 0 = bilateral).
Shortcut: existing templates from list_speediance_workouts contain confirmed working {groupId, actionLibraryId} pairs you can reuse.
Alternatively, use create_speediance_workout to build a workout by exercise name — it handles isLeftRight automatically.

IMPORTANT: pass isLeftRight: 1 for any single-arm/single-leg exercise (check isLeftRight field in get_exercise_detail). Omitting it for a unilateral exercise will cause a Speediance API error.

Modes:
- "hypertrophy": 3 sets × 12 reps @ 13RM, 60s rest (default for muscle building)
- "strength":    5 sets × 5 reps  @ 6RM,  90s rest (default for strength)
- "custom":      you specify sets, reps, weight (lbs), and rest
For hypertrophy/strength you can override sets and rest; reps and RM are fixed by the mode.`),
      inputSchema: {
        name: z.string().describe("Workout name"),
        exercises: jsonParsed(z.array(z.object({
          groupId:         z.coerce.number().describe("Exercise group ID from the library"),
          actionLibraryId: z.coerce.number().describe("Specific action/variant ID from exercise detail"),
          mode:            z.enum(["hypertrophy", "strength", "custom"]).describe("Training mode"),
          isLeftRight:     z.coerce.number().optional().describe("1 for single-arm/single-leg exercises, 0 (default) for bilateral. Check isLeftRight in get_exercise_detail."),
          sets:            z.coerce.number().optional().describe("Override number of sets (default: 3 for hypertrophy, 5 for strength)"),
          rest:            z.coerce.number().optional().describe("Override rest time in seconds (default: 60 for hypertrophy, 90 for strength)"),
          reps:            z.coerce.number().optional().describe("(custom only) Reps per set"),
          weight:          z.coerce.number().optional().describe("(custom only) Weight in lbs"),
        }))).describe("List of exercises in order"),
      },
    },
    async ({ name, exercises }) =>
      ok(await spedianceRequest("/workout", {
        method: "POST",
        body: JSON.stringify({ name, exercises }),
      }))
  );

  server.registerTool(
    "create_speediance_workout",
    {
      description: deprecatedSpeediance(`Build a Speediance workout TEMPLATE on the machine — a plan to perform later. This does NOT record a completed workout and writes nothing to nutrition or strength history. To log a session you already did, use log_manual_strength (history) and/or log_activity (calorie credit).

Each exercise uses EITHER "name" (keyword search) OR "groupId" (direct ID) — not both.

RECOMMENDED FLOW:
1. Try name keywords first. If you get a "Multiple exercises match" error, the error lists each candidate as {"groupId": <id>} — copy the right one and replace your {"name":"..."} with {"groupId": <id>} in the next call.
2. If you already know the groupId (from list_exercises, get_exercise_detail, or a previous error), skip name search and pass groupId directly.

NAME KEYWORD RULES (when using "name"):
- ALL words must appear in the library exercise name — be specific.
- Include: attachment (barbell / dual-handle / rope / single-arm), position (standing / seated / kneeling / incline / supine), grip (overhand / wide-grip / close-grip).
- On ambiguity: error shows candidates as {"groupId": N} — use groupId on retry instead of guessing more keywords.
- On no match: error shows closest partial matches as {"groupId": N} — use those or adjust keywords.

USING groupId (when using "groupId"):
- Pass the number directly, e.g. {"groupId": 294, "mode": "hypertrophy"}.
- Bypasses name matching entirely. Always works if the ID is valid.

Modes:
- "hypertrophy": 3 sets × 12 reps @ 13RM, 60s rest
- "strength":    5 sets × 5 reps  @ 6RM,  90s rest
- "custom":      you specify sets, reps, weight (lbs), and rest`),
      inputSchema: {
        name: z.string().describe("Workout name"),
        exercises: jsonParsed(z.array(z.object({
          name:    z.string().optional().describe("Space-separated keywords — ALL must appear in the library exercise name. Include attachment, position, grip. Omit if using groupId."),
          groupId: z.coerce.number().optional().describe("Direct groupId from list_exercises or an error response. Bypasses name matching. Omit if using name."),
          mode:    z.enum(["hypertrophy", "strength", "custom"]).describe("Training mode"),
          sets:    z.coerce.number().optional().describe("Override number of sets"),
          rest:    z.coerce.number().optional().describe("Override rest time in seconds"),
          reps:    z.coerce.number().optional().describe("(custom only) Reps per set"),
          weight:  z.coerce.number().optional().describe("(custom only) Weight in lbs"),
        }))).describe("List of exercises in order"),
      },
    },
    async ({ name, exercises }) =>
      ok(await spedianceRequest("/workout/byname", {
        method: "POST",
        body: JSON.stringify({ name, exercises }),
      }))
  );

  server.registerTool(
    "delete_speediance_workout",
    {
      description: deprecatedSpeediance("Delete a saved Speediance workout template by its numeric ID. Use list_speediance_workouts to find the ID first."),
      inputSchema: { id: z.coerce.number().describe("The template ID to delete") },
    },
    async ({ id }) => ok(await spedianceRequest(`/workout/${id}`, { method: "DELETE" }))
  );

  server.registerTool(
    "get_speediance_calendar",
    {
      description: deprecatedSpeediance("Get the Speediance training calendar for a given month, showing scheduled and completed workouts."),
      inputSchema: { month: z.string().describe("Month in YYYY-MM format (defaults to current month if omitted)").optional() },
    },
    async ({ month }) => ok(await spedianceRequest(month ? `/calendar?month=${month}` : "/calendar"))
  );

  server.registerTool(
    "schedule_speediance_workout",
    {
      description: deprecatedSpeediance("Schedule a Speediance workout template on a specific date."),
      inputSchema: {
        templateCode: z.string().describe("The template code from list_speediance_workouts"),
        date:         z.string().describe("Date in YYYY-MM-DD format"),
      },
    },
    async ({ templateCode, date }) =>
      ok(await spedianceRequest("/schedule", {
        method: "POST",
        body: JSON.stringify({ templateCode, date }),
      }))
  );

  server.registerTool(
    "get_speediance_history",
    {
      description: deprecatedSpeediance("Get Speediance training session records for a date range."),
      inputSchema: {
        startDate: z.string().describe("Start date in YYYY-MM-DD format"),
        endDate:   z.string().describe("End date in YYYY-MM-DD format"),
        stats:     z.boolean().optional().describe("If true, return aggregate stats instead of individual records"),
      },
    },
    async ({ startDate, endDate, stats }) => {
      const path = stats
        ? `/history/stats?startDate=${startDate}&endDate=${endDate}`
        : `/history?startDate=${startDate}&endDate=${endDate}`;
      return ok(await spedianceRequest(path));
    }
  );

  server.registerTool(
    "get_speediance_activity",
    {
      description: deprecatedSpeediance("Get full exercise-by-exercise detail for a single Speediance training session, including sets, reps, and weight for each exercise. Use the trainingId field from get_speediance_history results."),
      inputSchema: { trainingId: z.coerce.number().describe("The trainingId from a get_speediance_history result") },
    },
    async ({ trainingId }) => ok(await spedianceRequest(`/training/${trainingId}`))
  );

  // -------------------------------------------------------------------------
  // Xert tools
  // -------------------------------------------------------------------------

  server.registerTool(
    "get_recent_rides",
    {
      description: "Get recent cycling activities from Xert (name, date, distance, elevation, etc.)",
      inputSchema: { days: z.coerce.number().optional().default(7).describe("Number of days to look back (default: 7)") },
    },
    async ({ days }) => ok(await xertRequest(`/recentRides?days=${days}`))
  );

  server.registerTool(
    "get_fitness_profile",
    {
      description:
        "Get the user's current Xert fitness signature (FTP, peak power, LTP, HIE) and training status, together with today's training info — the recommended workout of the day and strain (XSS) targets. Returns { fitness_profile, training_info }; training_info is null if that call fails.",
    },
    async () => {
      // Two small payloads, fetched in parallel. They are nested rather than
      // merged because both carry a `signature` and they disagree on units:
      // /user reports hie in joules, /training_info in kilojoules. Keeping the
      // provenance avoids one silently overwriting the other.
      const [profile, training] = await Promise.all([
        xertRequest("/user"),
        // Fail soft: a bad /training_info must not take the whole profile down.
        xertRequest("/training_info").catch((err) => ({
          success: false,
          error: String(err.message || err),
        })),
      ]);
      return ok({ fitness_profile: profile, training_info: training });
    }
  );

  server.registerTool(
    "get_training_info",
    {
      description:
        "Get today's Xert training recommendation on its own: the recommended workout of the day (wotd), target strain (targetXSS) broken into low/high/peak, current training load, fitness signature, and freshness status. Use this when planning or shaping a ride for today. Note: hie is reported in kilojoules here, unlike get_fitness_profile.",
    },
    async () => ok(await xertRequest("/training_info"))
  );

  server.registerTool(
    "get_activity_details",
    {
      description: "Get detailed information about a specific cycling activity by its ID or path",
      inputSchema: { activity_id: z.string().describe("The activity ID or path identifier") },
    },
    async ({ activity_id }) => ok(await xertRequest(`/activity/${activity_id}`))
  );

  server.registerTool(
    "schedule_workout",
    {
      description: "Schedule a workout on the user's Xert calendar",
      inputSchema: {
        workoutId: z.coerce.number().describe("The ID of the workout to schedule"),
        date: z.string().describe("Date to schedule in YYYY-MM-DD format"),
        time: z.string().optional().describe("Time to schedule in HH:MM format"),
      },
    },
    async ({ workoutId, date, time }) => {
      const body = { workoutId, date };
      if (time) body.time = time;
      return ok(await xertRequest("/schedule-workout", { method: "POST", body: JSON.stringify(body) }));
    }
  );

  server.registerTool(
    "create_workout",
    {
      description: "Create and import a custom workout to Xert with warmup, intervals, steady state, and cooldown segments.",
      inputSchema: {
        name: z.string().describe("Name of the workout"),
        description: z.string().optional().describe("Description of the workout"),
        steps: jsonParsed(z.array(z.object({
          type: z.enum(["warmup", "cooldown", "steady", "ramp", "intervalst", "freeride"]),
          duration: z.coerce.number().optional().describe("Duration in seconds"),
          target: z.coerce.number().optional().describe("Target power as decimal of FTP (e.g., 0.88 = 88%)"),
          start: z.coerce.number().optional().describe("Starting power for ramps"),
          end: z.coerce.number().optional().describe("Ending power for ramps"),
          cadence: z.coerce.number().optional().describe("Target cadence RPM"),
          repeat: z.coerce.number().optional().describe("Number of repeats for intervals"),
          onDuration: z.coerce.number().optional().describe("On/work duration for intervals"),
          offDuration: z.coerce.number().optional().describe("Off/rest duration for intervals"),
          onPower: z.coerce.number().optional().describe("Work power for intervals"),
          offPower: z.coerce.number().optional().describe("Rest power for intervals"),
        }))).describe("Array of workout steps/segments"),
        textEvents: jsonParsed(z.array(z.object({
          timeOffset: z.coerce.number().describe("Time offset in seconds from workout start"),
          message: z.string().describe("Message to display"),
        }))).optional().describe("Optional text messages to display during workout"),
      },
    },
    async ({ name, description, steps, textEvents }) => {
      const body = { name, steps };
      if (description) body.description = description;
      if (textEvents) body.textEvents = textEvents;
      const result = await xertRequest("/import-workout-json", { method: "POST", body: JSON.stringify(body) });
      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "get_workouts",
    { description: "Get the user's Xert workout library" },
    async () => ok(await xertRequest("/workouts"))
  );

  server.registerTool(
    "xert_api",
    {
      description: "Make a generic call to the Xert OAuth API for endpoints not covered by other tools",
      inputSchema: {
        endpoint: z.string().describe("API endpoint path (e.g., '/stats', '/calendar')"),
        method: z.enum(["GET", "POST"]).optional().default("GET").describe("HTTP method"),
        body: z.string().optional().describe("JSON body for POST requests"),
      },
    },
    async ({ endpoint, method, body }) => {
      const options = { method };
      if (body && method === "POST") options.body = body;
      const result = await xertRequest(endpoint, options);
      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
    }
  );

  // -------------------------------------------------------------------------
  // Recipe tools
  // -------------------------------------------------------------------------

  server.registerTool(
    "search_recipes",
    {
      description: "Search the recipe database by text or category. Returns lightweight summaries (title, rating, categories, times). Use get_recipe for full details.",
      inputSchema: {
        search: z.string().optional().describe("Full-text search query"),
        category: z.string().optional().describe("Filter by category name"),
        limit: z.coerce.number().optional().default(20).describe("Max results to return (default 20)"),
        page: z.coerce.number().optional().default(0).describe("Page number for pagination (default 0)"),
      },
    },
    async ({ search, category, limit, page }) =>
      ok(await recipeRequest("/recipes/summary/query", { search, category, limit, page }))
  );

  server.registerTool(
    "get_recipe",
    {
      description: "Get full details of a recipe by its ID, including ingredients, instructions, and notes.",
      inputSchema: {
        id: z.string().describe("The recipe _id from search_recipes results"),
      },
    },
    async ({ id }) => ok(await recipeRequest("/recipes/get", { id }))
  );

  server.registerTool(
    "create_recipe",
    {
      description: "Save a new recipe. Categories can be a simple string array. Ingredients are best sent as {amount, unit, ingredient} objects; plain strings work too and are parsed server-side (see the ingredients field).",
      inputSchema: {
        title: z.string().describe("Recipe title"),
        ingredients: jsonParsed(z.array(ingredientEntry)).optional().describe(INGREDIENTS_DESC),
        instructions: z.string().optional().describe("Cooking instructions (plain text or HTML)"),
        categories: jsonParsed(z.array(z.string())).optional().describe("Category names, e.g. ['Dinner', 'Italian']"),
        sources: jsonParsed(z.array(z.string())).optional().describe("Source URLs or names"),
        rating: z.coerce.number().min(0).max(5).optional().describe("Rating 0–5"),
        yields: jsonParsed(z.array(z.object({
          amount: z.coerce.number(),
          unit: z.string(),
        }))).optional().describe("Yield info, e.g. [{amount: 4, unit: 'servings'}]"),
        times: jsonParsed(z.array(z.object({
          name: z.string().describe("e.g. 'Prep', 'Cook', 'Total'"),
          seconds: z.coerce.number().optional(),
          text: z.string().optional().describe("Human-readable time, e.g. '30 minutes'"),
        }))).optional().describe("Time info"),
      },
    },
    async ({ title, ingredients, instructions, categories, sources, rating, yields, times }) => {
      const body = { title };
      if (ingredients) body.ingredients = ingredients;
      if (instructions) body.instructions = instructions;
      if (categories) body.categories = categories;
      if (sources) body.sources = sources;
      if (rating !== undefined) body.rating = rating;
      if (yields) body.yields = yields;
      if (times) body.times = times;
      return ok(await recipeRequest("/recipes", body));
    }
  );

  server.registerTool(
    "update_recipe",
    {
      description: "Update an existing recipe by ID. Partial at the FIELD level: fields you omit keep their stored value, and fields you send REPLACE the stored value. Arrays are replaced wholesale, not merged -- sending `ingredients` throws away the old ingredient list, so to add or change one item, call get_recipe first and send back the full new list.",
      inputSchema: {
        id: z.string().describe("The recipe _id to update"),
        title: z.string().optional(),
        ingredients: jsonParsed(z.array(ingredientEntry)).optional().describe("Replaces the ENTIRE ingredient list (not merged). " + INGREDIENTS_DESC),
        instructions: z.string().optional().describe("Replaces the instructions"),
        categories: jsonParsed(z.array(z.string())).optional().describe("Replaces the ENTIRE category list (not merged)"),
        sources: jsonParsed(z.array(z.string())).optional(),
        rating: z.coerce.number().min(0).max(5).optional(),
        yields: jsonParsed(z.array(z.object({ amount: z.coerce.number(), unit: z.string() }))).optional(),
        times: jsonParsed(z.array(z.object({
          name: z.string(),
          seconds: z.coerce.number().optional(),
          text: z.string().optional(),
        }))).optional(),
      },
    },
    async ({ id, ...fields }) => {
      const recipe = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        recipe[k] = v;
      }
      return ok(await recipeRequest("/recipes/update", { id, recipe }));
    }
  );

  // TEMPORARY (2026-09-21): one-off backfill for recipes written before the
  // Gourmet API parsed ingredients server-side. Remove once it has been run.
  server.registerTool(
    "repair_recipe_ingredients",
    {
      description:
        "MAINTENANCE, one-off. Recipes saved before the API parsed ingredients stored whole lines " +
        "in the name field ({text: '250g all-purpose flour'}) with no amount, so nothing that reads " +
        "amounts works on them. This re-parses those ingredients in place. It skips anything " +
        "ambiguous ('2% milk', '7-Up') and anything that already has an amount, and it does NOT " +
        "touch last_modified, so sort-by-recently-modified is preserved.\n\n" +
        "Defaults to a dry run that reports what it WOULD change. Pass dryRun: false to write.",
      inputSchema: {
        dryRun: jsonParsed(z.boolean())
          .optional()
          .describe("Report without writing. Defaults to true -- pass false to actually apply."),
        maxBatches: z.coerce
          .number()
          .optional()
          .describe("Safety stop on the paging loop (default 40 batches of 25 recipes)."),
      },
    },
    async ({ dryRun, maxBatches }) => {
      const write = dryRun === false;
      const batchCap = maxBatches ?? 40;
      let offset = 0;
      let batches = 0;
      let total = 0;
      let scanned = 0;
      let recipesChanged = 0;
      let ingredientsChanged = 0;
      let stillUnparsedCount = 0;
      const sampleChanges = [];
      const sampleUnparsed = [];
      while (batches < batchCap) {
        const batch = await recipeRequest("/recipes/reparse-ingredients", {
          dryRun: !write,
          limit: 25,
          offset,
        });
        total = batch.total;
        scanned += batch.scanned;
        recipesChanged += batch.recipesChanged;
        ingredientsChanged += batch.ingredientsChanged;
        stillUnparsedCount += batch.stillUnparsedCount;
        // Keep a readable sample rather than every change -- a full listing of
        // several thousand edits is no more useful than a few dozen.
        for (const recipe of batch.recipes) {
          for (const change of recipe.changes) {
            if (sampleChanges.length < 30) {
              sampleChanges.push({ recipe: recipe.title, from: change.from, to: change.to });
            }
          }
        }
        for (const text of batch.stillUnparsedSample) {
          if (sampleUnparsed.length < 20) sampleUnparsed.push(text);
        }
        batches += 1;
        offset = batch.nextOffset;
        if (batch.done) break;
      }
      return ok({
        applied: write,
        dryRun: !write,
        totalRecipes: total,
        scanned,
        complete: scanned >= total,
        recipesChanged,
        ingredientsChanged,
        stillUnparsedCount,
        sampleChanges,
        sampleUnparsed,
      });
    }
  );

  server.registerTool(
    "delete_recipe",
    {
      description: "Delete a recipe by ID. Use search_recipes first to confirm the correct ID.",
      inputSchema: {
        id: z.string().describe("The recipe _id to delete"),
      },
    },
    async ({ id }) => ok(await recipeRequest("/recipes/delete", { id }))
  );

  // -------------------------------------------------------------------------
  // USDA FoodData Central tools
  // -------------------------------------------------------------------------

  server.registerTool(
    "usda_food_search",
    {
      description: "Look up nutritional data for a food in the USDA FoodData Central database. Returns macros per 100g. ONLY use this when: (1) the user questions or wants to verify nutrition numbers, (2) you are genuinely uncertain about a food's macros, or (3) the food is unusual/obscure. Do NOT call this before every log entry — use your own knowledge for common foods (pasta, chicken, rice, eggs, bread, etc.) and only hit this endpoint to fact-check or resolve uncertainty. Note: covers generic/whole foods and some branded packaged items; restaurant dishes and custom meals won't be found.",
      inputSchema: {
        query: z.string().describe("Food name or description to search for"),
        limit: z.coerce.number().optional().default(5).describe("Number of results to return (default 5, max 25)"),
        dataType: z.enum(["Foundation+SR Legacy", "Foundation", "SR Legacy", "Survey", "Branded", "All"]).optional().default("Foundation+SR Legacy").describe("Data source(s): 'Foundation+SR Legacy' = both standard reference databases (default, best for generic foods), 'Branded' = commercial packaged products, 'Survey' = FNDDS dietary survey foods, 'All' = everything."),
      },
    },
    async ({ query, limit, dataType }) => {
      const usdaKey = env.USDA_API_KEY;
      const pageSize = Math.min(limit ?? 5, 25);

      async function usdaSearch(typeParam) {
        const url = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&pageSize=${pageSize}${typeParam}&api_key=${usdaKey}`;
        const res = await fetch(url);
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`USDA API ${res.status}: ${text}`);
        }
        return res.json();
      }

      function buildTypeParam(dt) {
        if (dt === "All") return "";
        const types = dt.split("+");
        return types.map(t => `&dataType=${encodeURIComponent(t.trim())}`).join("");
      }

      let data = await usdaSearch(buildTypeParam(dataType ?? "Foundation+SR Legacy"));

      // Auto-fallback: if no results, retry across all data sources
      const usedFallback = (data.foods ?? []).length === 0 && dataType !== "All";
      if (usedFallback) {
        data = await usdaSearch("");
      }

      // Extract just the relevant macros from each food.
      // Energy: Foundation uses 2047/2048 (Atwater), SR Legacy/Survey use 1008.
      const NUTRIENT_IDS = { protein: 1003, fat: 1004, carbs: 1005, fiber: 1079, added_sugar: 2000, alcohol: 1018 };
      const ENERGY_IDS = [1008, 2047, 2048]; // prefer 1008, fall back to Atwater variants
      const foods = (data.foods ?? []).map(food => {
        const macros = {};
        const energyNutrient = ENERGY_IDS.map(id => food.foodNutrients?.find(n => n.nutrientId === id)).find(Boolean);
        if (energyNutrient) macros.kcal = `${energyNutrient.value}${energyNutrient.unitName}`;
        for (const [key, id] of Object.entries(NUTRIENT_IDS)) {
          const n = food.foodNutrients?.find(n => n.nutrientId === id);
          if (n) macros[key] = `${n.value}${n.unitName}`;
        }
        return {
          fdcId: food.fdcId,
          name: food.description,
          dataType: food.dataType,
          per100g: macros,
        };
      });

      return ok({ query, totalHits: data.totalHits, searchedAllSources: usedFallback, results: foods });
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Worker entrypoint + OAuth 2.0 (Authorization Code + PKCE)
// ---------------------------------------------------------------------------

const WORKER_URL = "https://personal-mcp.tmhinkle.workers.dev";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// HMAC-SHA256 the payload with the API key, return hex string
async function hmacHex(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// SHA-256 → base64url (for PKCE S256 verification)
async function sha256base64url(str) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Encode the PKCE challenge + metadata into a signed authorization code
async function makeAuthCode(params, secret) {
  const payload = JSON.stringify({
    cc: params.code_challenge,       // PKCE challenge
    ri: params.redirect_uri,
    ci: params.client_id,
    st: params.state,
    exp: Date.now() + 5 * 60 * 1000, // 5-minute expiry
  });
  const b64 = btoa(payload);
  const sig = await hmacHex(b64, secret);
  return `${b64}.${sig}`;
}

// Verify and decode an authorization code
async function verifyAuthCode(code, secret) {
  const [b64, sig] = code.split(".");
  if (!b64 || !sig) return null;
  const expected = await hmacHex(b64, secret);
  if (expected !== sig) return null;
  const data = JSON.parse(atob(b64));
  if (Date.now() > data.exp) return null;
  return data;
}

function htmlPage(title, body) {
  return new Response(`<!DOCTYPE html><html>
<head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:400px;margin:80px auto;padding:0 16px}
input{width:100%;padding:8px;margin:8px 0;box-sizing:border-box;font-size:1em}
button{width:100%;padding:10px;background:#0f6;border:none;font-size:1em;cursor:pointer;border-radius:4px}
.err{color:red;margin-bottom:8px}</style></head>
<body>${body}</body></html>`, { headers: { "Content-Type": "text/html" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ------------------------------------------------------------------
    // OAuth 2.0 discovery
    // ------------------------------------------------------------------
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: WORKER_URL,
        authorization_endpoint: `${WORKER_URL}/authorize`,
        token_endpoint: `${WORKER_URL}/token`,
        grant_types_supported: ["authorization_code", "client_credentials"],
        code_challenge_methods_supported: ["S256"],
        response_types_supported: ["code"],
      });
    }

    // ------------------------------------------------------------------
    // Authorization endpoint — show login form (GET) or process it (POST)
    // ------------------------------------------------------------------
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") || "";
      const state = url.searchParams.get("state") || "";
      const codeChallenge = url.searchParams.get("code_challenge") || "";
      const clientId = url.searchParams.get("client_id") || "";

      if (request.method === "GET") {
        return htmlPage("Connect to Personal MCP", `
          <h2>Connect to Personal MCP</h2>
          <p>Enter your API key to authorize Claude.</p>
          <form method="POST">
            <input type="hidden" name="redirect_uri" value="${redirectUri}">
            <input type="hidden" name="state" value="${state}">
            <input type="hidden" name="code_challenge" value="${codeChallenge}">
            <input type="hidden" name="client_id" value="${clientId}">
            <input type="password" name="password" placeholder="API Key" autofocus>
            <button type="submit">Authorize</button>
          </form>`);
      }

      if (request.method === "POST") {
        const body = await request.text();
        const params = new URLSearchParams(body);
        const password = params.get("password") || "";

        if (password !== env.MCP_API_KEY) {
          return htmlPage("Connect to Personal MCP", `
            <h2>Connect to Personal MCP</h2>
            <p class="err">Incorrect API key.</p>
            <form method="POST">
              <input type="hidden" name="redirect_uri" value="${params.get("redirect_uri")}">
              <input type="hidden" name="state" value="${params.get("state")}">
              <input type="hidden" name="code_challenge" value="${params.get("code_challenge")}">
              <input type="hidden" name="client_id" value="${params.get("client_id")}">
              <input type="password" name="password" placeholder="API Key" autofocus>
              <button type="submit">Authorize</button>
            </form>`);
        }

        const code = await makeAuthCode({
          code_challenge: params.get("code_challenge"),
          redirect_uri: params.get("redirect_uri"),
          client_id: params.get("client_id"),
          state: params.get("state"),
        }, env.MCP_API_KEY);

        const callbackUrl = new URL(params.get("redirect_uri"));
        callbackUrl.searchParams.set("code", code);
        callbackUrl.searchParams.set("state", params.get("state"));
        return Response.redirect(callbackUrl.toString(), 302);
      }
    }

    // ------------------------------------------------------------------
    // Token endpoint — authorization_code or client_credentials
    // ------------------------------------------------------------------
    if (url.pathname === "/token" && request.method === "POST") {
      const body = await request.text();
      const params = new URLSearchParams(body);
      const grantType = params.get("grant_type");

      if (grantType === "authorization_code") {
        const code = params.get("code") || "";
        const codeVerifier = params.get("code_verifier") || "";
        const data = await verifyAuthCode(code, env.MCP_API_KEY);

        if (!data) return json({ error: "invalid_grant" }, 400);

        // PKCE: verify S256(code_verifier) == code_challenge stored in the code
        const challenge = await sha256base64url(codeVerifier);
        if (challenge !== data.cc) return json({ error: "invalid_grant" }, 400);

        return json({
          access_token: env.MCP_API_KEY,
          token_type: "bearer",
          expires_in: 31536000, // 1 year — token is the static API key, so no real expiry
        });
      }

      if (grantType === "client_credentials") {
        // Support both HTTP Basic and body params
        let clientId = params.get("client_id");
        let clientSecret = params.get("client_secret");
        const authHeader = request.headers.get("Authorization") || "";
        if (authHeader.startsWith("Basic ")) {
          const [id, secret] = atob(authHeader.slice(6)).split(":", 2);
          clientId = clientId || id;
          clientSecret = clientSecret || secret;
        }
        if (clientId !== env.MCP_CLIENT_ID || clientSecret !== env.MCP_API_KEY) {
          return json({ error: "invalid_client" }, 401);
        }
        return json({ access_token: env.MCP_API_KEY, token_type: "bearer", expires_in: 31536000 });
      }

      return json({ error: "unsupported_grant_type" }, 400);
    }

    // ------------------------------------------------------------------
    // MCP endpoint — Bearer token required
    // ------------------------------------------------------------------
    const auth = request.headers.get("Authorization");
    if (!env.MCP_API_KEY || auth !== `Bearer ${env.MCP_API_KEY}`) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      });
    }

    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no Durable Objects needed
    });

    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
