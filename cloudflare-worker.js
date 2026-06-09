/**
 * Sandbagger proxy — sikret versjon
 * ---------------------------------
 * Kjører på sandbagger-ai.mariuseidsmo.workers.dev og dekker to ting:
 *   • AI-proxy           POST /                      → Anthropic (Claude)
 *   • Bane-søk           GET  /course/search?q=...   → golfcourseapi.com
 *   • Bane-detalj        GET  /course/{id}           → golfcourseapi.com
 *
 * Beskyttelse (gjelder ALLE ruter):
 *  1) Rate limiting     → maks 30 req/min per IP (AI_LIMITER-binding).
 *  2) Origin-allowlist  → kun forespørsler fra din egen app slipper gjennom.
 *  3) Delt token        → X-App-Token må matche APP_TOKEN.
 *  4) Modell-allowlist + max_tokens-tak → ingen kan be om dyre modeller.
 *
 * VIKTIG oppsett i Cloudflare (Settings → Variables → legg inn som Secret):
 *  - ANTHROPIC_API_KEY  → din Anthropic-nøkkel. ALDRI hardkod den her.
 *  - APP_TOKEN          → tilfeldig streng, må matche klienten.
 *  - COURSE_API_KEY     → gratis nøkkel fra golfcourseapi.com (e-postregistrering).
 *
 * Rate limiting ligg no i koden via AI_LIMITER-bindinga (sjå wrangler.toml).
 * Etter endring her: køyr `wrangler deploy` for å rulle ut.
 */

// Tillatte origins. Legg til din faktiske domene-URL her.
// "null" dekker apper som åpnes direkte fra fil (file://). Fjern den hvis
// appen alltid hostes på et domene — da blir beskyttelsen strengere.
const ALLOWED_ORIGINS = [
  "https://sandbagger.no",
  "http://sandbagger.no",
  "https://mariuseidsmo-a11y.github.io",
  "null",
];

const ALLOWED_MODELS = [
  "claude-sonnet-4-5",
  "claude-haiku-4-5-20251001",
];

const MAX_TOKENS_CAP = 1000;

// golfcourseapi.com. Auth-formatet deres er "Authorization: Key <nøkkel>".
// Hvis søk gir 401: sjekk om de har byttet til "Bearer" — bytt da linja under.
const COURSE_API_BASE = "https://api.golfcourseapi.com/v1";
function courseAuth(env) { return "Key " + (env.COURSE_API_KEY || ""); }

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Rate limiting per IP — bremser kostnads-misbruk av AI-proxyen sjølv om
    // nokon hentar ut token+origin frå klienten. Krev [[ratelimit]]-binding i
    // wrangler.toml. Guard: manglar bindinga, hoppar vi over (workeren funkar).
    if (env.AI_LIMITER) {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await env.AI_LIMITER.limit({ key: ip });
      if (!success) {
        return json({ error: "For mange forespørsler — vent eit minutt." }, 429, cors);
      }
    }

    // Felles beskyttelse for alle ruter
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: "Forbidden origin" }, 403, cors);
    }
    if (env.APP_TOKEN && request.headers.get("X-App-Token") !== env.APP_TOKEN) {
      return json({ error: "Unauthorized" }, 401, cors);
    }

    // ── Bane-søk: GET /course/search?q=...
    if (request.method === "GET" && url.pathname === "/course/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2) return json({ courses: [] }, 200, cors);
      const up = await fetch(COURSE_API_BASE + "/search?search_query=" + encodeURIComponent(q), {
        headers: { "Authorization": courseAuth(env) },
      });
      return passthrough(up, cors);
    }

    // ── Bane-detalj: GET /course/{id}
    const m = url.pathname.match(/^\/course\/(\d+)$/);
    if (request.method === "GET" && m) {
      const up = await fetch(COURSE_API_BASE + "/courses/" + m[1], {
        headers: { "Authorization": courseAuth(env) },
      });
      return passthrough(up, cors);
    }

    // ── AI-proxy: POST /
    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "Invalid JSON" }, 400, cors);
      }
      const model = ALLOWED_MODELS.includes(body.model) ? body.model : ALLOWED_MODELS[0];
      const max_tokens = Math.min(Number(body.max_tokens) || 500, MAX_TOKENS_CAP);
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return json({ error: "messages required" }, 400, cors);
      }
      const up = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, max_tokens, messages: body.messages }),
      });
      return passthrough(up, cors);
    }

    return new Response("Method not allowed", { status: 405, headers: cors });
  },
};

async function passthrough(upstream, cors) {
  const data = await upstream.text();
  return new Response(data, {
    status: upstream.status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
