"use strict";
/* SQLite storage (node:sqlite, built into Node 22: no npm packages, nothing to compile).
   DATA_DIR must point at a persistent disk (a Railway Volume) or data is lost on every deploy. */
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");

const PERSISTENT = !!(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH);   // Railway sets the second one when a Volume is attached
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "..", "data-store");
if (process.env.NODE_ENV === "production" && !PERSISTENT) console.warn("[simple-cook] WARNING: no Volume attached. Accounts, messages and uploads will be LOST on every redeploy. See docs/RAILWAY.md step 4.");
fs.mkdirSync(path.join(DATA_DIR, "media"), { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "simplecook.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, bio TEXT DEFAULT '', avatar TEXT, hue INTEGER DEFAULT 0, salt TEXT NOT NULL, pass TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resets(email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, tries INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS posts(key TEXT PRIMARY KEY, type TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reactions(user_id TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(user_id,key));
CREATE TABLE IF NOT EXISTS saves(user_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(user_id,key));
CREATE TABLE IF NOT EXISTS shares(user_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(user_id,key));
CREATE TABLE IF NOT EXISTS views(user_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(user_id,key));
CREATE TABLE IF NOT EXISTS follows(follower_id TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY(follower_id,target_id));
CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, key TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS comments_key ON comments(key);
CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL, UNIQUE(reporter_id,target_type,target_id));

CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, is_group INTEGER NOT NULL DEFAULT 0, title TEXT, created_by TEXT, direct_key TEXT UNIQUE, created_at TEXT NOT NULL, last_message_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_members(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, profile_id TEXT NOT NULL, role TEXT DEFAULT 'member', last_read_at TEXT, PRIMARY KEY(conversation_id,profile_id));
CREATE INDEX IF NOT EXISTS cm_profile ON conversation_members(profile_id);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sender_id TEXT NOT NULL, body TEXT, kind TEXT NOT NULL DEFAULT 'text', reply_to_id TEXT, shared_post_id TEXT, created_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX IF NOT EXISTS msg_conv ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS message_attachments(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, kind TEXT NOT NULL, storage_path TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER, duration_s REAL);
CREATE TABLE IF NOT EXISTS message_reactions(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, profile_id TEXT NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY(message_id,profile_id,emoji));
CREATE TABLE IF NOT EXISTS blocks(blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at TEXT, PRIMARY KEY(blocker_id,blocked_id));
CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, type TEXT NOT NULL, ref TEXT, read_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS notif_rcpt ON notifications(recipient_id, read_at);
CREATE TABLE IF NOT EXISTS stories(id TEXT PRIMARY KEY, author_id TEXT NOT NULL, media_path TEXT NOT NULL, media_kind TEXT NOT NULL, caption TEXT, visibility TEXT NOT NULL DEFAULT 'public', created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS story_views(story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE, viewer_id TEXT NOT NULL, PRIMARY KEY(story_id,viewer_id));
CREATE TABLE IF NOT EXISTS story_reactions(story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE, profile_id TEXT NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY(story_id,profile_id));

CREATE TABLE IF NOT EXISTS food_places(id TEXT PRIMARY KEY, name TEXT NOT NULL, category_id TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, address TEXT, city TEXT, country_code TEXT, phone TEXT, website TEXT, price_level INTEGER, opening_hours TEXT, timezone TEXT, source TEXT NOT NULL DEFAULT 'user', verification TEXT NOT NULL DEFAULT 'community', attribution TEXT, status TEXT NOT NULL DEFAULT 'approved', submitted_by TEXT, rating_avg REAL DEFAULT 0, rating_count INTEGER DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS fp_geo ON food_places(lat,lng);
CREATE TABLE IF NOT EXISTS food_place_reviews(id TEXT PRIMARY KEY, place_id TEXT NOT NULL REFERENCES food_places(id) ON DELETE CASCADE, author_id TEXT NOT NULL, rating INTEGER NOT NULL, body TEXT, created_at TEXT NOT NULL, UNIQUE(place_id,author_id));
CREATE TABLE IF NOT EXISTS food_review_votes(review_id TEXT NOT NULL REFERENCES food_place_reviews(id) ON DELETE CASCADE, profile_id TEXT NOT NULL, PRIMARY KEY(review_id,profile_id));
CREATE TABLE IF NOT EXISTS saved_places(place_id TEXT NOT NULL REFERENCES food_places(id) ON DELETE CASCADE, profile_id TEXT NOT NULL, PRIMARY KEY(place_id,profile_id));
CREATE TABLE IF NOT EXISTS osm_cells(key TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS scan_quota(user_id TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,day));
`);

const cache = new Map();
const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
const clean = (a) => a.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
const all = (sql, ...p) => stmt(sql).all(...clean(p));
const get = (sql, ...p) => stmt(sql).get(...clean(p));
const run = (sql, ...p) => stmt(sql).run(...clean(p));
const tx = (fn) => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch (x) { /* ignore */ } throw e; } };
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

module.exports = { db, all, get, run, tx, uid, now, DATA_DIR, PERSISTENT };
