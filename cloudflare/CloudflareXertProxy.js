

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    // 🔐 Require API Key (Set in GPT and Cloudflare)
    const API_KEY = env.API_KEY
    const SECRET_STORE = env.SECRET_STORE
    const requestApiKey = request.headers.get("X-API-KEY");
    if (requestApiKey !== API_KEY) {
      return new Response("Unauthorized", { status: 403 });
    }



    // 🔐 Load credentials from Cloudflare KV
    const XERT_USERNAME = await SECRET_STORE.get("XERT_USERNAME");
    const XERT_PASSWORD = await SECRET_STORE.get("XERT_PASSWORD");

    // Load cached access token (if available)
    let accessToken = await SECRET_STORE.get("xert_access_token");

    // If there's no token, or it’s expired, get a new one
    if (!accessToken) {
      const tokenResponse = await fetch("https://www.xertonline.com/oauth/token", {
        method: "POST",
        headers: {
          "Authorization": "Basic " + btoa("xert_public:xert_public"),
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: `grant_type=password&username=${encodeURIComponent(XERT_USERNAME)}&password=${encodeURIComponent(XERT_PASSWORD)}`
      });

      const tokenData = await tokenResponse.json();
      if (!tokenData.access_token) {
        return new Response("Failed to obtain token", { status: 401 });
      }

      accessToken = tokenData.access_token;

      // Store the token temporarily in KV storage
      await SECRET_STORE.put("xert_access_token", accessToken, { expirationTtl: 600 }); // Store for 10 min
    }

    // Helper: simple in-memory cookie jar per request
    const cookieJar = {};
    const storeSetCookies = (response) => {
      const hdrs = response.headers;
      const setCookies = [];
      // Prefer platform-specific multi-value support if available
      if (typeof hdrs.getAll === "function") {
        try {
          const arr = hdrs.getAll("set-cookie");
          for (const v of arr) setCookies.push(v);
        } catch (e) {
          // ignore
        }
      }
      // Fallback: single get
      const single = hdrs.get("set-cookie");
      if (single) setCookies.push(single);
      // Fallback: iterate; some platforms yield repeated entries
      for (const [k, v] of hdrs) {
        if (k.toLowerCase() === "set-cookie") setCookies.push(v);
      }
      for (const v of setCookies) {
        const pair = v.split(";")[0];
        const eq = pair.indexOf("=");
        if (eq > 0) {
          const name = pair.slice(0, eq).trim();
          const val = pair.slice(eq + 1).trim();
          cookieJar[name] = val;
        }
      }
    };
    const buildCookieHeader = () => Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join("; ");

    // Helper: extract Laravel CSRF token from HTML
    const extractCsrfFromHtml = async (response) => {
      const html = await response.text();
      const m = html.match(/name="_token"\s+value="([^"]+)"/i);
      return { token: m ? m[1] : "", html };
    };

    // Reusable: perform login and return import CSRF + headers for upload
    const loginAndGetImportContext = async () => {
      // 1) Get main page + CSRF
      const mainResp = await fetch("https://www.xertonline.com/", {
        method: "GET",
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9"
        }
      });
      storeSetCookies(mainResp);
      const { token: csrf1 } = await extractCsrfFromHtml(mainResp.clone());
      if (!csrf1) throw new Error("Failed to get CSRF from main page");

      // 2) Login (manual redirect to collect all cookies)
      const loginBody = new URLSearchParams();
      loginBody.set("_token", csrf1);
      loginBody.set("username", XERT_USERNAME || "");
      loginBody.set("password", XERT_PASSWORD || "");
      loginBody.set("timezone", "");
      loginBody.set("redirect", "1");
      const loginResp = await fetch("https://www.xertonline.com/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": "https://www.xertonline.com/",
          "Origin": "https://www.xertonline.com",
          "Cookie": buildCookieHeader()
        },
        body: loginBody,
        redirect: "manual"
      });
      storeSetCookies(loginResp);
      const loginLocation = loginResp.headers.get("Location") || loginResp.headers.get("location");
      if (loginLocation) {
        const nextUrl = new URL(loginLocation, "https://www.xertonline.com").toString();
        const afterResp = await fetch(nextUrl, {
          method: "GET",
          headers: {
            "Cookie": buildCookieHeader(),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          }
        });
        storeSetCookies(afterResp);
      }

      // 3) Import page for CSRF + verify logged-in (no redirect=1)
      const importPageResp = await fetch("https://www.xertonline.com/workouts/import", {
        method: "GET",
        headers: {
          "Cookie": buildCookieHeader(),
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      storeSetCookies(importPageResp);
      const { token: importCsrf, html: importHtml } = await extractCsrfFromHtml(importPageResp.clone());
      if (!importCsrf || /redirect=1/i.test(importHtml)) {
        throw new Error("Login verification failed (import page blocked)");
      }

      // Headers for upload
      const xsrf = cookieJar["XSRF-TOKEN"];
      const uploadHeaders = new Headers({
        "Cookie": buildCookieHeader(),
        "Referer": "https://www.xertonline.com/workouts/import",
        "Origin": "https://www.xertonline.com"
      });
      if (xsrf) uploadHeaders.set("X-XSRF-TOKEN", xsrf);

      return { importCsrf, uploadHeaders };
    };

    // ✅ NEW: Schedule a workout on the user's calendar via cookie+CSRF flow
    if (path === "/schedule-workout" && request.method === "POST") {
      try {
        // Establish session + cookies
        await loginAndGetImportContext();
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        return new Response(msg, { status: 401 });
      }

      // Parse incoming payload
      let payload;
      try {
        payload = await request.json();
      } catch (_) {
        return new Response("Invalid JSON body", { status: 400 });
      }

      // If a preferred forUser alias is configured, enforce it; otherwise omit to use session user
      try {
        const preferredForUser = await SECRET_STORE.get("XERT_FORUSER");
        if (preferredForUser && typeof preferredForUser === "string" && preferredForUser.trim()) {
          payload.forUser = preferredForUser.trim();
        } else if (Object.prototype.hasOwnProperty.call(payload, "forUser")) {
          delete payload.forUser;
        }
      } catch (_) { /* ignore */ }

      // Build headers for XHR-style JSON request
      const xsrf = cookieJar["XSRF-TOKEN"];
      const headers = new Headers({
        "Accept": "*/*",
        "Content-Type": "application/json",
        "Origin": "https://www.xertonline.com",
        "Referer": "https://www.xertonline.com/workouts",
        "X-Requested-With": "XMLHttpRequest",
        "Cookie": buildCookieHeader()
      });
      if (xsrf) {
        headers.set("x-csrf-token", xsrf);
        headers.set("X-XSRF-TOKEN", xsrf);
      }

      const resp = await fetch("https://www.xertonline.com/createCalendarEvent", {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      const contentType = (resp.headers.get("Content-Type") || "application/json").toLowerCase();
      let upstream;
      try {
        upstream = contentType.includes("application/json") ? await resp.json() : await resp.text();
      } catch (_) {
        upstream = await resp.text();
      }
      // Best-effort event id extraction
      let eventId = null;
      if (upstream && typeof upstream === "object") {
        eventId = upstream.eventId || upstream.id || upstream.event_id || null;
      }
      const body = {
        success: resp.ok,
        eventId,
        data: upstream
      };
      return new Response(JSON.stringify(body), { status: resp.status, headers: { "Content-Type": "application/json" } });
    }

    // ✅ NEW: Handle `/recentRides?days=n`
    if (path === "/recentRides") {
      const days = parseInt(url.searchParams.get("days") || "1", 10);
      const now = Math.floor(Date.now() / 1000); // Current time in Unix timestamp
      const fromTimestamp = now - (days * 86400); // `days` days ago

      // Build the Xert API URL
      let xertApiUrl = `https://www.xertonline.com/oauth/activity?from=${fromTimestamp}&to=${now}`;

      const xertResponse = await fetch(xertApiUrl, {
        method: "GET",
        headers: { "Authorization": `Bearer ${accessToken}` }
      });

      return new Response(await xertResponse.text(), {
        status: xertResponse.status,
        headers: { "Content-Type": "application/json" }
      });
    }
    // ✅ NEW: Handle `/workouts/import` via cookie+CSRF (mirrors working bash flow)
    // POST multipart with `files[]` and optional convert_* fields.
    if (path === "/import-workout-file" && request.method === "POST") {
      let importCsrf, uploadHeaders;
      try {
        ({ importCsrf, uploadHeaders } = await loginAndGetImportContext());
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        return new Response(msg, { status: 401 });
      }

      // 4) Build outgoing multipart with incoming files and options
      const incoming = await request.formData();
      const outgoing = new FormData();
      outgoing.set("_token", importCsrf);
      const convAbove = incoming.get("convert_above_ftp") || "mmp";
      const convBelow = incoming.get("convert_below_ftp") || "xssr";
      outgoing.set("convert_above_ftp", String(convAbove));
      outgoing.set("convert_below_ftp", String(convBelow));

      // Support multiple files[] or single file field
      const files = incoming.getAll("files[]");
      const single = incoming.get("file");
      if (files && files.length > 0) {
        for (const f of files) {
          outgoing.append("files[]", f);
        }
      } else if (single) {
        outgoing.append("files[]", single);
      } else {
        return new Response("No file provided. Use files[] or file field.", { status: 400 });
      }

      const uploadResp = await fetch("https://www.xertonline.com/workouts/import", {
        method: "POST",
        headers: uploadHeaders,
        body: outgoing
      });
      const bodyText = await uploadResp.text();
      // If site still returns a redirect HTML page, surface the status
      const contentType = uploadResp.headers.get("Content-Type") || "text/html; charset=utf-8";
      return new Response(bodyText, { status: uploadResp.status, headers: { "Content-Type": contentType } });
    }


    // ✅ NEW: Handle `/import-workout-json` (accepts JSON, generates ZWO XML, uploads via cookie+CSRF)
    if (path === "/import-workout-json" && request.method === "POST") {
      // Parse JSON workout definition
      const json = await request.json();
      const {
        name = "Workout",
        description = "",
        steps = [],
        textEvents = [] // optional: [{ timeOffset: seconds, message: string }]
      } = json || {};

      // XML helpers
      const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, '&quot;');
      const num = (v, d = 3) => {
        const n = Number(v);
        if (!isFinite(n)) return "0";
        return String(Math.round(n * Math.pow(10, d)) / Math.pow(10, d));
      };
      const attr = (k, v) => v === undefined || v === null ? "" : ` ${k}="${esc(v)}"`;

      // Step generator with backward compatibility (no type => steady)
      const stepToXml = (s) => {
        const type = (s.type || "steady").toLowerCase();
        // allow legacy { duration, target }
        if (!s.type && s.duration != null && s.target != null) {
          return `    <SteadyState Duration="${parseInt(s.duration, 10)}" Power="${num(s.target)}"${attr('Cadence', s.cadence)} />\n`;
        }
        switch (type) {
          case "steady": {
            const { duration, target, cadence } = s;
            return `    <SteadyState Duration="${parseInt(duration, 10)}" Power="${num(target)}"${attr('Cadence', cadence)} />\n`;
          }
          case "warmup": {
            const { duration, start, end, cadence } = s;
            return `    <Warmup Duration="${parseInt(duration, 10)}" PowerLow="${num(start)}" PowerHigh="${num(end)}"${attr('Cadence', cadence)} />\n`;
          }
          case "cooldown": {
            const { duration, start, end, cadence } = s;
            return `    <Cooldown Duration="${parseInt(duration, 10)}" PowerLow="${num(start)}" PowerHigh="${num(end)}"${attr('Cadence', cadence)} />\n`;
          }
          case "ramp": {
            const { duration, start, end, cadence } = s;
            const sNum = Number(start), eNum = Number(end);
            if (!isFinite(sNum) || !isFinite(eNum)) {
              return `    <!-- Invalid ramp values: start=${esc(start)} end=${esc(end)} -->\n`;
            }
            if (eNum >= sNum) {
              // Ramp up
              return `    <Warmup Duration="${parseInt(duration, 10)}" PowerLow="${num(sNum)}" PowerHigh="${num(eNum)}"${attr('Cadence', cadence)} />\n`;
            } else {
              // Ramp down: preserve downward direction explicitly
              return `    <Cooldown Duration="${parseInt(duration, 10)}" PowerLow="${num(sNum)}" PowerHigh="${num(eNum)}"${attr('Cadence', cadence)} />\n`;
            }
          }
          case "intervalst": {
            const { repeat, onDuration, offDuration, onPower, offPower, cadence, cadenceResting } = s;
            let line = `    <IntervalsT Repeat="${parseInt(repeat, 10)}" OnDuration="${parseInt(onDuration, 10)}" OffDuration="${parseInt(offDuration, 10)}" OnPower="${num(onPower)}" OffPower="${num(offPower)}"`;
            if (cadence != null) line += ` Cadence="${esc(cadence)}"`;
            if (cadenceResting != null) line += ` CadenceResting="${esc(cadenceResting)}"`;
            line += ` />\n`;
            return line;
          }
          case "freeride": {
            const { duration } = s;
            return `    <FreeRide Duration="${parseInt(duration, 10)}" />\n`;
          }
          default: {
            // Unknown type: ignore with harmless comment
            return `    <!-- Unknown step type: ${esc(type)} -->\n`;
          }
        }
      };

      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
      xml += `<workout_file>\n`;
      xml += `  <author>Cloudflare Worker</author>\n`;
      xml += `  <name>${esc(name)}</name>\n`;
      if (description) xml += `  <description>${esc(description)}</description>\n`;
      xml += `  <workout>\n`;
      for (const s of steps) xml += stepToXml(s);
      // Optional text events at absolute offsets
      for (const evt of (textEvents || [])) {
        if (!evt) continue;
        const t = parseInt(evt.timeOffset || evt.offset || 0, 10);
        const msg = evt.message || evt.text || "";
        if (!msg) continue;
        xml += `    <textevent timeoffset="${t}" message="${esc(msg)}" />\n`;
      }
      xml += `  </workout>\n`;
      xml += `</workout_file>`;

      // Create a File for upload
      const safeName = name && String(name).trim() ? name : "Workout";
      const zwoFile = new File([xml], `${safeName}.zwo`, { type: "application/octet-stream" });

      let importCsrf, uploadHeaders;
      try {
        ({ importCsrf, uploadHeaders } = await loginAndGetImportContext());
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        return new Response(msg, { status: 401 });
      }

      // 4) Build outgoing multipart with the generated file
      const outgoing = new FormData();
      outgoing.set("_token", importCsrf);
      outgoing.set("convert_above_ftp", "mmp");
      outgoing.set("convert_below_ftp", "xssr");
      outgoing.append("files[]", zwoFile);

      const uploadResp = await fetch("https://www.xertonline.com/workouts/import", {
        method: "POST",
        headers: uploadHeaders,
        body: outgoing
      });
      const bodyText = await uploadResp.text();
      const contentType = uploadResp.headers.get("Content-Type") || "text/html; charset=utf-8";
      return new Response(bodyText, { status: uploadResp.status, headers: { "Content-Type": contentType } });
    }

    // Otherwise, just forward the request to Xert API
    let xertApiUrl = "https://www.xertonline.com/oauth" + url.pathname;
    if (url.search) xertApiUrl += url.search;

    const xertResponse = await fetch(xertApiUrl, {
      method: request.method,
      headers: {
        "Authorization": `Bearer ${accessToken}`
      }
    });

    return new Response(await xertResponse.text(), {
      status: xertResponse.status,
      headers: { "Content-Type": "application/json" }
    });
  }
};