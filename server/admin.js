#!/usr/bin/env node
"use strict";
/* Moderation from the command line. Usage (on Railway: open the service > "Shell"/"railway ssh", then run):
     node server/admin.js stats
     node server/admin.js reports
     node server/admin.js places [pending]        node server/admin.js approve-place <id>     node server/admin.js delete-place <id>
     node server/admin.js delete-post <key>       node server/admin.js delete-user <username> */
const fs = require("node:fs");
const { all, get, run, tx, DATA_DIR } = require("./db");
const [cmd, arg] = process.argv.slice(2);
const out = (rows) => console.log(rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") : "(none)");
const C = {
  stats: () => out([{ users: get("SELECT COUNT(*) n FROM users").n, posts: get("SELECT COUNT(*) n FROM posts").n, messages: get("SELECT COUNT(*) n FROM messages").n, places: get("SELECT COUNT(*) n FROM food_places").n, reports: get("SELECT COUNT(*) n FROM reports").n, data: DATA_DIR }]),
  reports: () => out(all("SELECT r.created_at, r.target_type, r.target_id, r.reason, r.details, u.username reporter FROM reports r LEFT JOIN users u ON u.id=r.reporter_id ORDER BY r.created_at DESC LIMIT 100")),
  places: () => out(all("SELECT id,name,city,status,source,created_at FROM food_places " + (arg === "pending" ? "WHERE status='pending' " : "") + "ORDER BY created_at DESC LIMIT 100")),
  "approve-place": () => console.log(run("UPDATE food_places SET status='approved' WHERE id=?", arg).changes + " place(s) approved"),
  "delete-place": () => console.log(run("DELETE FROM food_places WHERE id=?", arg).changes + " place(s) deleted"),
  "delete-post": () => { const n = run("DELETE FROM posts WHERE key=?", arg).changes; ["reactions", "saves", "shares", "views", "comments"].forEach((t) => run("DELETE FROM " + t + " WHERE key=?", arg)); console.log(n + " post(s) deleted"); },
  "delete-user": () => {
    const u = get("SELECT id FROM users WHERE username=?", String(arg || "").toLowerCase()); if (!u) return console.log("no such user");
    tx(() => { [["reactions", "user_id"], ["saves", "user_id"], ["shares", "user_id"], ["views", "user_id"], ["comments", "user_id"], ["follows", "follower_id"], ["follows", "target_id"], ["message_reactions", "profile_id"], ["messages", "sender_id"], ["conversation_members", "profile_id"], ["blocks", "blocker_id"], ["blocks", "blocked_id"], ["notifications", "recipient_id"], ["stories", "author_id"], ["story_views", "viewer_id"], ["saved_places", "profile_id"], ["food_place_reviews", "author_id"], ["scan_quota", "user_id"]].forEach(([t, c]) => run("DELETE FROM " + t + " WHERE " + c + "=?", u.id)); run("DELETE FROM users WHERE id=?", u.id); });
    try { fs.rmSync(DATA_DIR + "/media/chat-media/" + u.id, { recursive: true, force: true }); fs.rmSync(DATA_DIR + "/media/post-media/" + u.id, { recursive: true, force: true }); fs.rmSync(DATA_DIR + "/media/avatars/" + u.id, { recursive: true, force: true }); } catch (e) { /* none */ }
    console.log("user and their data deleted");
  },
};
if (!C[cmd]) { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace("#!/usr/bin/env node\n\"use strict\";\n/*", "").trim()); process.exit(cmd ? 1 : 0); }
C[cmd]();
