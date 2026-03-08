import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

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

  // -------------------------------------------------------------------------
  // Nutrition tools
  // -------------------------------------------------------------------------

  server.registerTool(
    "log_food",
    {
      description: "Log a meal entry to track nutrition. ALWAYS include the Date field — never omit it, even when logging a meal 'today'. Use today's actual date in YYYY-MM-DD format.",
      inputSchema: {
        Food: z.string().describe("Name of the food item"),
        Description: z.string().optional().describe("Additional description"),
        Meal: z.string().describe("Meal type (Breakfast, Lunch, Dinner, Snack)"),
        kcal: z.number().describe("Calories in kcal"),
        protein: z.number().describe("Protein in grams"),
        fat: z.number().describe("Fat in grams"),
        carbs: z.number().describe("Carbohydrates in grams"),
        fiber: z.number().optional().describe("Fiber in grams"),
        added_sugar: z.number().optional().describe("Added sugar in grams; do NOT include natural sugars such as lactose in milk or fructose in fruit."),
        Date: z.string().describe("Date in YYYY-MM-DD format. Required — always provide this, even for today's meals."),
      },
    },
    async ({ Food, Description, Meal, kcal, protein, fat, carbs, Date }) => {
      const body = { Food, Description, Meal, kcal, protein, fat, carbs, Date };
      return ok(await nutritionRequest("/log", { method: "POST", body: JSON.stringify(body) }));
    }
  );

  server.registerTool(
    "get_today_summary",
    { description: "Get today's nutrition totals including calories, macros, and comparison to goals" },
    async () => ok(await nutritionRequest("/today"))
  );

  server.registerTool(
    "get_recent_logs",
    {
      description: "Get recent food log entries, optionally filtered by date",
      inputSchema: { date: z.string().optional().describe("Filter by date in YYYY-MM-DD format") },
    },
    async ({ date }) => ok(await nutritionRequest(date ? `/logs?date=${date}` : "/logs"))
  );

  server.registerTool(
    "get_summaries",
    {
      description: "Get nutrition summaries over time",
      inputSchema: { limit: z.number().optional().describe("Maximum number of summaries to return") },
    },
    async ({ limit }) => ok(await nutritionRequest(limit ? `/summaries?limit=${limit}` : "/summaries"))
  );

  server.registerTool(
    "log_weight",
    {
      description: "Log a weight measurement",
      inputSchema: {
        Date: z.string().describe("Date of measurement in YYYY-MM-DD format"),
        Weight: z.number().describe("Weight value"),
      },
    },
    async ({ Date, Weight }) =>
      ok(await nutritionRequest("/metrics", { method: "POST", body: JSON.stringify({ Date, Weight }) }))
  );

  server.registerTool(
    "get_goals",
    { description: "Get current nutrition goals" },
    async () => ok(await nutritionRequest("/goals"))
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
        kcal: z.number().optional(),
        protein: z.number().optional(),
        fat: z.number().optional(),
        carbs: z.number().optional(),
        added_sugar: z.number().optional(),
        fiber: z.number().optional(),
        alcohol: z.number().optional(),
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
    "list_strength_workouts",
    {
      description: "List strength workout summaries, optionally filtered by date range",
      inputSchema: {
        startDate: z.string().optional().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().optional().describe("End date in YYYY-MM-DD format"),
        limit: z.number().optional().describe("Max items to return (default 50)"),
        offset: z.number().optional().describe("Items to skip (default 0)"),
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
      inputSchema: { id: z.number().describe("The workout ID") },
    },
    async ({ id }) => ok(await nutritionRequest(`/strength/workout?id=${id}`))
  );

  server.registerTool(
    "get_strength_sets",
    {
      description: "Query strength set rows filtered by time window, body focus, movement type, or exercise name. Use for exercise history and progress analysis.",
      inputSchema: {
        daysBack: z.number().optional().describe("How many days back to include (default 7)"),
        focus: z.string().optional().describe("Comma-separated body parts: quads, hamstrings, glutes, chest, back, shoulders, arms, core, calves"),
        movement: z.string().optional().describe("Partial match against movement type, e.g. 'Squat'"),
        exercise: z.string().optional().describe("Partial, case-insensitive match against exercise name"),
        limit: z.number().optional().describe("Max items to return (default 50)"),
        offset: z.number().optional().describe("Items to skip (default 0)"),
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
        limit: z.number().optional().describe("Max items to return (default 50)"),
        offset: z.number().optional().describe("Items to skip (default 0)"),
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
        limit: z.number().optional().describe("Max items to return (default 50)"),
        offset: z.number().optional().describe("Items to skip (default 0)"),
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
        limit: z.number().optional().describe("Max items to return (default 50)"),
        offset: z.number().optional().describe("Items to skip (default 0)"),
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
      description: "Ingest a Speediance workout payload (StrengthIngestWrapper format with 'data' property, or raw workout object).",
      inputSchema: { workoutData: z.string().describe("JSON string of the Speediance workout payload") },
    },
    async ({ workoutData }) =>
      ok(await nutritionRequest("/logStrengthWorkout", {
        method: "POST",
        body: JSON.stringify(JSON.parse(workoutData)),
      }))
  );

  // -------------------------------------------------------------------------
  // Xert tools
  // -------------------------------------------------------------------------

  server.registerTool(
    "get_recent_rides",
    {
      description: "Get recent cycling activities from Xert (name, date, distance, elevation, etc.)",
      inputSchema: { days: z.number().optional().default(7).describe("Number of days to look back (default: 7)") },
    },
    async ({ days }) => ok(await xertRequest(`/recentRides?days=${days}`))
  );

  server.registerTool(
    "get_fitness_profile",
    { description: "Get the user's current Xert fitness signature including FTP, peak power, and training status" },
    async () => ok(await xertRequest("/profile"))
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
        workoutId: z.number().describe("The ID of the workout to schedule"),
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
        steps: z.array(z.object({
          type: z.enum(["warmup", "cooldown", "steady", "ramp", "intervalst", "freeride"]),
          duration: z.number().optional().describe("Duration in seconds"),
          target: z.number().optional().describe("Target power as decimal of FTP (e.g., 0.88 = 88%)"),
          start: z.number().optional().describe("Starting power for ramps"),
          end: z.number().optional().describe("Ending power for ramps"),
          cadence: z.number().optional().describe("Target cadence RPM"),
          repeat: z.number().optional().describe("Number of repeats for intervals"),
          onDuration: z.number().optional().describe("On/work duration for intervals"),
          offDuration: z.number().optional().describe("Off/rest duration for intervals"),
          onPower: z.number().optional().describe("Work power for intervals"),
          offPower: z.number().optional().describe("Rest power for intervals"),
        })).describe("Array of workout steps/segments"),
        textEvents: z.array(z.object({
          timeOffset: z.number().describe("Time offset in seconds from workout start"),
          message: z.string().describe("Message to display"),
        })).optional().describe("Optional text messages to display during workout"),
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
        limit: z.number().optional().default(20).describe("Max results to return (default 20)"),
        page: z.number().optional().default(0).describe("Page number for pagination (default 0)"),
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
      description: "Save a new recipe. Ingredients and categories can be simple string arrays; the API normalizes them.",
      inputSchema: {
        title: z.string().describe("Recipe title"),
        ingredients: z.array(z.string()).optional().describe("List of ingredient strings, e.g. '2 cups flour'"),
        instructions: z.string().optional().describe("Cooking instructions (plain text or HTML)"),
        categories: z.array(z.string()).optional().describe("Category names, e.g. ['Dinner', 'Italian']"),
        sources: z.array(z.string()).optional().describe("Source URLs or names"),
        rating: z.number().min(0).max(5).optional().describe("Rating 0–5"),
        yields: z.array(z.object({
          amount: z.number(),
          unit: z.string(),
        })).optional().describe("Yield info, e.g. [{amount: 4, unit: 'servings'}]"),
        times: z.array(z.object({
          name: z.string().describe("e.g. 'Prep', 'Cook', 'Total'"),
          seconds: z.number().optional(),
          text: z.string().optional().describe("Human-readable time, e.g. '30 minutes'"),
        })).optional().describe("Time info"),
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
      description: "Update an existing recipe by ID. Only the fields you provide are changed (partial update).",
      inputSchema: {
        id: z.string().describe("The recipe _id to update"),
        title: z.string().optional(),
        ingredients: z.array(z.string()).optional().describe("Replaces the ingredient list"),
        instructions: z.string().optional().describe("Replaces the instructions"),
        categories: z.array(z.string()).optional().describe("Replaces the category list"),
        sources: z.array(z.string()).optional(),
        rating: z.number().min(0).max(5).optional(),
        yields: z.array(z.object({ amount: z.number(), unit: z.string() })).optional(),
        times: z.array(z.object({
          name: z.string(),
          seconds: z.number().optional(),
          text: z.string().optional(),
        })).optional(),
      },
    },
    async ({ id, ...fields }) => {
      const recipe = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) recipe[k] = v;
      }
      return ok(await recipeRequest("/recipes/update", { id, recipe }));
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
      description: "Search the USDA FoodData Central database for nutritional info on any food. Returns calories, protein, fat, and carbs per 100g. Use this to spot-check calorie density or look up macros for a food before logging it.",
      inputSchema: {
        query: z.string().describe("Food name or description to search for"),
        limit: z.number().optional().default(5).describe("Number of results to return (default 5, max 25)"),
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
          expires_in: 86400,
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
        return json({ access_token: env.MCP_API_KEY, token_type: "bearer", expires_in: 3600 });
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
