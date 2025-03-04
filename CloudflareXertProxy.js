

export default {
  async fetch(request, env, ctx) {
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