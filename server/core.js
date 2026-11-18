"use strict";
/* Accounts, sessions, posts, reactions, saves, follows, comments, points. Everything the browser sends is untrusted. */
const crypto = require("node:crypto"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const { all, get, run, tx, uid, now } = require("./db");
const ROOT = path.join(__dirname, "..");

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const bad = (m, s) => new HttpError(s || 400, m);

/* ---------- seed catalogue (data.js + generated world recipes), loaded once to know valid keys and owners ---------- */
const POINTS = { post_recipe: 50, post_reel: 30, post_video: 80, view: 1, like: 5, dislike: -2, comment: 8, comment_made: 2, save: 10, share: 6, follow: 15 };
const SEED = { owner: new Map(), users: new Set(), official: "simplecook" };
(function loadSeed() {
  try {
    const ctx = { console }; ctx.window = ctx; vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "data.js"), "utf8"), ctx);
    const D = ctx.SC_DATA; SEED.official = D.OFFICIAL;
    D.USERS.forEach((u) => SEED.users.add(u.username)); SEED.users.add(D.OFFICIAL);
    [].concat(D.RECIPES, D.REELS, D.VIDEOS).forEach((i) => SEED.owner.set(i.type + ":" + i.id, i.author));
    const c2 = { console }; c2.window = c2; vm.createContext(c2);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "data", "world.js"), "utf8"), c2);
    c2.SC_WORLD.recipes.forEach((r) => SEED.owner.set("recipe:" + r.slug, D.OFFICIAL));
  } catch (e) { console.error("[seed] could not load seed catalogue:", e.message); }
})();
const RESERVED = ["simplecook", "admin", "support", "me", "explore", "create", "reels", "videos", "login", "signup", "profile", "forgot", "reset", "messages", "map", "scan", "food", "api"];

/* ---------- small helpers ---------- */
const buckets = new Map();
function limit(key, max, ms) {
  const t = Date.now(); let b = buckets.get(key);
  if (!b || t > b.reset) { b = { n: 0, reset: t + ms }; buckets.set(key, b); }
  if (++b.n > max) throw new HttpError(429, "You're doing that too often. Please wait a few minutes and try again.");
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k); }, 60000).unref();

const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k.toString("hex")))));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const str = (v, max, min) => { v = typeof v === "string" ? v.trim() : ""; if (min && v.length < min) return null; return v.slice(0, max); };
const KEY_RE = /^(recipe|reel|video):[A-Za-z0-9_.\-]{1,80}$/;

const publicUser = (u) => ({ id: u.username, uuid: u.id, username: u.username, name: u.name, bio: u.bio || "", avatar: u.avatar || null, hue: u.hue || 0, createdAt: Date.parse(u.created_at), followers: 0, following: 0, points: 0 });

/* ---------- sessions ---------- */
const SESSION_MS = 30 * 86400000;
function cookieHeader(token, secure, maxAge) { return "sc_session=" + token + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + Math.floor(maxAge / 1000) + (secure ? "; Secure" : ""); }
function parseCookies(req) { const o = {}; String(req.headers.cookie || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }); return o; }
function sessionUser(req) {
  const t = parseCookies(req).sc_session; if (!t || !/^[a-f0-9]{64}$/.test(t)) return null;
  const s = get("SELECT user_id, expires_at FROM sessions WHERE token=?", sha(t)); if (!s) return null;
  if (s.expires_at < now()) { run("DELETE FROM sessions WHERE token=?", sha(t)); return null; }
  return get("SELECT * FROM users WHERE id=?", s.user_id) || null;
}
function startSession(userId, ctx) {
  const token = crypto.randomBytes(32).toString("hex");
  run("INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)", sha(token), userId, now(), new Date(Date.now() + SESSION_MS).toISOString());
  ctx.setCookie(cookieHeader(token, ctx.secure, SESSION_MS));
}
const need = (ctx) => { if (!ctx.user) throw new HttpError(401, "Log in first."); return ctx.user; };

/* ---------- aggregates: counts and points, same rules as the original local-mode api.js ---------- */
let aggCache = null, aggAt = 0;
const changeListeners = [];
const onChange = (f) => changeListeners.push(f);
const invalidate = () => { aggCache = null; changeListeners.forEach((f) => { try { f(); } catch (e) { /* ignore */ } }); };
function aggregates() {
  if (aggCache && Date.now() - aggAt < 5000) return aggCache;
  const names = new Map(all("SELECT id,username FROM users").map((u) => [u.id, u.username]));
  const posts = all("SELECT key,type,author_id FROM posts");
  const owner = new Map(SEED.owner); posts.forEach((p) => owner.set(p.key, names.get(p.author_id)));
  const counts = {}, points = {}, followers = {}, following = {};
  const c = (k) => (counts[k] = counts[k] || { likes: 0, dislikes: 0, comments: 0, saves: 0, shares: 0, views: 0 });
  const add = (o, k, n) => { o[k] = (o[k] || 0) + n; };
  const award = (own, actor, n) => { if (!own || own === SEED.official || own === actor) return; add(points, own, n); };
  all("SELECT user_id,key,value FROM reactions").forEach((r) => { if (!owner.has(r.key)) return; const a = names.get(r.user_id); if (r.value === 1) { c(r.key).likes++; award(owner.get(r.key), a, POINTS.like); } else if (r.value === -1) { c(r.key).dislikes++; award(owner.get(r.key), a, POINTS.dislike); } });
  [["saves", "saves", "save"], ["shares", "shares", "share"], ["views", "views", "view"]].forEach(([tbl, f, p]) => all("SELECT user_id,key FROM " + tbl).forEach((r) => { if (!owner.has(r.key)) return; c(r.key)[f]++; award(owner.get(r.key), names.get(r.user_id), POINTS[p]); }));
  all("SELECT key,user_id FROM comments").forEach((r) => { if (!owner.has(r.key)) return; const a = names.get(r.user_id); c(r.key).comments++; award(owner.get(r.key), a, POINTS.comment); if (a !== owner.get(r.key)) add(points, a, POINTS.comment_made); });
  all("SELECT follower_id,target_id FROM follows").forEach((r) => { const f = names.get(r.follower_id), t = names.get(r.target_id); if (!f || !t) return; add(followers, t, 1); add(following, f, 1); award(t, f, POINTS.follow); });
  posts.forEach((p) => award(names.get(p.author_id), null, POINTS["post_" + p.type] || 0));
  aggCache = { counts, points, followers, following }; aggAt = Date.now(); return aggCache;
}
const itemOf = (p) => { const d = JSON.parse(p.data); const [type, id] = [p.type, p.key.slice(p.type.length + 1)]; return Object.assign({ likes: 0, dislikes: 0, comments: 0, saves: 0, shares: 0, views: 0 }, d, { type, id, _pid: p.key, source: "community", author: p.username, createdAt: Date.parse(p.created_at), age: 0 }); };

function state(ctx) {
  const a = aggregates(), u = ctx.user;
  const users = all("SELECT * FROM users ORDER BY created_at").map(publicUser);
  const posts = all("SELECT p.*, u.username FROM posts p JOIN users u ON u.id=p.author_id ORDER BY p.created_at DESC LIMIT 2000").map(itemOf);
  const userStats = {}; for (const n of new Set([...Object.keys(a.points), ...Object.keys(a.followers), ...Object.keys(a.following)])) userStats[n] = { points: a.points[n] || 0, followers: a.followers[n] || 0, following: a.following[n] || 0 };
  const s = { session: u ? { username: u.username, uuid: u.id, email: u.email } : null, users, posts, counts: a.counts, userStats, my: { reactions: {}, saves: [], follows: [] } };
  if (u) {
    all("SELECT key,value FROM reactions WHERE user_id=?", u.id).forEach((r) => (s.my.reactions[r.key] = r.value));
    s.my.saves = all("SELECT key FROM saves WHERE user_id=?", u.id).map((r) => r.key);
    s.my.follows = all("SELECT u.username FROM follows f JOIN users u ON u.id=f.target_id WHERE f.follower_id=?", u.id).map((r) => r.username);
  }
  return s;
}

/* ---------- mail (optional, for password-reset codes) ---------- */
async function sendMail(to, subject, text) {
  const key = process.env.RESEND_API_KEY; if (!key) return false;
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ from: process.env.MAIL_FROM || "Simple Cook <onboarding@resend.dev>", to: [to], subject, text }), signal: AbortSignal.timeout(15000) });
  return r.ok;
}

/* ---------- post validation ---------- */
const list = (v, n, len, re) => (Array.isArray(v) ? v : []).map((x) => str(x, len)).filter((x) => x && (!re || re.test(x))).slice(0, n);
const PH_RE = /^(\/media\/post-media\/[A-Za-z0-9_\-]+\/[A-Za-z0-9_.\-]+|[A-Za-z0-9_\-]{1,60}|assets\/[A-Za-z0-9_.\-\/]{1,120})$/;
function cleanPost(type, d, userId) {
  if (!["recipe", "reel", "video"].includes(type)) throw bad("Unknown post type.");
  const title = str(d.title, 120, 3); if (!title) throw bad("Give it a title of at least 3 characters.");
  const out = { title, ph: "", cats: list(d.cats, 6, 30, /^[a-z0-9-]+$/), tags: list((d.tags || []).map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]/g, "-")), 15, 30) };
  if (d.ph) { if (!PH_RE.test(String(d.ph)) || (String(d.ph).startsWith("/media/post-media/") && !String(d.ph).startsWith("/media/post-media/" + userId + "/"))) throw bad("Invalid cover image."); out.ph = String(d.ph); }
  if (d.media) { const m = String(d.media); if (!m.startsWith("/media/post-media/" + userId + "/") || !PH_RE.test(m)) throw bad("Invalid video."); out.media = m; }
  const int = (v, lo, hi) => Math.min(hi, Math.max(lo, parseInt(v, 10) || 0));
  if (type === "recipe") {
    const ing = list(d.ing, 60, 200), steps = list(d.steps, 60, 1000);
    if (!ing.length || !steps.length) throw bad("A recipe needs ingredients and steps.");
    Object.assign(out, { desc: str(d.desc, 3000) || "", ing, steps, tips: list(d.tips, 20, 300), diff: ["Easy", "Medium", "Hard"].includes(d.diff) ? d.diff : "Easy", prep: int(d.prep, 0, 2000), cook: int(d.cook, 0, 2000), serves: int(d.serves, 1, 100) || 1 });
  } else if (type === "reel") Object.assign(out, { cap: str(d.cap, 500) || "", recipe: str(d.recipe, 80) || "", dur: int(d.dur, 0, 36000) });
  else {
    const links = (Array.isArray(d.links) ? d.links : []).map((l) => ({ label: str(l && l.label, 60) || "Link", url: str(l && l.url, 300) })).filter((l) => l.url && (/^https?:\/\//i.test(l.url) || /^#\/recipe\/[A-Za-z0-9_.\-]+$/.test(l.url))).slice(0, 10);
    Object.assign(out, { desc: str(d.desc, 3000) || "", links, dur: int(d.dur, 0, 36000) });
  }
  return out;
}

/* ---------- routes ---------- */
const R = {};
R["GET /api/health"] = () => ({ ok: true });
R["GET /api/state"] = (ctx) => state(ctx);

R["POST /api/auth/signup"] = async (ctx) => {
  limit("signup:" + ctx.ip, 8, 3600000);
  const b = ctx.body, username = str(b.username, 20, 3).toLowerCase(), email = str(b.email, 200, 5).toLowerCase(), name = str(b.name, 40) || username;
  if (!/^[a-z0-9_.]{3,20}$/.test(username)) throw bad("Use 3 to 20 letters, numbers, dots or underscores.");
  if (RESERVED.includes(username) || SEED.users.has(username)) throw bad("That username is taken. Try another.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("Enter a valid email address.");
  if (typeof b.password !== "string" || b.password.length < 8 || b.password.length > 200) throw bad("Use at least 8 characters.");
  if (get("SELECT 1 FROM users WHERE username=?", username)) throw bad("That username is taken. Try another.");
  if (get("SELECT 1 FROM users WHERE email=?", email)) throw bad("An account with this email already exists.");
  const salt = crypto.randomBytes(16).toString("hex"), pass = await scrypt(b.password, salt), id = uid();
  run("INSERT INTO users(id,username,email,name,bio,hue,salt,pass,created_at) VALUES(?,?,?,?,?,?,?,?,?)", id, username, email, name, "New on Simple Cook. Cooking something amazing.", hue(username), salt, pass, now());
  invalidate(); startSession(id, ctx);
  return { user: publicUser(get("SELECT * FROM users WHERE id=?", id)) };
};
R["POST /api/auth/login"] = async (ctx) => {
  const idn = str(ctx.body.identifier, 200, 1).toLowerCase(); limit("login:" + ctx.ip, 20, 600000); limit("login:" + idn, 8, 600000);
  const u = idn && get("SELECT * FROM users WHERE username=? OR email=?", idn, idn);
  const ok = u && typeof ctx.body.password === "string" && crypto.timingSafeEqual(Buffer.from(await scrypt(ctx.body.password, u.salt), "hex"), Buffer.from(u.pass, "hex"));
  if (!ok) throw bad("Incorrect username/email or password.", 401);
  startSession(u.id, ctx); return { user: publicUser(u) };
};
R["POST /api/auth/logout"] = (ctx) => { const t = parseCookies(ctx.req).sc_session; if (t) run("DELETE FROM sessions WHERE token=?", sha(t)); ctx.setCookie(cookieHeader("", ctx.secure, 0)); return { ok: true }; };
R["POST /api/auth/reset/request"] = async (ctx) => {
  const email = str(ctx.body.email, 200, 5).toLowerCase(); limit("reset:" + ctx.ip, 5, 3600000);
  if (!process.env.RESEND_API_KEY) throw new HttpError(503, "Password reset by email is not set up on this server yet.");
  const u = get("SELECT id FROM users WHERE email=?", email);
  if (u) { const code = String(crypto.randomInt(100000, 1000000)); run("INSERT OR REPLACE INTO resets(email,code_hash,expires_at,tries) VALUES(?,?,?,0)", email, sha(code), new Date(Date.now() + 900000).toISOString()); await sendMail(email, "Your Simple Cook code", "Your Simple Cook password reset code is " + code + ". It expires in 15 minutes. If you did not ask for it, ignore this email."); }
  return { ok: true };
};
R["POST /api/auth/reset/complete"] = async (ctx) => {
  const email = str(ctx.body.email, 200, 5).toLowerCase(), code = str(String(ctx.body.code || ""), 10, 4); limit("resetc:" + ctx.ip, 10, 3600000);
  const r = get("SELECT * FROM resets WHERE email=?", email), fail = bad("That code is invalid or has expired.");
  if (!r || r.expires_at < now() || r.tries >= 5 || !code) throw fail;
  if (sha(code) !== r.code_hash) { run("UPDATE resets SET tries=tries+1 WHERE email=?", email); throw fail; }
  if (typeof ctx.body.password !== "string" || ctx.body.password.length < 8) throw bad("Use at least 8 characters.");
  const u = get("SELECT id FROM users WHERE email=?", email); if (!u) throw fail;
  const salt = crypto.randomBytes(16).toString("hex"); run("UPDATE users SET salt=?, pass=? WHERE id=?", salt, await scrypt(ctx.body.password, salt), u.id);
  run("DELETE FROM sessions WHERE user_id=?", u.id); run("DELETE FROM resets WHERE email=?", email); return { ok: true };
};
R["POST /api/profile"] = (ctx) => {
  const u = need(ctx), b = ctx.body, upd = {};
  if (b.name !== undefined) { const n = str(b.name, 40, 2); if (!n) throw bad("Enter a display name."); upd.name = n; }
  if (b.bio !== undefined) upd.bio = str(b.bio, 300) || "";
  if (b.avatar) { if (!new RegExp("^/media/avatars/" + u.id + "/[A-Za-z0-9_.\\-]+$").test(String(b.avatar))) throw bad("Invalid avatar."); upd.avatar = String(b.avatar); }
  Object.entries(upd).forEach(([k, v]) => run("UPDATE users SET " + k + "=? WHERE id=?", v, u.id));
  return { user: publicUser(get("SELECT * FROM users WHERE id=?", u.id)) };
};
R["POST /api/posts"] = (ctx) => {
  const u = need(ctx); limit("post:" + u.id, 10, 3600000);
  const type = ctx.body.type, data = cleanPost(type, ctx.body.data || {}, u.id), id = "p" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"), key = type + ":" + id;
  run("INSERT INTO posts(key,type,author_id,data,created_at) VALUES(?,?,?,?,?)", key, type, u.id, JSON.stringify(data), now()); invalidate();
  return { item: itemOf(get("SELECT p.*, u.username FROM posts p JOIN users u ON u.id=p.author_id WHERE p.key=?", key)) };
};
R["POST /api/posts/delete"] = (ctx) => {
  const u = need(ctx), key = String(ctx.body.key || ""); const r = run("DELETE FROM posts WHERE key=? AND author_id=?", key, u.id);
  if (!r.changes) throw new HttpError(403, "You can only delete your own posts.");
  [["reactions"], ["saves"], ["shares"], ["views"], ["comments"]].forEach(([t]) => run("DELETE FROM " + t + " WHERE key=?", key)); invalidate(); return { ok: true };
};
const validKey = (key) => { if (!KEY_RE.test(String(key))) throw bad("Unknown item."); if (!SEED.owner.has(key) && !get("SELECT 1 FROM posts WHERE key=?", key)) throw bad("Unknown item.", 404); return key; };
R["POST /api/react"] = (ctx) => {
  const u = need(ctx), key = validKey(ctx.body.key), v = ctx.body.value; limit("act:" + u.id, 300, 600000);
  if (v === 0) run("DELETE FROM reactions WHERE user_id=? AND key=?", u.id, key);
  else if (v === 1 || v === -1) run("INSERT INTO reactions(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value", u.id, key, v);
  else throw bad("Invalid reaction.");
  invalidate(); return { ok: true };
};
R["POST /api/save"] = (ctx) => { const u = need(ctx), key = validKey(ctx.body.key); limit("act:" + u.id, 300, 600000); if (ctx.body.on) run("INSERT OR IGNORE INTO saves(user_id,key) VALUES(?,?)", u.id, key); else run("DELETE FROM saves WHERE user_id=? AND key=?", u.id, key); invalidate(); return { ok: true }; };
R["POST /api/view"] = (ctx) => { const u = need(ctx), key = validKey(ctx.body.key); run("INSERT OR IGNORE INTO views(user_id,key) VALUES(?,?)", u.id, key); invalidate(); return { ok: true }; };
R["POST /api/share"] = (ctx) => { const u = need(ctx), key = validKey(ctx.body.key); run("INSERT OR IGNORE INTO shares(user_id,key) VALUES(?,?)", u.id, key); invalidate(); return { ok: true }; };
R["POST /api/follow"] = (ctx) => {
  const u = need(ctx), t = get("SELECT id FROM users WHERE username=?", String(ctx.body.username || "").toLowerCase()); limit("act:" + u.id, 300, 600000);
  if (!t || t.id === u.id) throw bad("You can't follow that account.");
  if (ctx.body.on) run("INSERT OR IGNORE INTO follows(follower_id,target_id) VALUES(?,?)", u.id, t.id); else run("DELETE FROM follows WHERE follower_id=? AND target_id=?", u.id, t.id);
  invalidate(); return { ok: true };
};
R["GET /api/comments"] = (ctx) => ({ comments: all("SELECT c.id,c.text,c.created_at,u.username FROM comments c JOIN users u ON u.id=c.user_id WHERE c.key=? ORDER BY c.created_at DESC LIMIT 100", validKey(ctx.query.key)).map((r) => ({ id: r.id, user: r.username, text: r.text, ts: Date.parse(r.created_at) })) });
R["POST /api/comments"] = (ctx) => {
  const u = need(ctx), key = validKey(ctx.body.key), text = str(ctx.body.text, 500, 1); if (!text) throw bad("Write a comment first."); limit("cmt:" + u.id, 20, 600000);
  const id = uid(), t = now(); run("INSERT INTO comments(id,key,user_id,text,created_at) VALUES(?,?,?,?,?)", id, key, u.id, text, t); invalidate();
  return { comment: { id, user: u.username, text, ts: Date.parse(t) } };
};
R["POST /api/report"] = (ctx) => {
  const u = need(ctx), key = validKey(ctx.body.key), reason = String(ctx.body.reason);
  if (!["inaccurate_recipe", "wrong_origin", "unsafe_instructions", "other"].includes(reason)) throw bad("Choose what is wrong.");
  try { run("INSERT INTO reports(id,reporter_id,target_type,target_id,reason,details,created_at) VALUES(?,?,?,?,?,?,?)", uid(), u.id, "post", key, reason, str(ctx.body.details, 1000) || null, now()); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw bad("You have already reported this recipe."); throw e; }
  return { ok: true };
};

module.exports = { R, HttpError, bad, need, sessionUser, parseCookies, limit, str, invalidate, onChange, SEED, POINTS };
