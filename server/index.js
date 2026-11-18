"use strict";
/* Simple Cook server: static site + JSON API + real-time messages (SSE). Zero npm dependencies. Node >= 22.13. */
const http = require("node:http"), fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
const { all, run, now } = require("./db");
const core = require("./core"), dm = require("./dm"), ai = require("./ai");
const { HttpError } = core;
let stateTimer = null;   // shared content changed: nudge every open browser to re-fetch (at most once a second)
core.onChange(() => { if (stateTimer) return; stateTimer = setTimeout(() => { stateTimer = null; dm.hub.emitAll({ t: "state" }); }, 1000); });

const ROOT = path.join(__dirname, "..");
const PORT = parseInt(process.env.PORT, 10) || 3000, HOST = "0.0.0.0", PROD = process.env.NODE_ENV === "production";
const ENV = process.env.SC_ENV || (PROD ? "production" : "development");

/* ---------- what the web may read (everything else, e.g. server/, supabase/, tests/, .env, is never served) ---------- */
const ROOT_FILES = new Set(["index.html", "style.css", "api.js", "chatbot.js", "data.js", "foodscan.js", "messages.js", "places.js", "scanner.js", "script.js", "ui.js", "views.js", "world.js"]);
const DIRS = [["assets/", /^assets\/[\w\-./]+$/], ["lib/", /^lib\/[\w\-]+\.js$/], ["backend/", /^backend\/[\w\-]+\.js$/], ["data/", /^data\/world\.js$/]];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".json": "application/json", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".mp3": "audio/mpeg" };

/* ---------- public runtime config ---------- */
const httpsOrigin = (u) => { try { const x = new URL(u); return x.protocol === "https:" ? x.origin : ""; } catch (e) { return ""; } };
const zapier = (u) => (/^https:\/\/([a-z0-9-]+\.)*zapier\.(app|com)(\/|$)/i.test(u || "") ? u : "");
const MAP_STYLE = process.env.MAP_STYLE_URL && httpsOrigin(process.env.MAP_STYLE_URL) ? process.env.MAP_STYLE_URL : "";
const GEOCODER = process.env.GEOCODER_URL && httpsOrigin(process.env.GEOCODER_URL) ? process.env.GEOCODER_URL : "";
const extra = [httpsOrigin(MAP_STYLE), httpsOrigin(GEOCODER)].filter(Boolean).join(" ");
function configJs() {
  const c = { env: ENV, backend: "railway", supabaseUrl: "", supabasePublishableKey: "", mapStyleUrl: MAP_STYLE, geocoderUrl: GEOCODER,
    chatbotUrl: zapier(process.env.PUBLIC_CHATBOT_URL) || "https://simple-cook-bot.zapier.app", chatbotEmbedUrl: zapier(process.env.PUBLIC_CHATBOT_EMBED_URL),
    features: { ai: !!process.env.ANTHROPIC_API_KEY, nutrition: !!process.env.FDC_API_KEY, passwordReset: !!process.env.RESEND_API_KEY, placesReview: process.env.PLACES_AUTO_APPROVE === "0" } };
  return "window.SC_CONFIG = " + JSON.stringify(c) + ";\n";
}
const CSP = ["default-src 'self'", "script-src 'self' 'sha256-/i31zoijXOGsinPaZzcNNMK8R2auPd6K0XbOtlvhEXg=' https://cdn.jsdelivr.net", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net", "font-src https://fonts.gstatic.com " + extra,
  "img-src 'self' data: blob: https://images.unsplash.com https://tile.openstreetmap.org " + extra, "media-src 'self' blob:", "connect-src 'self' https://tile.openstreetmap.org https://photon.komoot.io " + extra, "worker-src blob:", "child-src blob:",
  "frame-src https://*.zapier.app https://interfaces.zapier.com", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join("; ").replace(/\s+;/g, ";").replace(/\s+/g, " ");

function secHeaders(res, secure) {
  res.setHeader("Content-Security-Policy", CSP); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(self)"); res.setHeader("X-Frame-Options", "DENY");
  if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

/* ---------- helpers ---------- */
const send = (res, status, body, headers) => { const b = Buffer.from(typeof body === "string" ? body : JSON.stringify(body)); res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Content-Length": b.length, "Cache-Control": "no-store" }, headers)); res.end(b); };
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > max) { reject(new HttpError(413, "That is too large.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks))); req.on("error", reject);
  });
}
const clientIp = (req) => { const x = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean); return x.length ? x[x.length - 1] : req.socket.remoteAddress || "?"; };
const isSecure = (req) => req.headers["x-forwarded-proto"] === "https" || !!req.socket.encrypted;

const gz = new Map();
function serveFile(req, res, file, cacheCtl) {
  let st; try { st = fs.statSync(file); } catch (e) { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(file).toLowerCase(), type = TYPES[ext] || "application/octet-stream", etag = '"' + st.size.toString(36) + "-" + Math.floor(st.mtimeMs).toString(36) + '"';
  const h = { "Content-Type": type, ETag: etag, "Cache-Control": cacheCtl };
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, h); res.end(); return true; }
  const text = /^(text\/|application\/json|image\/svg)/.test(type);
  if (text && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    let g = gz.get(file); if (!g || g.etag !== etag) { g = { etag, buf: zlib.gzipSync(fs.readFileSync(file)) }; gz.set(file, g); }
    res.writeHead(200, Object.assign(h, { "Content-Encoding": "gzip", Vary: "Accept-Encoding", "Content-Length": g.buf.length })); res.end(req.method === "HEAD" ? undefined : g.buf); return true;
  }
  res.writeHead(200, Object.assign(h, { "Content-Length": st.size })); if (req.method === "HEAD") res.end(); else fs.createReadStream(file).pipe(res); return true;
}
function serveRanged(req, res, file, cacheCtl) {
  let st; try { st = fs.statSync(file); } catch (e) { return false; }
  const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", h = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": cacheCtl, "Content-Disposition": "inline", "Content-Security-Policy": "sandbox; default-src 'none'" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (m && (m[1] || m[2])) {
    let a = m[1] ? +m[1] : Math.max(0, st.size - +m[2]), b = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
    if (a > b || a >= st.size) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); res.end(); return true; }
    res.writeHead(206, Object.assign(h, { "Content-Range": "bytes " + a + "-" + b + "/" + st.size, "Content-Length": b - a + 1 })); fs.createReadStream(file, { start: a, end: b }).pipe(res); return true;
  }
  res.writeHead(200, Object.assign(h, { "Content-Length": st.size })); if (req.method === "HEAD") res.end(); else fs.createReadStream(file).pipe(res); return true;
}

/* ---------- request handling ---------- */
async function handle(req, res) {
  const secure = isSecure(req), url = new URL(req.url, "http://x"), p = decodeURIComponent(url.pathname);
  secHeaders(res, secure);
  if (p === "/health" || p === "/api/health") return send(res, 200, { ok: true });

  if (p.startsWith("/api/")) {
    const cookies = []; const ctx = { req, res, ip: clientIp(req), secure, query: Object.fromEntries(url.searchParams), setCookie: (c) => cookies.push(c), user: null, body: {} };
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        const origin = req.headers.origin; if (origin && origin !== (secure ? "https://" : "http://") + req.headers.host && new URL(origin).host !== req.headers.host) throw new HttpError(403, "Cross-site request blocked.");
        if (req.headers["x-sc"] !== "1") throw new HttpError(403, "Missing header.");
      }
      ctx.user = core.sessionUser(req);
      let out;
      if (p === "/api/events") {
        if (!ctx.user) throw new HttpError(401, "Log in first.");
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.write("retry: 3000\n\n: connected\n\n"); dm.hub.add(ctx.user.id, res); return;
      }
      if (p === "/api/upload" && req.method === "POST") {
        if (!ctx.user) throw new HttpError(401, "Log in first.");
        const B = dm.BUCKETS[ctx.query.bucket]; if (!B) throw new HttpError(400, "Unknown bucket");
        core.limit("upl:" + ctx.user.id, 60, 600000);
        const buf = await readBody(req, B.max + 1024), mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        try { dm.storeFile(ctx.user.id, ctx.query.bucket, String(ctx.query.path || ""), mime, buf); } catch (e) { if (e.code) return send(res, e.status || 400, { error: { message: e.message, code: e.code } }); throw e; }
        return send(res, 200, { ok: true });
      }
      const big = p.startsWith("/api/ai/"); const raw = req.method === "POST" ? await readBody(req, big ? 14 * 1048576 : 1048576) : Buffer.alloc(0);
      if (raw.length) { try { ctx.body = JSON.parse(raw.toString("utf8")); } catch (e) { throw new HttpError(400, "Bad request."); } if (!ctx.body || typeof ctx.body !== "object") throw new HttpError(400, "Bad request."); }
      if (p === "/api/db") out = dm.query(ctx.user && ctx.user.id, ctx.body);
      else if (p === "/api/rpc") out = await dm.rpc(ctx.user && ctx.user.id, String(ctx.body.fn || ""), ctx.body.args);
      else if (p === "/api/broadcast") { if (!ctx.user) throw new HttpError(401, "Log in first."); dm.broadcast(ctx.user.id, ctx.body.channel, ctx.body.event, ctx.body.payload); out = { ok: true }; }
      else if (big) {
        if (!ctx.user) throw new HttpError(401, "login_required"); const f = ai.A[p.slice(8)]; if (!f) throw new HttpError(404, "Not found");
        core.limit("ai:" + ctx.user.id, 40, 600000); out = await f(ctx.user, ctx.body);
      } else {
        const r = core.R[req.method + " " + p] || (req.method === "HEAD" && core.R["GET " + p]); if (!r) throw new HttpError(404, "Not found");
        out = await r(ctx);
      }
      return send(res, 200, out, cookies.length ? { "Set-Cookie": cookies } : undefined);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message }, cookies.length ? { "Set-Cookie": cookies } : undefined);
      console.error("[api]", req.method, p, e && e.stack || e); return send(res, 500, { error: "Something went wrong. Please try again." });
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });

  if (p.startsWith("/media/")) {
    const m = /^\/media\/([a-z-]+)\/(.+)$/.exec(p); if (!m) return send(res, 404, { error: "Not found" });
    const u = core.sessionUser(req);
    if (!dm.mayRead(u && u.id, m[1], m[2])) return send(res, u ? 404 : 401, { error: "Not found" });
    if (serveRanged(req, res, dm.fileOf(m[1], m[2]), m[1] === "chat-media" ? "private, max-age=3600" : "public, max-age=86400")) return;
    return send(res, 404, { error: "Not found" });
  }
  if (p === "/config.js") return send(res, 200, configJs(), { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });

  let rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
  const ok = ROOT_FILES.has(rel) || DIRS.some(([d, re]) => rel.startsWith(d) && re.test(rel) && !rel.includes(".."));
  if (ok && serveFile(req, res, path.join(ROOT, rel), rel.startsWith("assets/") ? "public, max-age=86400" : "no-cache")) return;
  send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
}

const server = http.createServer((req, res) => { handle(req, res).catch((e) => { console.error("[fatal]", e); try { if (!res.headersSent) send(res, 500, { error: "Something went wrong." }); else res.end(); } catch (x) { /* ignore */ } }); });
server.keepAliveTimeout = 65000; server.headersTimeout = 70000;

/* ---------- housekeeping ---------- */
function sweep() {
  const t = now(); run("DELETE FROM sessions WHERE expires_at<?", t); run("DELETE FROM resets WHERE expires_at<?", t);
  const old = all("SELECT id,media_path FROM stories WHERE expires_at<?", new Date(Date.now() - 86400000).toISOString());
  old.forEach((s) => { try { fs.unlinkSync(dm.fileOf("post-media", s.media_path)); } catch (e) { /* gone */ } run("DELETE FROM stories WHERE id=?", s.id); });
}
setInterval(() => { try { sweep(); } catch (e) { console.error("[sweep]", e.message); } }, 3600000).unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log("[simple-cook] listening on " + HOST + ":" + PORT + " (" + ENV + ") data=" + require("./db").DATA_DIR));
  const stop = () => { console.log("[simple-cook] shutting down"); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 4000).unref(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
module.exports = { server, CSP };
