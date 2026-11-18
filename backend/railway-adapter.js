/* ==========================================================================
   SIMPLE COOK — Railway adapter  (backend/railway-adapter.js)
   Active when /config.js says backend:"railway" (the Node server in /server serves that file).
   Reads stay synchronous (from an in-memory snapshot), writes are optimistic with rollback.
   It also provides SC.dm, the bridge used by Messages, Food map and the camera scanners,
   backed by the server's /api/db, /api/rpc, /api/upload, /api/ai and a Server-Sent-Events stream.
   Security does NOT depend on this file: the server re-checks everything.
   ========================================================================== */
(function () {
  "use strict";
  const SC = (window.SC = window.SC || {});
  const Api = SC.Api, D = window.SC_DATA, cfg = window.SC_CONFIG || {}, Store = SC.Store;
  if (cfg.backend !== "railway") return;
  SC.backend = { mode: "railway", env: cfg.env || "production", features: cfg.features || {} };

  const SNAP = { users: [], posts: [], session: null, comments: {}, profile_overrides: {} };
  const V = { counts: {}, stats: {}, react: new Map(), saves: new Set(), follows: new Set(), cLoaded: new Set(), viewed: new Set(), shared: new Set() };
  const key = (i) => i.type + ":" + i.id;
  const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
  const toastErr = (m) => SC.ui && SC.ui.toast && SC.ui.toast(m, { type: "error" });

  /* ---- localStorage keys that now live on the server are served from the snapshot ---- */
  const origGet = Store.get.bind(Store);
  Store.get = (k, fb) => (k === "users" ? SNAP.users : k === "posts" ? SNAP.posts : k === "session" ? (SNAP.session && SNAP.session.username) || null : k === "comments" ? SNAP.comments : k === "profile_overrides" ? SNAP.profile_overrides : origGet(k, fb));

  /* ---- HTTP ---- */
  async function call(method, url, body, opts) {
    let r;
    try {
      r = await fetch(url, Object.assign({ method, credentials: "same-origin", headers: Object.assign({ "X-SC": "1" }, body !== undefined ? { "Content-Type": "application/json" } : {}), body: body !== undefined ? JSON.stringify(body) : undefined }, opts || {}));
    } catch (e) { if (e && e.name === "AbortError") throw e; const x = new Error("Can't reach the server. Check your connection and try again."); x.network = true; throw x; }
    let j = null; try { j = await r.json(); } catch (e) { /* empty */ }
    if (!r.ok) { const x = new Error((j && (typeof j.error === "string" ? j.error : j.error && j.error.message)) || "Something went wrong. Please try again."); x.status = r.status; x.code = j && j.error && j.error.code; throw x; }
    return j;
  }
  const msg = (e) => (e && e.message) || "Something went wrong. Please try again.";

  /* ---- snapshot ---- */
  function applyState(s) {
    SNAP.users = s.users.map((u) => (s.session && u.username === s.session.username ? Object.assign({ email: s.session.email }, u) : u));
    SNAP.posts = s.posts; SNAP.session = s.session;
    V.counts = s.counts || {}; V.stats = s.userStats || {};
    V.react = new Map(Object.entries(s.my.reactions)); V.saves = new Set(s.my.saves); V.follows = new Set(s.my.follows);
    SC.runtime = SC.runtime || { blobs: {} };
    SNAP.posts.forEach((p) => { if (p.media) SC.runtime.blobs[p.id] = p.media; });
    [].concat(D.RECIPES, D.REELS, D.VIDEOS).forEach((i) => { i._pid = key(i); });   // chat shares posts by key
    Api._invalidate();
  }
  async function refresh(quiet) { applyState(await call("GET", "/api/state")); if (!quiet) emit("sc:stats"); }
  let statsTimer = null;
  const refreshSoon = () => { clearTimeout(statsTimer); statsTimer = setTimeout(() => { refresh().catch(() => {}); }, 1200); };

  /* ---- uploads ---- */
  const dataUrlToBlob = (u) => { const [h, b] = u.split(","), mime = /data:([^;]+)/.exec(h)[1], bin = atob(b), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: mime }); };
  const extOf = (t) => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" }[t]);
  function checkFile(blob, kinds, max) {
    if (!kinds.includes(blob.type)) throw new Error("Unsupported file type: " + (blob.type || "unknown"));
    if (blob.size > max) throw new Error("That file is too large (max " + Math.round(max / 1048576) + " MB).");
  }
  async function putFile(bucket, path, blob) {
    const r = await fetch("/api/upload?bucket=" + encodeURIComponent(bucket) + "&path=" + encodeURIComponent(path), { method: "POST", credentials: "same-origin", headers: { "X-SC": "1", "Content-Type": blob.type || "application/octet-stream" }, body: blob }).catch(() => { throw new Error("Can't reach the server. Check your connection and try again."); });
    if (!r.ok) { let j = null; try { j = await r.json(); } catch (e) { /* empty */ } throw new Error((j && j.error && (j.error.message || j.error)) || "Upload failed."); }
  }
  async function upload(bucket, blob, ext) {
    const path = SNAP.session.uuid + "/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + "." + ext;
    await putFile(bucket, path, blob); return "/media/" + bucket + "/" + path;
  }

  /* ---- optimistic write helper ---- */
  async function bg(p, rollback, label) {
    try { await p; refreshSoon(); return true; } catch (e) { rollback(); emit("sc:rollback"); toastErr(msg(e)); console.warn("[backend] " + label, e); return false; }
  }
  const bump = (k, f, d) => { const c = (V.counts[k] = V.counts[k] || { likes: 0, dislikes: 0, comments: 0, saves: 0, shares: 0, views: 0 }); c[f] = Math.max(0, c[f] + d); };
  const bumpUser = (u, f, d) => { const s = (V.stats[u] = V.stats[u] || { points: 0, followers: 0, following: 0 }); s[f] = Math.max(0, s[f] + d); };

  /* ---- comments are fetched lazily ---- */
  function loadComments(k) {
    if (V.cLoaded.has(k)) return; V.cLoaded.add(k);
    call("GET", "/api/comments?key=" + encodeURIComponent(k)).then((r) => { SNAP.comments[k] = r.comments.slice().reverse(); emit("sc:comments", { key: k }); }, () => V.cLoaded.delete(k));
  }
  const baseComments = Api.comments;

  Object.assign(Api, {
    async init() {
      await refresh(true); connectEvents(); setupDm();
      setInterval(() => { if (document.visibilityState === "visible" && navigator.onLine) refresh().catch(() => {}); }, 60000);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh().catch(() => {}); });
    },
    refresh() { return refresh(); },

    /* ---- auth ---- */
    emailTaken() { return false; },                           // never reveal whether an email is registered
    accountExists() { return true; },
    isDemoEmail() { return false; },
    async signUp(d) {
      try { await call("POST", "/api/auth/signup", { username: d.username, email: d.email, password: d.password, name: d.name }); await refresh(true); connectEvents(); return { user: Api.me() }; }
      catch (e) { return { error: msg(e) }; }
    },
    async login(identifier, password) {
      try { await call("POST", "/api/auth/login", { identifier, password }); await refresh(true); connectEvents(); return Api.me() ? { user: Api.me() } : { error: "Could not load your account." }; }
      catch (e) { return { error: msg(e) }; }
    },
    async logout() {
      SNAP.session = null; V.react = new Map(); V.saves = new Set(); V.follows = new Set(); Api._invalidate(); disconnectEvents();
      try { await call("POST", "/api/auth/logout", {}); } catch (e) { /* cookie expires anyway */ }
      refresh(true).catch(() => {});
    },
    async requestPasswordReset(email) { try { await call("POST", "/api/auth/reset/request", { email }); return { ok: true }; } catch (e) { return { error: msg(e) }; } },
    async completePasswordReset(email, code, password) { try { await call("POST", "/api/auth/reset/complete", { email, code, password }); return { ok: true }; } catch (e) { return { error: msg(e) }; } },
    async updateProfile(patch) {
      if (!SNAP.session) return null;
      try {
        const body = {}; if (patch.name !== undefined) body.name = patch.name; if (patch.bio !== undefined) body.bio = patch.bio;
        if (patch.avatar && patch.avatar.startsWith("data:")) { const b = dataUrlToBlob(patch.avatar); checkFile(b, ["image/jpeg", "image/png", "image/webp"], 2 * 1048576); body.avatar = await upload("avatars", b, extOf(b.type)); }
        await call("POST", "/api/profile", body); await refresh(true);
      } catch (e) { toastErr(msg(e)); }
      return Api.me();
    },

    /* ---- content ---- */
    async create(type, data) {
      if (!SNAP.session) return { error: "Log in to post." };
      try {
        const body = Object.assign({}, data); delete body._videoFile;
        if (typeof body.ph === "string" && body.ph.startsWith("data:")) { const b = dataUrlToBlob(body.ph); checkFile(b, ["image/jpeg", "image/png", "image/webp"], 5 * 1048576); body.ph = await upload("post-media", b, extOf(b.type)); }
        if (data._videoFile) { checkFile(data._videoFile, ["video/mp4", "video/webm"], 50 * 1048576); body.media = await upload("post-media", data._videoFile, extOf(data._videoFile.type)); }
        const r = await call("POST", "/api/posts", { type, data: body }), item = r.item;
        SNAP.posts = [item].concat(SNAP.posts); if (item.media) { SC.runtime = SC.runtime || { blobs: {} }; SC.runtime.blobs[item.id] = item.media; }
        Api._invalidate(); refreshSoon(); return { item, persisted: true };
      } catch (e) { return { error: msg(e) }; }
    },
    async remove(k) {
      const it = this.item(k); if (!it || !this.isOwn(it)) return false;
      try { await call("POST", "/api/posts/delete", { key: k }); } catch (e) { toastErr(msg(e)); return false; }
      SNAP.posts = SNAP.posts.filter((p) => key(p) !== k); Api._invalidate(); refreshSoon(); return true;
    },

    /* ---- counts + my state (server numbers are the truth; we adjust optimistically) ---- */
    counts(it) { const c = V.counts[key(it)] || {}; return { likes: it.likes + (c.likes || 0), dislikes: it.dislikes + (c.dislikes || 0), comments: it.comments + (c.comments || 0), saves: it.saves + (c.saves || 0), shares: it.shares + (c.shares || 0), views: it.views + (c.views || 0) }; },
    my(k) { return SNAP.session ? { reaction: V.react.get(k) || 0, saved: V.saves.has(k) } : { reaction: 0, saved: false }; },
    react(k, value) {
      const it = this.item(k); if (!SNAP.session || !it) return null;
      const prev = V.react.get(k) || 0, next = prev === value ? 0 : value;
      const adj = (v, d) => { if (v === 1) bump(k, "likes", d); if (v === -1) bump(k, "dislikes", d); };
      adj(prev, -1); adj(next, +1); if (next) V.react.set(k, next); else V.react.delete(k);
      bg(call("POST", "/api/react", { key: k, value: next }), () => { adj(next, -1); adj(prev, +1); if (prev) V.react.set(k, prev); else V.react.delete(k); }, "react");
      return next;
    },
    toggleSave(k) {
      const it = this.item(k); if (!SNAP.session || !it) return null;
      const on = !V.saves.has(k); if (on) V.saves.add(k); else V.saves.delete(k); bump(k, "saves", on ? 1 : -1);
      bg(call("POST", "/api/save", { key: k, on }), () => { if (on) V.saves.delete(k); else V.saves.add(k); bump(k, "saves", on ? -1 : 1); }, "save");
      return on;
    },
    saved() { return SNAP.session ? [...V.saves].map((k) => this.item(k)).filter(Boolean) : []; },
    isFollowing(u) { return !!(SNAP.session && V.follows.has(u)); },
    toggleFollow(u) {
      const me = SNAP.session; if (!me || me.username === u || !this.user(u)) return null;
      const on = !V.follows.has(u), d = on ? 1 : -1, apply = (n) => { bumpUser(u, "followers", n); bumpUser(me.username, "following", n); };
      if (on) V.follows.add(u); else V.follows.delete(u); apply(d);
      bg(call("POST", "/api/follow", { username: u, on }), () => { if (on) V.follows.delete(u); else V.follows.add(u); apply(-d); }, "follow");
      return on;
    },
    view(k) { const it = this.item(k); if (!SNAP.session || !it || V.viewed.has(k)) return false; V.viewed.add(k); call("POST", "/api/view", { key: k }).catch(() => {}); bump(k, "views", 1); return true; },
    share(k) { const it = this.item(k); if (!SNAP.session || !it || V.shared.has(k)) return false; V.shared.add(k); call("POST", "/api/share", { key: k }).catch(() => {}); bump(k, "shares", 1); return true; },
    async reportRecipe(k, reason, details) {
      if (!SNAP.session) return { error: "Log in to report a problem." };
      try { await call("POST", "/api/report", { key: k, reason, details }); return { ok: true, message: "Thanks! Your report was sent to our moderators." }; } catch (e) { return { error: msg(e) }; }
    },
    comments(k) { loadComments(k); return baseComments.call(this, k); },
    async addComment(k, text) {
      const it = this.item(k); text = String(text || "").trim().slice(0, 500); if (!SNAP.session || !it || !text) return null;
      try { const r = await call("POST", "/api/comments", { key: k, text }); (SNAP.comments[k] = SNAP.comments[k] || []).push(r.comment); bump(k, "comments", 1); refreshSoon(); return r.comment; }
      catch (e) { toastErr(msg(e)); return null; }
    },
    stats(username) {
      const u = this.user(username); if (!u) return null; const s = V.stats[username] || {};
      return { followers: (u.followers || 0) + (s.followers || 0), following: (u.following || 0) + (s.following || 0), points: Math.max(0, (u.points || 0) + (s.points || 0)),
        posts: this.itemsBy(username, "recipe").length + this.itemsBy(username, "reel").length + this.itemsBy(username, "video").length };
    },
    resetAll() { /* production data is never wiped from the browser */ },
  });

  /* ======================= SC.dm: bridge for Messages, Food map, camera ======================= */
  const asErr = (e) => ({ message: msg(e), code: e && e.code, context: { status: e && e.status } });
  class Q {
    constructor(table) { this.q = { table, op: "select", filters: [], order: [] }; this.mode = null; }
    select(cols, o) { if (this.q.op === "select") { this.q.select = cols || "*"; if (o && o.count) this.q.count = o.count; if (o && o.head) this.q.head = true; } else this.q.returning = true; return this; }
    _f(op, c, v) { this.q.filters.push([c, op, v]); return this; }
    eq(c, v) { return this._f("eq", c, v); } neq(c, v) { return this._f("neq", c, v); } lt(c, v) { return this._f("lt", c, v); } lte(c, v) { return this._f("lte", c, v); }
    gt(c, v) { return this._f("gt", c, v); } gte(c, v) { return this._f("gte", c, v); } in(c, v) { return this._f("in", c, v); } is(c, v) { return this._f("is", c, v); }
    order(c, o) { this.q.order.push([c, !(o && o.ascending === false)]); return this; }
    limit(n) { this.q.limit = n; return this; }
    range(a, b) { this.q.offset = a; this.q.limit = b - a + 1; return this; }
    single() { this.mode = "single"; return this; } maybeSingle() { this.mode = "maybe"; return this; }
    insert(v) { this.q.op = "insert"; this.q.values = v; return this; }
    upsert(v, o) { this.q.op = "upsert"; this.q.values = v; this.q.onConflict = o && o.onConflict; return this; }
    update() { this.q.op = "update"; return this; }
    delete() { this.q.op = "delete"; return this; }
    async exec() {
      let r;
      try { r = await call("POST", "/api/db", this.q); } catch (e) { return { data: null, error: asErr(e) }; }
      if (r.error) return { data: null, error: r.error };
      let data = r.data;
      if (this.mode && Array.isArray(data)) { if (data.length > 1 && this.mode === "single") return { data: null, error: { message: "Multiple rows", code: "PGRST116" } }; if (!data.length && this.mode === "single") return { data: null, error: { message: "No rows found", code: "PGRST116" } }; data = data[0] || null; }
      return { data, error: null, count: r.count };
    }
    then(a, b) { return (this._p = this._p || this.exec()).then(a, b); }
  }
  function rpc(fn, args) {
    let signal = null;
    const run = () => call("POST", "/api/rpc", { fn, args: args || {} }, signal ? { signal } : undefined).then((r) => (r.error ? { data: null, error: r.error } : { data: r.data, error: null }), (e) => (e && e.name === "AbortError" ? { data: null, error: { message: "aborted", code: "20" } } : { data: null, error: asErr(e) }));
    const t = { abortSignal(s) { signal = s; return t; }, then(a, b) { return (t._p = t._p || run()).then(a, b); } };
    return t;
  }
  const bucket = (name) => ({
    async upload(path, file) { try { await putFile(name, path, file); return { data: { path }, error: null }; } catch (e) { return { data: null, error: { message: msg(e) } }; } },
    getPublicUrl: (path) => ({ data: { publicUrl: "/media/" + name + "/" + path } }),
    createSignedUrl: async (path) => ({ data: { signedUrl: "/media/" + name + "/" + path }, error: null }),
  });
  async function invoke(name, body) {
    try { return { data: await call("POST", "/api/ai/" + name, body), error: null }; }
    catch (e) { return { data: null, error: { message: msg(e), context: { status: e.status || 0 } } }; }
  }

  /* realtime: one Server-Sent-Events stream; channels register listeners on it */
  const channels = new Set(); let es = null, wasOpen = false;
  function channel(name) {
    const ch = { name, ls: [], on(type, filter, cb) { ch.ls.push({ type, filter: filter || {}, cb }); return ch; }, subscribe() { channels.add(ch); return ch; },
      send(m) { return call("POST", "/api/broadcast", { channel: name, event: m.event, payload: m.payload }).catch(() => {}); } };
    return ch;
  }
  function dispatch(evt) {
    if (evt.t === "state") { refreshSoon(); return; }
    for (const ch of channels) for (const l of ch.ls) {
      if (evt.t === "pg" && l.type === "postgres_changes" && l.filter.table === evt.table && (!l.filter.event || l.filter.event === "*" || l.filter.event === evt.eventType)) l.cb({ eventType: evt.eventType, new: evt.new || {}, old: evt.old || {}, table: evt.table, schema: "public" });
      if (evt.t === "bc" && l.type === "broadcast" && ch.name === evt.channel && l.filter.event === evt.event) l.cb({ payload: evt.payload });
    }
  }
  /* opening a link to something posted a moment ago (our snapshot has not seen it yet): fetch once, then redraw */
  window.addEventListener("hashchange", () => {
    const m = location.hash.match(/^#\/(recipe|reels|video)\/([^/?]+)/); if (!m || !SNAP.session) return;
    const k = (m[1] === "reels" ? "reel" : m[1]) + ":" + decodeURIComponent(m[2]);
    if (!Api.item(k)) refresh(true).then(() => { if (Api.item(k)) emit("sc:auth"); }).catch(() => {});
  });
  function connectEvents() {
    if (es || !SNAP.session || !window.EventSource) return;
    es = new EventSource("/api/events");
    es.onopen = () => { if (wasOpen) { emit("sc:reconnect"); refreshBadge(); } wasOpen = true; };
    es.onmessage = (m) => { let evt; try { evt = JSON.parse(m.data); } catch (e) { return; } dispatch(evt);
      if (evt.t === "pg" && evt.table === "messages" && evt.eventType === "INSERT" && evt.new && evt.new.sender_id !== meId()) { refreshBadge(); emit("sc:message", evt.new); } };
  }
  function disconnectEvents() { if (es) es.close(); es = null; wasOpen = false; channels.clear(); }
  const meId = () => (SNAP.session ? SNAP.session.uuid : null);
  async function refreshBadge() {
    const els = document.querySelectorAll(".dm-badge"); if (!els.length || !meId()) return;
    const r = await SC.dm.from("notifications").select("id", { count: "exact", head: true }).eq("recipient_id", meId()).is("read_at", null).in("type", ["message", "story_reaction", "story_reply"]);
    const n = r.count || 0; els.forEach((el) => { el.textContent = n > 99 ? "99+" : n; el.hidden = !n; });
  }
  function setupDm() {
    SC.dm = Object.freeze({ me: meId, from: (t) => new Q(t), rpc, bucket, invoke, channel, drop: (c) => channels.delete(c) });
    SC.refreshBadge = refreshBadge; if (SNAP.session) refreshBadge();
    document.addEventListener("sc:auth", () => refreshBadge());
  }
})();
