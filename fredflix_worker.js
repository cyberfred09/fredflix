/**
 * ╔════════════════════════════════════════════════════╗
 * ║        FREDFLIX CLOUDFLARE WORKER  v1.0            ║
 * ║  Proxy HLS geo-distribuido — gratuito, sin servidor║
 * ╠════════════════════════════════════════════════════╣
 * ║  DESPLIEGUE (2 minutos):                           ║
 * ║  1. workers.cloudflare.com → Create Worker         ║
 * ║  2. Pegar este código → Deploy                     ║
 * ║  3. Copiar URL (*.workers.dev) a Fredflix Ajustes  ║
 * ╠════════════════════════════════════════════════════╣
 * ║  PLAN GRATUITO: 100.000 req/día · Sin tarjeta      ║
 * ║  RED: ~310 ciudades · Todos los continentes        ║
 * ╚════════════════════════════════════════════════════╝
 *
 * RUTAS:
 *   GET /proxy/m3u8?url=<encoded>     → Reescribe playlist M3U8
 *   GET /proxy/segment?url=<encoded>  → Proxifica segmento TS/MP4
 *   GET /proxy/test?url=<encoded>     → Verifica accesibilidad
 *   GET /health                        → Estado del worker
 *   GET /region                        → País/ciudad del PoP activo
 */

// ── OPCIONAL: clave de acceso (déjalo vacío para acceso abierto) ──
const ACCESS_KEY = "";

// ── Headers que simulan navegador real ──
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  Origin: "https://www.google.com",
  Referer: "https://www.google.com/",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "cross-site",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range",
};

// ── Utilidades ──────────────────────────────────────────────────────

function isM3U8(url = "", ct = "") {
  return (
    url.includes(".m3u8") ||
    url.includes(".m3u") ||
    ct.includes("mpegurl") ||
    ct.includes("x-scte35")
  );
}

function baseUrlOf(url) {
  return url.substring(0, url.lastIndexOf("/") + 1);
}

function resolveUrl(rel, base) {
  if (rel.startsWith("http://") || rel.startsWith("https://")) return rel;
  if (rel.startsWith("//")) return "https:" + rel;
  if (rel.startsWith("/")) {
    const u = new URL(base);
    return u.origin + rel;
  }
  return base + rel;
}

function workerProxyUrl(request, path, targetUrl) {
  const base = new URL(request.url).origin;
  const key = ACCESS_KEY ? `&key=${ACCESS_KEY}` : "";
  return `${base}/proxy/${path}?url=${encodeURIComponent(targetUrl)}${key}`;
}

function rewriteM3U8(text, originUrl, request) {
  const base = baseUrlOf(originUrl);
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();

      // Línea con URI="..."
      if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const full = resolveUrl(uri, base);
          const path = isM3U8(full) ? "m3u8" : "segment";
          return `URI="${workerProxyUrl(request, path, full)}"`;
        });
      }

      // Línea de directiva normal
      if (trimmed.startsWith("#") || !trimmed) return line;

      // URL de segmento/variante
      const full = resolveUrl(trimmed, base);
      const path = isM3U8(full) ? "m3u8" : "segment";
      return workerProxyUrl(request, path, full);
    })
    .join("\n");
}

function buildUpstreamHeaders(incomingRequest) {
  const h = { ...BROWSER_HEADERS };
  const range = incomingRequest.headers.get("Range");
  if (range) h["Range"] = range;
  return h;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function checkKey(request) {
  if (!ACCESS_KEY) return true;
  const url = new URL(request.url);
  const k =
    request.headers.get("X-Proxy-Key") || url.searchParams.get("key") || "";
  return k === ACCESS_KEY;
}

// ── Handler principal ───────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ── /health ──
    if (path === "/health") {
      return jsonResponse({
        status: "ok",
        service: "Fredflix Worker",
        version: "1.0",
        colo: request.cf?.colo || "unknown",
        country: request.cf?.country || "unknown",
        city: request.cf?.city || "unknown",
      });
    }

    // ── /region ──
    if (path === "/region") {
      return jsonResponse({
        colo: request.cf?.colo,
        country: request.cf?.country,
        city: request.cf?.city,
        continent: request.cf?.continent,
        latitude: request.cf?.latitude,
        longitude: request.cf?.longitude,
        timezone: request.cf?.timezone,
      });
    }

    // ── Auth ──
    if (!checkKey(request)) {
      return jsonResponse({ error: "No autorizado" }, 403);
    }

    const targetUrl = decodeURIComponent(url.searchParams.get("url") || "");

    // ── /proxy/test ──
    if (path === "/proxy/test") {
      if (!targetUrl)
        return jsonResponse({ error: "Falta parámetro url" }, 400);
      try {
        const r = await fetch(targetUrl, {
          method: "HEAD",
          headers: buildUpstreamHeaders(request),
          cf: { cacheTtl: 0 },
        });
        return jsonResponse({
          url: targetUrl,
          status: r.status,
          accessible: r.status < 400,
          content_type: r.headers.get("Content-Type") || "",
          cors: r.headers.get("Access-Control-Allow-Origin") || "none",
        });
      } catch (e) {
        return jsonResponse({ url: targetUrl, accessible: false, error: String(e) });
      }
    }

    // ── /proxy/m3u8 ──
    if (path === "/proxy/m3u8") {
      if (!targetUrl)
        return jsonResponse({ error: "Falta parámetro url" }, 400);
      try {
        const r = await fetch(targetUrl, {
          headers: buildUpstreamHeaders(request),
          cf: { cacheTtl: 0 },
          redirect: "follow",
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        const rewritten = rewriteM3U8(text, r.url, request);
        return new Response(rewritten, {
          status: 200,
          headers: {
            ...CORS,
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-cache, no-store",
          },
        });
      } catch (e) {
        return jsonResponse({ error: String(e) }, 502);
      }
    }

    // ── /proxy/segment ──
    if (path === "/proxy/segment") {
      if (!targetUrl)
        return jsonResponse({ error: "Falta parámetro url" }, 400);
      try {
        const r = await fetch(targetUrl, {
          headers: buildUpstreamHeaders(request),
          redirect: "follow",
          // Cache segments briefly in Cloudflare's cache
          cf: { cacheTtl: 30, cacheEverything: true },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);

        const ct = r.headers.get("Content-Type") || "video/MP2T";

        // Si el segmento es otro M3U8 anidado
        if (isM3U8(r.url, ct)) {
          const text = await r.text();
          const rewritten = rewriteM3U8(text, r.url, request);
          return new Response(rewritten, {
            status: 200,
            headers: {
              ...CORS,
              "Content-Type": "application/vnd.apple.mpegurl",
              "Cache-Control": "no-cache",
            },
          });
        }

        // Streaming del segmento TS/MP4 — zero CPU overhead
        const respHeaders = { ...CORS, "Content-Type": ct };
        for (const h of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
          const v = r.headers.get(h);
          if (v) respHeaders[h] = v;
        }
        // Status 206 para Range requests
        const status = r.headers.get("Content-Range") ? 206 : 200;
        return new Response(r.body, { status, headers: respHeaders });
      } catch (e) {
        return jsonResponse({ error: String(e) }, 502);
      }
    }

    // ── Root ──
    if (path === "/" || path === "") {
      return jsonResponse({
        name: "Fredflix Worker",
        version: "1.0",
        colo: request.cf?.colo,
        country: request.cf?.country,
        endpoints: {
          "GET /proxy/m3u8?url=<encoded>":    "Reescribe playlist M3U8",
          "GET /proxy/segment?url=<encoded>": "Proxifica segmento",
          "GET /proxy/test?url=<encoded>":    "Verifica accesibilidad",
          "GET /health":                       "Estado",
          "GET /region":                       "Info del PoP activo",
        },
      });
    }

    return jsonResponse({ error: "Ruta no encontrada" }, 404);
  },
};
