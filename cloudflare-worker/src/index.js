function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin"
  };
}

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "https://aabeumeler.github.io";
    const requestOrigin = request.headers.get("Origin") || "";
    const headers = corsHeaders(allowedOrigin);

    if (requestOrigin !== allowedOrigin) {
      return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers });
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
    }

    const location = request.cf || {};
    return new Response(JSON.stringify({
      countryCode: location.country || null,
      regionCode: location.regionCode || null,
      regionName: location.region || null
    }), { status: 200, headers });
  }
};
