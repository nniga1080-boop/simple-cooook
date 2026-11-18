/* ==========================================================================
   SIMPLE COOK — Supabase adapter  (backend/supabase-adapter.js)
   --------------------------------------------------------------------------
   Loaded after api.js. When config.js contains a Supabase URL + publishable key
   it REPLACES the localStorage methods of SC.Api with real ones; otherwise it
   does nothing and the site runs in local demo mode exactly as before.

   Design: reads stay synchronous (served from an in-memory cache filled at boot),
   so views.js / ui.js did not need rewriting. Writes are optimistic: the UI
   updates at once, the request goes to the server, and on failure the change is
   rolled back with an error toast. Security does NOT depend on this file:
   every rule (ownership, points, counters, limits) is enforced by Postgres
   (see supabase/migrations). A tampered browser can only do what RLS allows.
   ========================================================================== */
(function () {
  "use strict";
  const SC = (window.SC = window.SC || {});
  const Api = SC.Api, D = window.SC_DATA, cfg = window.SC_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabasePublishableKey);

  SC.backend = { mode: enabled ? "supabase" : "local", env: cfg.env || "development" };
  Api.init = () => Promise.resolve();            // local mode: nothing to load
  Api.requestPasswordReset = null;
  if (!enabled) return;

  const SB_SRC = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.109.0/dist/umd/supabase.js";
  const RESERVED = ["simplecook", "admin", "support", "me", "explore", "create", "reels", "videos", "login", "signup", "profile", "forgot", "reset"];
  const PAGE = 200, MAX_ITEMS = 2000;                          // see docs: server-side paging comes with the 1,000-recipe phase
  const MAX_IMAGE = 5 * 1024 * 1024, MAX_VIDEO = 50 * 1024 * 1024;
  let sb = null;

  /* ------------------------------ cache ------------------------------ */
  const S = {
    users: new Map(),            // username -> user
    items: [], itemMap: new Map(), // key "type:slug" -> item
    me: null,
    my: { react: new Map(), saves: new Set(), follows: new Set() },  // by key / username
    comments: new Map(),         // key -> { list, loading, loaded }
    viewed: new Set(), shared: new Set(),
  };
  const key = (i) => i.type + ":" + i.id;
  const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
  const toastErr = (m) => SC.ui && SC.ui.toast && SC.ui.toast(m, { type: "error" });

  function friendly(err) {
    const m = String((err && (err.message || err.msg)) || err || "");
    const code = err && err.code;
    if (code === "54000" || /rate limit/i.test(m)) return "You're doing that too often. Please wait a few minutes and try again.";
    if (/Invalid login credentials/i.test(m)) return "Incorrect email or password.";
    if (/Email not confirmed/i.test(m)) return "Please verify your email first. Check your inbox for the confirmation link.";
    if (/already registered|already been registered/i.test(m)) return "An account with this email already exists.";
    if (/password.*(short|weak|least)/i.test(m)) return "Choose a stronger password (at least 8 characters).";
    if (code === "42501" || /row-level security|permission denied/i.test(m)) return "You don't have permission to do that.";
    if (/Failed to fetch|NetworkError|network/i.test(m)) return "Can't reach the server. Check your connection and try again.";
    if (/Database error saving new user|23505/.test(m + code)) return "That username is taken. Try another.";
    console.warn("[backend]", err);
    return "Something went wrong. Please try again.";
  }

  /* ------------------------------ mapping ------------------------------ */
  function mapUser(r) {
    return { id: r.username, uuid: r.id, username: r.username, name: r.display_name, bio: r.bio || "", avatar: r.avatar_url || null,
      hue: r.hue || 0, official: !!r.is_official, followers: r.followers_count, following: r.following_count,
      points: r.points, createdAt: Date.parse(r.created_at) };
  }
  const POST_SELECT = `id,slug,kind,title,caption,cover_ref,media_url,duration_s,source,likes_count,dislikes_count,comments_count,saves_count,shares_count,views_count,created_at,
    author:profiles!posts_author_id_fkey(username),
    recipe:recipes!recipes_post_id_kind_fkey(description,difficulty,prep_minutes,cook_minutes,servings,tips,
      ingredients:recipe_ingredients(position,raw_text), steps:recipe_steps(position,body)),
    cats:post_categories(category_id), tags:post_tags(tag),
    rlinks:post_recipe_links(position,label,recipe_id), elinks:post_links(position,label,url)`;

  function mapPost(r, idToSlug) {
    const byPos = (a, b) => a.position - b.position;
    const it = {
      type: r.kind, id: r.slug, _pid: r.id, source: r.source === "official" ? "fixed" : "community",
      author: r.author ? r.author.username : D.OFFICIAL, title: r.title, ph: r.cover_ref || "",
      cats: (r.cats || []).map((c) => c.category_id), tags: (r.tags || []).map((t) => t.tag),
      dur: r.duration_s || 0, createdAt: Date.parse(r.created_at),
      likes: r.likes_count, dislikes: r.dislikes_count, comments: r.comments_count,
      saves: r.saves_count, shares: r.shares_count, views: r.views_count,
    };
    it.age = Math.max(0, (Date.now() - it.createdAt) / 86400000);
    if (r.kind === "recipe" && r.recipe) {
      const x = r.recipe;
      Object.assign(it, { desc: x.description, diff: x.difficulty, prep: x.prep_minutes, cook: x.cook_minutes, serves: x.servings,
        tips: x.tips || [], ing: (x.ingredients || []).sort(byPos).map((i) => i.raw_text), steps: (x.steps || []).sort(byPos).map((s) => s.body) });
    } else if (r.kind === "reel") it.cap = r.caption || "";
    else it.desc = r.caption || "";
    const rl = (r.rlinks || []).slice().sort(byPos);
    if (r.kind === "reel") { const f = rl[0] && idToSlug.get(rl[0].recipe_id); it.recipe = f || ""; }
    if (r.kind === "video") {
      it.links = rl.map((l) => ({ label: l.label || "Recipe", url: "#/recipe/" + idToSlug.get(l.recipe_id) })).filter((l) => !/undefined$/.test(l.url))
        .concat((r.elinks || []).slice().sort(byPos).map((l) => ({ label: l.label, url: l.url })));
    }
    if (r.media_url) { SC.runtime = SC.runtime || { blobs: {} }; SC.runtime.blobs[it.id] = r.media_url; }
    return it;
  }
  function putItem(it) {
    const k = key(it), old = S.itemMap.get(k);
    if (old) S.items[S.items.indexOf(old)] = it; else S.items.unshift(it);
    S.itemMap.set(k, it);
  }

  /* ------------------------------ loading ------------------------------ */
  function loadScript(src) {
    return new Promise((res, rej) => {
      if (window.supabase) return res();
      const s = document.createElement("script");
      s.src = src; s.crossOrigin = "anonymous"; s.onload = res; s.onerror = () => rej(new Error("Could not load supabase-js"));
      document.head.appendChild(s);
    });
  }
  async function loadProfiles() {
    const { data, error } = await sb.from("profiles").select("id,username,display_name,bio,avatar_url,hue,is_official,points,followers_count,following_count,created_at").limit(1000);
    if (error) throw error;
    S.users.clear(); data.forEach((r) => S.users.set(r.username, mapUser(r)));
  }
  async function loadCatalog() {
    const rows = [];
    for (let from = 0; from < MAX_ITEMS; from += PAGE) {
      const { data, error } = await sb.from("posts").select(POST_SELECT).eq("status", "published")
        .order("created_at", { ascending: false }).range(from, from + PAGE - 1);
      if (error) throw error;
      rows.push(...data); if (data.length < PAGE) break;
    }
    const idToSlug = new Map(rows.map((r) => [r.id, r.slug]));
    S.items = rows.map((r) => mapPost(r, idToSlug));
    S.itemMap = new Map(S.items.map((i) => [key(i), i]));
  }
  async function loadMe() {
    const { data: sess } = await sb.auth.getSession();
    S.me = null; S.my = { react: new Map(), saves: new Set(), follows: new Set() };
    if (!sess.session) return;
    const { data, error } = await sb.rpc("my_profile");
    if (error || !data || !data.length) return;
    const p = data[0];
    S.me = mapUser({ ...p, is_official: false });
    const pidToKey = new Map(S.items.map((i) => [i._pid, key(i)]));
    const idToName = new Map([...S.users.values()].map((u) => [u.uuid, u.username]));
    const [rx, sv, fl] = await Promise.all([
      sb.from("post_reactions").select("post_id,value"), sb.from("saved_content").select("post_id"),
      sb.from("follows").select("followee_id").eq("follower_id", p.id),
    ]);
    (rx.data || []).forEach((r) => { const k = pidToKey.get(r.post_id); if (k) S.my.react.set(k, r.value); });
    (sv.data || []).forEach((r) => { const k = pidToKey.get(r.post_id); if (k) S.my.saves.add(k); });
    (fl.data || []).forEach((r) => { const n = idToName.get(r.followee_id); if (n) S.my.follows.add(n); });
  }
  let statsTimer = null;
  const refreshStatsSoon = () => { clearTimeout(statsTimer); statsTimer = setTimeout(async () => { try { await loadProfiles(); if (S.me) S.me = S.users.get(S.me.username) || S.me; emit("sc:stats"); } catch (e) { /* ignore */ } }, 900); };

  /* ------------------------------ helpers ------------------------------ */
  async function bg(promise, rollback, label) {            // background write with rollback
    try { const r = await promise; if (r && r.error) throw r.error; refreshStatsSoon(); return true; }
    catch (e) { rollback(); emit("sc:rollback"); toastErr(friendly(e)); console.warn("[backend] " + label, e); return false; }
  }
  const dataUrlToBlob = (u) => { const [h, b] = u.split(","), mime = /data:([^;]+)/.exec(h)[1], bin = atob(b), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: mime }); };
  async function upload(bucket, blob, ext) {
    const uid = (await sb.auth.getUser()).data.user.id;      // folder = auth.uid(): enforced by Storage policy
    const path = uid + "/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + "." + ext;
    const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType: blob.type, upsert: false });
    if (error) throw error;
    return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }
  const extOf = (t) => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" }[t]);
  function checkFile(blob, kinds, max) {
    if (!kinds.includes(blob.type)) throw new Error("Unsupported file type: " + (blob.type || "unknown"));
    if (blob.size > max) throw new Error("That file is too large (max " + Math.round(max / 1048576) + " MB).");
  }

  /* ------------------------------ API overrides ------------------------------ */
  const base = { rank: Api.rank, score: Api.score };      // inherited unchanged: rank/score/search/matches/related/rating
  Object.assign(Api, {
    async init() {
      await loadScript(SB_SRC);
      sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey,
        { auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      SC.sb = null;                                         // deliberately NOT exposed on window.SC
      // Narrow bridge for Phase 4 chat/stories (RLS + RPC still enforce everything server-side).
      SC.dm = Object.freeze({ rpc: (n, x) => sb.rpc(n, x), from: (t) => sb.from(t), bucket: (b) => sb.storage.from(b), invoke: (n, body) => sb.functions.invoke(n, { body }), channel: (n, o) => sb.channel(n, o), drop: (c) => sb.removeChannel(c), me: () => (S.me && S.me.uuid) || null });
      await Promise.all([loadProfiles(), loadCatalog()]);
      await loadMe();
      // The confirm-email link returns with ?code=...; clean it so the hash router is unaffected.
      if (/[?&]code=/.test(location.search)) history.replaceState(null, "", location.pathname + location.hash);
      sb.auth.onAuthStateChange(async (event) => {
        if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
          const was = S.me && S.me.username; await loadMe();
          if ((S.me && S.me.username) !== was) emit("sc:auth");
        }
      });
    },
    async refresh() { await Promise.all([loadProfiles(), loadCatalog()]); await loadMe(); emit("sc:stats"); },

    /* ---- auth ---- */
    me() { return S.me; },
    user(u) { return u ? S.users.get(String(u).toLowerCase()) || null : null; },
    users() { return [...S.users.values()]; },
    usernameTaken(u) { u = String(u || "").trim().toLowerCase(); return RESERVED.includes(u) || S.users.has(u); },   // fast pre-check; the server is the authority
    emailTaken() { return false; },                         // never reveal whether an email is registered
    accountExists() { return true; },                       // same: password reset always "succeeds" for the user
    isDemoEmail() { return false; },
    async signUp(d) {
      const username = String(d.username || "").trim().toLowerCase(), email = String(d.email || "").trim().toLowerCase();
      if (!/^[a-z0-9_.]{3,20}$/.test(username)) return { error: "Use 3 to 20 letters, numbers, dots or underscores." };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email address." };
      if (String(d.password || "").length < 8) return { error: "Use at least 8 characters." };
      const ok = await sb.rpc("username_available", { candidate: username });
      if (ok.error) return { error: friendly(ok.error) };
      if (!ok.data) return { error: "That username is taken. Try another." };
      const { data, error } = await sb.auth.signUp({ email, password: d.password,
        options: { data: { username, display_name: d.name || username }, emailRedirectTo: location.origin + location.pathname } });
      if (error) return { error: friendly(error) };
      if (!data.session) return { needsVerification: true, email };      // "Confirm email" is ON: no session until the link is clicked
      await Promise.all([loadProfiles(), loadMe()]);
      return { user: S.me };
    },
    async login(identifier, password) {
      const email = String(identifier || "").trim().toLowerCase();
      if (!email.includes("@")) return { error: "Log in with your email address." };
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return { error: friendly(error) };
      await Promise.all([loadProfiles(), loadMe()]);
      return S.me ? { user: S.me } : { error: "Your account has no profile yet. Please contact support." };
    },
    async logout() { await sb.auth.signOut(); S.me = null; S.my = { react: new Map(), saves: new Set(), follows: new Set() }; },
    async requestPasswordReset(email) {                     // email contains a 6-digit code (see docs/SETUP.md, email templates)
      const { error } = await sb.auth.resetPasswordForEmail(String(email).trim().toLowerCase());
      return error ? { error: friendly(error) } : { ok: true };
    },
    async completePasswordReset(email, code, password) {
      const v = await sb.auth.verifyOtp({ email: String(email).trim().toLowerCase(), token: String(code).trim(), type: "recovery" });
      if (v.error) return { error: "That code is invalid or has expired." };
      const u = await sb.auth.updateUser({ password });
      await sb.auth.signOut();
      return u.error ? { error: friendly(u.error) } : { ok: true };
    },
    async updateProfile(patch) {
      const me = S.me; if (!me) return null;
      try {
        const upd = {};
        if (patch.name !== undefined) upd.display_name = patch.name;
        if (patch.bio !== undefined) upd.bio = patch.bio;
        if (patch.avatar) {
          const blob = patch.avatar.startsWith("data:") ? dataUrlToBlob(patch.avatar) : null;
          if (blob) { checkFile(blob, ["image/jpeg", "image/png", "image/webp"], 2 * 1048576); upd.avatar_url = await upload("avatars", blob, extOf(blob.type)); }
        }
        const { error } = await sb.from("profiles").update(upd).eq("id", me.uuid);
        if (error) throw error;
        await loadProfiles(); S.me = S.users.get(me.username); return S.me;
      } catch (e) { toastErr(friendly(e)); return S.me; }
    },

    /* ---- content ---- */
    recipes() { return S.items.filter((i) => i.type === "recipe"); },
    reels() { return S.items.filter((i) => i.type === "reel"); },
    videos() { return S.items.filter((i) => i.type === "video"); },
    item(k) { return S.itemMap.get(k) || null; },
    isOwn(item) { return !!(S.me && item && item.source === "community" && item.author === S.me.username); },
    async create(type, data) {
      if (!S.me) return { error: "Log in to post." };
      try {
        let cover = data.ph || "";
        if (cover.startsWith("data:")) { const b = dataUrlToBlob(cover); checkFile(b, ["image/jpeg", "image/png", "image/webp"], MAX_IMAGE); cover = await upload("post-media", b, extOf(b.type)); }
        let media = null;
        if (data._videoFile) { checkFile(data._videoFile, ["video/mp4", "video/webm"], MAX_VIDEO); media = await upload("post-media", data._videoFile, extOf(data._videoFile.type)); }
        const recipeLinks = type === "reel" && data.recipe ? [data.recipe] : [];
        const payload = { kind: type, title: data.title, caption: type === "reel" ? data.cap : data.desc, cover_ref: cover, media_url: media,
          duration_s: data.dur || null, description: data.desc, difficulty: data.diff, prep: data.prep, cook: data.cook, servings: data.serves,
          tips: data.tips || [], ingredients: data.ing || [], steps: data.steps || [], categories: data.cats || [], tags: (data.tags || []).map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30)),
          linked_recipes: recipeLinks, links: type === "video" ? (data.links || []) : [] };
        const { data: slug, error } = await sb.rpc("create_post", { p: payload });
        if (error) throw error;
        const { data: row, error: e2 } = await sb.from("posts").select(POST_SELECT).eq("slug", slug).single();
        if (e2) throw e2;
        const item = mapPost(row, new Map(S.items.map((i) => [i._pid, i.id])));
        putItem(item); refreshStatsSoon();
        return { item, persisted: true };
      } catch (e) { return { error: friendly(e) }; }
    },
    async remove(k) {
      const it = this.item(k); if (!it || !this.isOwn(it)) return false;
      const { error } = await sb.from("posts").delete().eq("id", it._pid);
      if (error) { toastErr(friendly(error)); return false; }
      S.items = S.items.filter((i) => i !== it); S.itemMap.delete(k); refreshStatsSoon(); return true;
    },

    /* ---- counts + my state (server counters are the truth; we adjust optimistically) ---- */
    counts(it) { return { likes: it.likes, dislikes: it.dislikes, comments: it.comments, saves: it.saves, shares: it.shares, views: it.views }; },
    my(k) { return S.me ? { reaction: S.my.react.get(k) || 0, saved: S.my.saves.has(k) } : { reaction: 0, saved: false }; },
    react(k, value) {
      const it = this.item(k); if (!S.me || !it) return null;
      const prev = S.my.react.get(k) || 0, next = prev === value ? 0 : value;
      const adj = (v, d) => { if (v === 1) it.likes = Math.max(0, it.likes + d); if (v === -1) it.dislikes = Math.max(0, it.dislikes + d); };
      adj(prev, -1); adj(next, +1); if (next) S.my.react.set(k, next); else S.my.react.delete(k);
      const q = next === 0 ? sb.from("post_reactions").delete().eq("post_id", it._pid).eq("profile_id", S.me.uuid)
        : sb.from("post_reactions").upsert({ post_id: it._pid, profile_id: S.me.uuid, value: next }, { onConflict: "profile_id,post_id" });
      bg(q, () => { adj(next, -1); adj(prev, +1); if (prev) S.my.react.set(k, prev); else S.my.react.delete(k); }, "react");
      return next;
    },
    toggleSave(k) {
      const it = this.item(k); if (!S.me || !it) return null;
      const on = !S.my.saves.has(k);
      if (on) { S.my.saves.add(k); it.saves++; } else { S.my.saves.delete(k); it.saves = Math.max(0, it.saves - 1); }
      const q = on ? sb.from("saved_content").insert({ post_id: it._pid, profile_id: S.me.uuid }) : sb.from("saved_content").delete().eq("post_id", it._pid).eq("profile_id", S.me.uuid);
      bg(q, () => { if (on) { S.my.saves.delete(k); it.saves--; } else { S.my.saves.add(k); it.saves++; } }, "save");
      return on;
    },
    saved() { return S.me ? [...S.my.saves].map((k) => S.itemMap.get(k)).filter(Boolean) : []; },
    isFollowing(u) { return !!(S.me && S.my.follows.has(u)); },
    toggleFollow(u) {
      const target = S.users.get(u); if (!S.me || !target || S.me.username === u) return null;
      const on = !S.my.follows.has(u), d = on ? 1 : -1;
      const apply = (n) => { target.followers = Math.max(0, target.followers + n); S.me.following = Math.max(0, S.me.following + n); };
      if (on) S.my.follows.add(u); else S.my.follows.delete(u); apply(d);
      const q = on ? sb.from("follows").insert({ follower_id: S.me.uuid, followee_id: target.uuid }) : sb.from("follows").delete().eq("follower_id", S.me.uuid).eq("followee_id", target.uuid);
      bg(q, () => { if (on) S.my.follows.delete(u); else S.my.follows.add(u); apply(-d); }, "follow");
      return on;
    },
    view(k) {                                               // guests are not counted (no way to de-duplicate them safely)
      const it = this.item(k); if (!S.me || !it || S.viewed.has(k)) return false;
      S.viewed.add(k);
      sb.from("post_views").upsert({ post_id: it._pid, profile_id: S.me.uuid }, { onConflict: "profile_id,post_id", ignoreDuplicates: true }).then(() => {}, () => {});
      it.views++; return true;
    },
    share(k) {
      const it = this.item(k); if (!S.me || !it || S.shared.has(k)) return false;
      S.shared.add(k);
      sb.from("shares").upsert({ post_id: it._pid, profile_id: S.me.uuid }, { onConflict: "profile_id,post_id", ignoreDuplicates: true }).then(() => {}, () => {});
      it.shares++; return true;
    },

    async reportRecipe(k, reason, details) {
      const it = this.item(k); if (!S.me) return { error: "Log in to report a problem." }; if (!it) return { error: "Recipe not found." };
      const { error } = await sb.from("reports").insert({ reporter_id: S.me.uuid, target_type: "post", target_id: it._pid, reason, details: String(details || "").slice(0, 1000) || null });
      if (error) return { error: error.code === "23505" ? "You have already reported this recipe." : friendly(error) };
      return { ok: true, message: "Thanks! Your report was sent to our moderators." };
    },

    /* ---- comments (fetched lazily, then announced with the sc:comments event) ---- */
    comments(k) {
      const c = S.comments.get(k) || { list: [], loading: false, loaded: false };
      S.comments.set(k, c);
      if (!c.loaded && !c.loading) {
        const it = this.item(k); if (!it) return [];
        c.loading = true;
        sb.from("comments").select("id,body,created_at,author:profiles!comments_author_id_fkey(username)").eq("post_id", it._pid)
          .eq("status", "published").order("created_at", { ascending: false }).limit(100)
          .then(({ data }) => { c.list = (data || []).map((r) => ({ id: r.id, user: r.author.username, text: r.body, ts: Date.parse(r.created_at) })); c.loaded = true; c.loading = false; emit("sc:comments", { key: k }); },
                () => { c.loading = false; });
      }
      return c.list;
    },
    async addComment(k, text) {
      const it = this.item(k); text = String(text || "").trim().slice(0, 500);
      if (!S.me || !it || !text) return null;
      const { data, error } = await sb.from("comments").insert({ post_id: it._pid, author_id: S.me.uuid, body: text }).select("id,body,created_at").single();
      if (error) { toastErr(friendly(error)); return null; }
      const c = S.comments.get(k) || { list: [], loading: false, loaded: true }; S.comments.set(k, c);
      const row = { id: data.id, user: S.me.username, text: data.body, ts: Date.parse(data.created_at) };
      c.list = [row, ...c.list]; it.comments++; refreshStatsSoon();
      return row;
    },

    /* ---- users: stats + rankings (points are server-calculated) ---- */
    stats(username) {
      const u = this.user(username); if (!u) return null;
      return { followers: u.followers, following: u.following, points: u.points,
        posts: S.items.filter((i) => i.author === username).length };
    },
    creators() { return this.users().map((u) => ({ u, s: this.stats(u.username) })).sort((a, b) => b.s.points - a.s.points).map((x) => x.u); },
    resetAll() { /* no-op: production data is never wiped from the browser */ },
  });
})();
