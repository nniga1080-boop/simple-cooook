"use strict";
/* Messaging, stories, food map: a small, locked-down query engine + RPCs for the browser's SC.dm bridge.
   Every table has explicit read/write rules; the browser can never choose whose data it touches. */
const fs = require("node:fs"), path = require("node:path");
const { all, get, run, tx, uid, now, DATA_DIR } = require("./db");
const { HttpError, SEED, str } = require("./core");
const osm = require("./osm");

/* ---------- realtime hub (Server-Sent Events) ---------- */
const clients = new Map();
const hub = {
  add(userId, res) { let s = clients.get(userId); if (!s) clients.set(userId, (s = new Set())); if (s.size >= 6) { const old = s.values().next().value; s.delete(old); try { old.end(); } catch (e) { /* closed */ } }   // a user can hold at most 6 live streams (tabs)
    s.add(res); res.on("close", () => { s.delete(res); if (!s.size) clients.delete(userId); }); },
  emit(userIds, evt) { const line = "data: " + JSON.stringify(evt) + "\n\n"; for (const id of new Set(userIds)) for (const res of clients.get(id) || []) { try { res.write(line); } catch (e) { /* closed */ } } },
  emitAll(evt) { const line = "data: " + JSON.stringify(evt) + "\n\n"; for (const s of clients.values()) for (const res of s) { try { res.write(line); } catch (e) { /* closed */ } } },
  count: () => [...clients.values()].reduce((n, s) => n + s.size, 0),
  ping() { for (const s of clients.values()) for (const res of s) { try { res.write(": ping\n\n"); } catch (e) { /* closed */ } } },
};
setInterval(() => hub.ping(), 25000).unref();

const err = (message, code, status) => Object.assign(new HttpError(status || 400, message), { code });
const members = (cid) => all("SELECT profile_id FROM conversation_members WHERE conversation_id=?", cid).map((r) => r.profile_id);
const isMember = (cid, u) => !!get("SELECT 1 FROM conversation_members WHERE conversation_id=? AND profile_id=?", cid, u);
const blockedBetween = (a, b) => !!get("SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)", a, b, b, a);
const msgRow = (id) => get("SELECT * FROM messages WHERE id=?", id);
const MEMBER_OF = "conversation_id IN (SELECT conversation_id FROM conversation_members WHERE profile_id=?)";

/* ---------- table rules ---------- */
const BOOL = { conversations: ["is_group"] };
const TABLES = {
  conversation_members: { cols: ["conversation_id", "profile_id", "role", "last_read_at"], scope: () => MEMBER_OF, embeds: { conversations: { one: true, table: "conversations", local: "conversation_id", foreign: "id" } } },
  conversations: { cols: ["id", "is_group", "title", "created_by", "created_at", "last_message_at"], scope: () => "id IN (SELECT conversation_id FROM conversation_members WHERE profile_id=?)" },
  messages: { cols: ["id", "conversation_id", "sender_id", "body", "kind", "reply_to_id", "shared_post_id", "created_at", "deleted_at"], scope: () => MEMBER_OF,
    embeds: { message_attachments: { table: "message_attachments", local: "id", foreign: "message_id" }, message_reactions: { table: "message_reactions", local: "id", foreign: "message_id" } } },
  message_attachments: { cols: ["id", "message_id", "kind", "storage_path", "mime_type", "size_bytes", "duration_s"], scope: () => "message_id IN (SELECT id FROM messages WHERE " + MEMBER_OF + ")" },
  message_reactions: { cols: ["message_id", "profile_id", "emoji"], scope: () => "message_id IN (SELECT id FROM messages WHERE " + MEMBER_OF + ")" },
  blocks: { cols: ["blocker_id", "blocked_id", "created_at"], scope: () => "blocker_id=?" },
  notifications: { cols: ["id", "recipient_id", "type", "ref", "read_at", "created_at"], scope: () => "recipient_id=?" },
  reports: { cols: ["id"], scope: () => "reporter_id=?" },
  stories: { cols: ["id", "author_id", "media_path", "media_kind", "caption", "visibility", "created_at", "expires_at"], embeds: { story_views: { table: "story_views", local: "id", foreign: "story_id", cols: ["viewer_id"] } },
    scope: () => "(author_id=? OR visibility='public' OR (visibility='followers' AND author_id IN (SELECT target_id FROM follows WHERE follower_id=?)))", nscope: 2 },
  story_views: { cols: ["story_id", "viewer_id"], scope: () => "(viewer_id=? OR story_id IN (SELECT id FROM stories WHERE author_id=?))", nscope: 2 },
  saved_places: { cols: ["place_id", "profile_id"], scope: () => "profile_id=?" },
  food_place_reviews: { cols: ["id", "place_id", "rating", "body", "created_at", "author_id"], scope: () => "place_id IN (SELECT id FROM food_places WHERE status='approved')", noParam: true, embeds: { food_review_votes: { table: "food_review_votes", local: "id", foreign: "review_id", countOnly: true } } },
  food_review_votes: { cols: ["review_id", "profile_id"], scope: () => "profile_id=?" },
};
const OPS = { eq: "=", neq: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };

function splitTop(s) { const out = []; let d = 0, cur = ""; for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && !d) { out.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }
function pick(row, cols, T, table) { const o = {}; for (const c of cols) o[c] = row[c]; (BOOL[table] || []).forEach((b) => { if (b in o) o[b] = !!o[b]; }); return o; }

function select(u, q) {
  const T = TABLES[q.table]; if (!T) throw err("Unknown table", "42P01");
  const parts = splitTop(q.select || "*"), cols = [], embeds = [];
  for (const p of parts) { const m = /^([a-z_]+)\((.*)\)$/.exec(p); if (m) embeds.push([m[1], m[2]]); else if (p === "*") cols.push(...T.cols); else if (T.cols.includes(p)) cols.push(p); else throw err("Unknown column " + p, "42703"); }
  const where = [], args = [];
  if (!T.noParam) { where.push(T.scope(u)); for (let i = 0; i < (T.nscope || 1); i++) args.push(u); } else where.push(T.scope(u));
  for (const f of q.filters || []) {
    const [col, op, val] = f; if (!T.cols.includes(col)) throw err("Unknown column " + col, "42703");
    if (op !== "in" && val !== null && !["string", "number", "boolean"].includes(typeof val)) throw err("Invalid filter value", "22023");
    if (op === "in" && Array.isArray(val) && val.some((x) => !["string", "number"].includes(typeof x))) throw err("Invalid filter value", "22023");
    if (OPS[op]) { where.push(col + OPS[op] + "?"); args.push(typeof val === "boolean" ? +val : val); }
    else if (op === "in") { if (!Array.isArray(val) || !val.length) { where.push("0"); continue; } if (val.length > 500) throw err("Too many values", "54000"); where.push(col + " IN (" + val.map(() => "?").join(",") + ")"); args.push(...val); }
    else if (op === "is") where.push(col + (val === null ? " IS NULL" : " IS ?")), val !== null && args.push(+val);
    else throw err("Unsupported filter", "42883");
  }
  let order = ""; if (q.order && q.order.length) order = " ORDER BY " + q.order.map(([c, asc]) => { if (!T.cols.includes(c)) throw err("Unknown column", "42703"); return c + (asc === false ? " DESC" : " ASC"); }).join(",");
  const base = "FROM " + q.table + " WHERE " + where.join(" AND ");
  if (q.head) return { data: null, count: get("SELECT COUNT(*) n " + base, ...args).n };
  const lim = Math.min(Math.max(parseInt(q.limit, 10) || 1000, 1), 1000), off = Math.max(parseInt(q.offset, 10) || 0, 0);
  const rows = all("SELECT * " + base + order + " LIMIT " + lim + " OFFSET " + off, ...args);
  const out = rows.map((r) => pick(r, cols.length ? cols : T.cols, T, q.table));
  for (const [name, sub] of embeds) {
    const E = T.embeds && T.embeds[name]; if (!E) throw err("Unknown relation " + name, "PGRST200");
    const keys = [...new Set(rows.map((r) => r[E.local]))]; const byKey = new Map();
    if (keys.length) {
      const ph = keys.map(() => "?").join(",");
      if (E.countOnly) all("SELECT " + E.foreign + " k, COUNT(*) n FROM " + E.table + " WHERE " + E.foreign + " IN (" + ph + ") GROUP BY " + E.foreign, ...keys).forEach((r) => byKey.set(r.k, [{ count: r.n }]));
      else {
        const ET = TABLES[E.table], ec = E.cols || (sub === "*" || !sub ? ET.cols : splitTop(sub).filter((c) => ET.cols.includes(c)));
        const sel = [...new Set([...ec, E.foreign])]; const cond = E.one ? E.foreign : E.foreign;
        all("SELECT " + sel.join(",") + " FROM " + E.table + " WHERE " + cond + " IN (" + ph + ")", ...keys).forEach((r) => { const k = r[E.foreign]; const o = pick(r, ec, ET, E.table); if (E.one) byKey.set(k, o); else { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(o); } });
      }
    }
    out.forEach((o, i) => { const v = byKey.get(rows[i][E.local]); o[name] = E.one ? v || null : v || []; });
  }
  return { data: out };
}

/* ---------- writes ---------- */
const WRITE = {
  blocks: { allow: ["blocked_id"], force: (u) => ({ blocker_id: u, created_at: now() }), check: (u, r) => { if (!get("SELECT 1 FROM users WHERE id=?", r.blocked_id) || r.blocked_id === u) throw err("Invalid user", "22023"); }, conflict: "blocker_id,blocked_id" },
  reports: { allow: ["target_type", "target_id", "reason", "details"], force: (u) => ({ id: uid(), reporter_id: u, created_at: now() }), check: (u, r) => { if (!["message", "place", "post", "story", "profile"].includes(r.target_type) || !str(r.target_id, 120, 1) || !str(r.reason, 40, 1)) throw err("Invalid report", "22023"); r.details = str(r.details, 1000) || null; } },
  stories: { allow: ["media_path", "media_kind", "caption", "visibility"], force: (u) => ({ id: uid(), author_id: u, created_at: now(), expires_at: new Date(Date.now() + 86400000).toISOString() }),
    check: (u, r) => { if (!String(r.media_path || "").startsWith(u + "/") || !fileExists("post-media", r.media_path)) throw err("Upload the media first", "22023"); if (!["image", "video"].includes(r.media_kind) || !["public", "followers"].includes(r.visibility || "public")) throw err("Invalid story", "22023"); r.caption = str(r.caption, 200) || null; r.visibility = r.visibility || "public"; } },
  saved_places: { allow: ["place_id"], force: (u) => ({ profile_id: u }), check: (u, r) => { if (!get("SELECT 1 FROM food_places WHERE id=? AND status='approved'", r.place_id)) throw err("Place not found", "22023"); }, conflict: "place_id,profile_id" },
  food_review_votes: { allow: ["review_id"], force: (u) => ({ profile_id: u }), check: (u, r) => { const v = get("SELECT author_id FROM food_place_reviews WHERE id=?", r.review_id); if (!v) throw err("Review not found", "22023"); if (v.author_id === u) throw err("You can't vote on your own review", "22023"); } },
  food_place_reviews: { allow: ["place_id", "rating", "body"], force: (u) => ({ id: uid(), author_id: u, created_at: now() }), conflict: "place_id,author_id", update: ["rating", "body"],
    check: (u, r) => { if (!get("SELECT 1 FROM food_places WHERE id=? AND status='approved'", r.place_id)) throw err("Place not found", "22023"); r.rating = parseInt(r.rating, 10); if (!(r.rating >= 1 && r.rating <= 5)) throw err("Rating must be 1 to 5", "22023"); r.body = str(r.body, 2000) || null; },
    after: (r) => { const a = get("SELECT AVG(rating) a, COUNT(*) n FROM food_place_reviews WHERE place_id=?", r.place_id); run("UPDATE food_places SET rating_avg=?, rating_count=? WHERE id=?", Math.round((a.a || 0) * 10) / 10, a.n, r.place_id); } },
};
const DEL = { saved_places: "profile_id" };

function write(u, q) {
  const W = WRITE[q.table];
  if (q.op === "delete") {
    const col = DEL[q.table]; if (!col) throw err("Not allowed", "42501", 403);
    const f = (q.filters || []).filter((x) => x[1] === "eq" && TABLES[q.table].cols.includes(x[0]) && x[0] !== col); if (!f.length) throw err("Filter required", "42501", 403);
    run("DELETE FROM " + q.table + " WHERE " + col + "=? AND " + f.map((x) => x[0] + "=?").join(" AND "), u, ...f.map((x) => x[2])); return { data: null };
  }
  if (!W) throw err("Not allowed", "42501", 403);
  const src = q.values && typeof q.values === "object" ? q.values : {}, row = {};
  for (const k of W.allow) if (k in src) row[k] = src[k];
  W.check && W.check(u, row); Object.assign(row, W.force(u));
  const cols = Object.keys(row), sql = "INSERT INTO " + q.table + "(" + cols.join(",") + ") VALUES(" + cols.map(() => "?").join(",") + ")";
  try {
    if (q.op === "upsert" && W.update) run(sql + " ON CONFLICT(" + W.conflict + ") DO UPDATE SET " + W.update.map((c) => c + "=excluded." + c).join(","), ...cols.map((c) => row[c]));
    else if (q.op === "upsert" && W.conflict) run(sql.replace("INSERT", "INSERT OR IGNORE"), ...cols.map((c) => row[c]));
    else run(sql, ...cols.map((c) => row[c]));
  } catch (e) { if (/UNIQUE|PRIMARY/.test(e.message)) throw err("duplicate key value violates unique constraint", "23505"); throw e; }
  W.after && W.after(row);
  return { data: q.returning ? [row] : null };
}

/* ---------- storage ---------- */
const BUCKETS = { "chat-media": { max: 25 * 1048576, types: ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm", "audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg"] },
  "post-media": { max: 50 * 1048576, types: ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"] }, avatars: { max: 2 * 1048576, types: ["image/jpeg", "image/png", "image/webp"] } };
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/mpeg": "mp3" };
const EXT_MIMES = { jpg: ["image/jpeg"], jpeg: ["image/jpeg"], png: ["image/png"], webp: ["image/webp"], mp4: ["video/mp4", "audio/mp4"], webm: ["video/webm", "audio/webm"], m4a: ["audio/mp4"], ogg: ["audio/ogg"], mp3: ["audio/mpeg"] };
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_MIMES).map(([k, v]) => [k, v[0]]));
function magicOk(type, b) {
  const s = (from, t) => b.subarray(from, from + t.length).toString("latin1") === t;
  if (type === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/png") return b[0] === 0x89 && s(1, "PNG");
  if (type === "image/webp") return s(0, "RIFF") && s(8, "WEBP");
  if (type === "video/mp4" || type === "audio/mp4") return s(4, "ftyp");
  if (type === "video/webm" || type === "audio/webm") return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
  if (type === "audio/ogg") return s(0, "OggS");
  if (type === "audio/mpeg") return s(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
  return false;
}
const safePath = (p) => /^[A-Za-z0-9_\-]+\/(?:[A-Za-z0-9_\-]+\/)?[A-Za-z0-9_\-]+\.[a-z0-9]{2,4}$/.test(p) && !p.includes("..");
const fileOf = (bucket, p) => path.join(DATA_DIR, "media", bucket, p);
const fileExists = (bucket, p) => { try { return safePath(p) && fs.statSync(fileOf(bucket, p)).isFile(); } catch (e) { return false; } };
function storeFile(u, bucket, p, mime, buf) {
  const B = BUCKETS[bucket]; if (!B) throw err("Unknown bucket", "404", 404);
  const ext = String(p).split(".").pop();
  if (!safePath(p) || !p.startsWith(u + "/") || !(EXT_MIMES[ext] || []).includes(mime) || !B.types.includes(mime)) throw err("File type or path not allowed", "22023");
  if (buf.length > B.max) throw err("That file is too large (max " + Math.round(B.max / 1048576) + " MB).", "54000", 413);
  if (!magicOk(mime, buf)) throw err("The file content does not match its type", "22023");
  const f = fileOf(bucket, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf, { flag: "wx" }); return p;
}
function mayRead(u, bucket, p) {
  if (!BUCKETS[bucket] || !safePath(p)) return false;
  if (bucket !== "chat-media") return true;
  if (!u) return false;
  if (p.startsWith(u + "/")) return true;
  return !!get("SELECT 1 FROM message_attachments a JOIN messages m ON m.id=a.message_id WHERE a.storage_path=? AND m.deleted_at IS NULL AND m.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE profile_id=?)", p, u);
}

/* ---------- RPCs ---------- */
const need = (v, m) => { if (!v) throw err(m || "Invalid request", "22023"); return v; };
function direct(u, other) {
  need(other && other !== u && get("SELECT 1 FROM users WHERE id=?", other), "User not found");
  if (blockedBetween(u, other)) throw err("You can't message this person.", "42501", 403);
  const key = [u, other].sort().join(":"), ex = get("SELECT id FROM conversations WHERE direct_key=?", key); if (ex) return ex.id;
  const id = uid(), t = now();
  tx(() => { run("INSERT INTO conversations(id,is_group,direct_key,created_by,created_at,last_message_at) VALUES(?,?,?,?,?,?)", id, 0, key, u, t, t); run("INSERT INTO conversation_members(conversation_id,profile_id,role) VALUES(?,?,?)", id, u, "member"); run("INSERT INTO conversation_members(conversation_id,profile_id,role) VALUES(?,?,?)", id, other, "member"); });
  return id;
}
const RATE = new Map();
function sendMsg(u, a, extra) {
  const cid = need(a.p_cid); need(isMember(cid, u), "Conversation not found");
  const t0 = Date.now(), win = (RATE.get(u) || []).filter((x) => t0 - x < 60000); if (win.length >= 60) throw err("You're sending messages too fast.", "54000", 429); win.push(t0); RATE.set(u, win);
  const conv = get("SELECT * FROM conversations WHERE id=?", cid), others = members(cid).filter((x) => x !== u);
  if (!conv.is_group && others[0] && blockedBetween(u, others[0])) throw err("You can't message this person.", "42501", 403);
  const kind = a.p_kind || "text"; if (!["text", "image", "video", "voice", "recipe", "post", "story_reply"].includes(kind) || (kind === "story_reply" && !(extra && extra.story))) throw err("Invalid message kind", "22023");
  const body = str(a.p_body, 4000) || null; let att = null;
  if (kind === "text" || kind === "story_reply") need(body, "Write a message first.");
  if (["image", "video", "voice"].includes(kind)) {
    att = need(a.p_attachment, "Attachment required"); const sp = String(att.storage_path || "");
    need(sp.startsWith(u + "/") && fileExists("chat-media", sp), "Upload the file first");
    const ext = sp.split(".").pop(), mime = kind === "voice" ? (EXT_MIMES[ext] || []).find((m) => m.startsWith("audio/")) : (EXT_MIMES[ext] || []).find((m) => m.startsWith(kind + "/")); need(mime, "Wrong file type");
    att = { kind, storage_path: sp, mime_type: mime, size_bytes: fs.statSync(fileOf("chat-media", sp)).size, duration_s: Number.isFinite(+att.duration_s) ? Math.min(+att.duration_s, 600) : null };
  }
  let shared = null; if (kind === "recipe" || kind === "post") { shared = str(a.p_post, 120, 1); need(shared && /^(recipe|reel|video):/.test(shared), "Invalid post"); }
  let reply = null; if (a.p_reply_to) { reply = String(a.p_reply_to); need(get("SELECT 1 FROM messages WHERE id=? AND conversation_id=?", reply, cid), "Reply target not found"); }
  const id = uid(), t = now();
  tx(() => {
    run("INSERT INTO messages(id,conversation_id,sender_id,body,kind,reply_to_id,shared_post_id,created_at) VALUES(?,?,?,?,?,?,?,?)", id, cid, u, body, kind, reply, shared, t);
    if (att) run("INSERT INTO message_attachments(id,message_id,kind,storage_path,mime_type,size_bytes,duration_s) VALUES(?,?,?,?,?,?,?)", uid(), id, att.kind, att.storage_path, att.mime_type, att.size_bytes, att.duration_s);
    run("UPDATE conversations SET last_message_at=? WHERE id=?", t, cid); run("UPDATE conversation_members SET last_read_at=? WHERE conversation_id=? AND profile_id=?", t, cid, u);
    others.forEach((o) => run("INSERT INTO notifications(id,recipient_id,type,ref,created_at) VALUES(?,?,?,?,?)", uid(), o, kind === "story_reply" ? "story_reply" : "message", cid, t));
  });
  const row = msgRow(id); hub.emit(members(cid), { t: "pg", table: "messages", eventType: "INSERT", new: row }); return row;
}
const SEMO = ["❤️", "😍", "😂", "🔥", "👏", "😮"], MEMO = ["❤️", "😂", "😍", "👍", "😮", "😢", "🔥"];
function storyFor(u, sid) { return need(get("SELECT * FROM stories WHERE id=? AND expires_at>? AND (author_id=? OR visibility='public' OR (visibility='followers' AND author_id IN (SELECT target_id FROM follows WHERE follower_id=?)))", sid, now(), u, u), "Story not found"); }

const RPC = {
  get_or_create_direct: (u, a) => direct(u, a.p_other),
  create_group: (u, a) => {
    const list = [...new Set(Array.isArray(a.p_members) ? a.p_members.map(String) : [])].filter((x) => x !== u); need(list.length >= 2 && list.length <= 49, "Pick at least 2 members");
    list.forEach((m) => need(get("SELECT 1 FROM users WHERE id=?", m) && !blockedBetween(u, m), "Invalid member"));
    const id = uid(), t = now(); tx(() => { run("INSERT INTO conversations(id,is_group,title,created_by,created_at,last_message_at) VALUES(?,?,?,?,?,?)", id, 1, str(a.p_title, 80) || "Group", u, t, t); run("INSERT INTO conversation_members(conversation_id,profile_id,role) VALUES(?,?,?)", id, u, "admin"); list.forEach((m) => run("INSERT INTO conversation_members(conversation_id,profile_id,role) VALUES(?,?,?)", id, m, "member")); });
    return id;
  },
  send_message: (u, a) => sendMsg(u, a),
  mark_conversation_read: (u, a) => { need(isMember(a.p_cid, u), "Conversation not found"); const t = now(); run("UPDATE conversation_members SET last_read_at=? WHERE conversation_id=? AND profile_id=?", t, a.p_cid, u); run("UPDATE notifications SET read_at=? WHERE recipient_id=? AND ref=? AND read_at IS NULL AND type IN ('message','story_reply')", t, u, a.p_cid); hub.emit(members(a.p_cid), { t: "pg", table: "conversation_members", eventType: "UPDATE", new: { conversation_id: a.p_cid, profile_id: u, last_read_at: t } }); return null; },
  delete_message: (u, a) => { const m = need(msgRow(a.p_mid), "Message not found"); need(m.sender_id === u, "You can only delete your own messages"); run("UPDATE messages SET deleted_at=?, body=NULL WHERE id=?", now(), m.id); run("DELETE FROM message_attachments WHERE message_id=?", m.id); hub.emit(members(m.conversation_id), { t: "pg", table: "messages", eventType: "UPDATE", new: msgRow(m.id) }); return null; },
  toggle_message_reaction: (u, a) => { const m = need(msgRow(a.p_mid), "Message not found"); need(isMember(m.conversation_id, u) && MEMO.includes(a.p_emoji), "Invalid reaction"); const ex = get("SELECT 1 FROM message_reactions WHERE message_id=? AND profile_id=? AND emoji=?", m.id, u, a.p_emoji); if (ex) run("DELETE FROM message_reactions WHERE message_id=? AND profile_id=? AND emoji=?", m.id, u, a.p_emoji); else run("INSERT INTO message_reactions(message_id,profile_id,emoji) VALUES(?,?,?)", m.id, u, a.p_emoji); hub.emit(members(m.conversation_id), { t: "pg", table: "message_reactions", eventType: "UPDATE", new: { message_id: m.id } }); return null; },
  leave_conversation: (u, a) => { const c = need(get("SELECT * FROM conversations WHERE id=?", a.p_cid), "Conversation not found"); need(c.is_group && isMember(c.id, u), "You can only leave groups"); run("DELETE FROM conversation_members WHERE conversation_id=? AND profile_id=?", c.id, u); if (!members(c.id).length) run("DELETE FROM conversations WHERE id=?", c.id); return null; },
  view_story: (u, a) => { const s = storyFor(u, a.p_sid); if (s.author_id !== u) run("INSERT OR IGNORE INTO story_views(story_id,viewer_id) VALUES(?,?)", s.id, u); return null; },
  set_story_reaction: (u, a) => { const s = storyFor(u, a.p_sid); need(SEMO.includes(a.p_emoji) && s.author_id !== u, "Invalid reaction"); run("INSERT INTO story_reactions(story_id,profile_id,emoji) VALUES(?,?,?) ON CONFLICT(story_id,profile_id) DO UPDATE SET emoji=excluded.emoji", s.id, u, a.p_emoji); run("INSERT INTO notifications(id,recipient_id,type,ref,created_at) VALUES(?,?,?,?,?)", uid(), s.author_id, "story_reaction", s.id, now()); return null; },
  reply_to_story: (u, a) => { const s = storyFor(u, a.p_sid); need(s.author_id !== u, "You can't reply to your own story"); const cid = direct(u, s.author_id); sendMsg(u, { p_cid: cid, p_body: a.p_text, p_kind: "story_reply" }, { story: s.id }); return cid; },
  search_places: async (u, a) => {
    const n = (x, d) => (Number.isFinite(+x) && x !== null ? +x : d);
    const W = n(a.p_west, -180), S = n(a.p_south, -90), E = n(a.p_east, 180), N = n(a.p_north, 90);
    if (S < -90 || N > 90 || W < -180 || E > 180 || S > N) throw err("invalid bounds", "22023");
    await osm.ensure(W, S, E, N);
    const where = ["status='approved'", "lat BETWEEN ? AND ?"], args = [S, N];
    if (W <= E) { where.push("lng BETWEEN ? AND ?"); args.push(W, E); } else { where.push("(lng >= ? OR lng <= ?)"); args.push(W, E); }
    if (a.p_cat) { where.push("category_id=?"); args.push(String(a.p_cat)); }
    if (a.p_min_rating) { where.push("rating_count>0 AND rating_avg>=?"); args.push(+a.p_min_rating); }
    if (a.p_price) { where.push("price_level=?"); args.push(+a.p_price); }
    if (a.p_q) { const q = "%" + String(a.p_q).slice(0, 80).replace(/[%_\\]/g, "") + "%"; where.push("(name LIKE ? OR COALESCE(city,'') LIKE ?)"); args.push(q, q); }
    const lim = Math.min(Math.max(parseInt(a.p_limit, 10) || 200, 1), 300);
    return all("SELECT id,name,category_id,lat,lng,address,city,country_code,phone,website,opening_hours,timezone,price_level,rating_avg,rating_count,source,verification,attribution FROM food_places WHERE " + where.join(" AND ") + " ORDER BY rating_count DESC, name LIMIT " + lim, ...args)
      .map((r) => Object.assign(r, { opening_hours: r.opening_hours ? JSON.parse(r.opening_hours) : null }));
  },
  submit_place: (u, a) => {
    const name = str(a.p_name, 120, 2), lat = +a.p_lat, lng = +a.p_lng;
    if (!name || !(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180) || a.p_lat === null || a.p_lng === null) throw err("invalid place", "22023");
    if (!["restaurant", "fast-food", "cafe", "bakery", "food-truck", "street-food", "market", "dessert", "ice-cream", "seafood", "vegan", "other"].includes(a.p_category)) throw err("invalid category", "22023");
    if (a.p_website && !/^https?:\/\/[^ ]{3,300}$/i.test(a.p_website)) throw err("invalid website", "22023");
    if (a.p_country && !/^[A-Za-z]{2}$/.test(a.p_country)) throw err("invalid country code", "22023");
    if (get("SELECT COUNT(*) n FROM food_places WHERE submitted_by=? AND created_at>?", u, new Date(Date.now() - 86400000).toISOString()).n >= 10) throw err("rate limit: 10 places per day", "54000", 429);
    if (!a.p_ignore_duplicate) { const d = 0.001, dup = all("SELECT name FROM food_places WHERE status IN ('approved','pending') AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?", lat - d, lat + d, lng - d, lng + d).find((r) => r.name.toLowerCase() === name.toLowerCase() || r.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(r.name.toLowerCase())); if (dup) throw err("possible duplicate: " + dup.name, "P0001"); }
    const id = uid(), status = process.env.PLACES_AUTO_APPROVE === "0" ? "pending" : "approved";
    run("INSERT INTO food_places(id,name,category_id,lat,lng,address,city,country_code,phone,website,source,verification,status,submitted_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, name, a.p_category, lat, lng, str(a.p_address, 200) || null, str(a.p_city, 80) || null, a.p_country ? String(a.p_country).toUpperCase() : null, str(a.p_phone, 30) || null, a.p_website || null, "user", "community", status, u, now());
    return id;
  },
};

function query(u, q) {
  if (!u && !(q.table === "food_place_reviews" && (q.op === "select" || !q.op))) throw err("Log in first.", "401", 401);
  try { return q.op === "select" || !q.op ? select(u, q) : write(u, q); }
  catch (e) { if (e instanceof HttpError) return { error: { message: e.message, code: e.code || String(e.status) } }; throw e; }
}
function rpc(u, name, args) {
  if (!u && name !== "search_places") throw err("Log in first.", "401", 401);
  const f = RPC[name]; if (!f) return { error: { message: "Unknown function", code: "42883" } };
  const fail = (e) => { if (e instanceof HttpError) return { error: { message: e.message, code: e.code || String(e.status) } }; throw e; };
  try { const r = f(u, args || {}); return r && typeof r.then === "function" ? r.then((v) => ({ data: v === undefined ? null : v }), fail) : { data: r === undefined ? null : r }; } catch (e) { return fail(e); }
}
function broadcast(u, channel, event, payload) {
  const m = /^typing-([0-9a-f-]{36})$/.exec(String(channel)); if (!m || event !== "typing" || !isMember(m[1], u)) throw err("Not allowed", "42501", 403);
  hub.emit(members(m[1]).filter((x) => x !== u), { t: "bc", channel, event, payload: { u } });
}
module.exports = { hub, query, rpc, broadcast, storeFile, mayRead, fileOf, BUCKETS, MIME_BY_EXT, EXT_MIMES, fileExists };
