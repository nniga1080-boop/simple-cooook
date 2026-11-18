# Put Simple Cook online with Railway

This project is now **one server** that does everything: it serves the website AND runs the real accounts, real-time messages, stories, food map and camera scanner. It needs **no npm packages** (so the build cannot fail on installs) and **no Supabase** (the old Supabase files are still there if you ever want them).

```
browser  <──https──>  Railway  ─  server/index.js  ─┬─ the website (index.html, *.js, style.css)
                                                    ├─ /api/...   accounts, posts, likes, comments, messages, map
                                                    ├─ /api/events   live messages (Server-Sent Events)
                                                    ├─ /api/ai/...   camera scanner (your AI key stays on the server)
                                                    └─ DATA_DIR (a Volume): simplecook.db + uploaded photos/voice/video
```

## Before you start (2 minutes)

1. A free **GitHub** account and a **Railway** account (sign in to Railway with GitHub; no credit card is needed for Railway's free trial).
2. Unzip this project on your computer.

## Step 1: put the project on GitHub

1. github.com → **New repository** → name it `simple-cook` → **Create**.
2. On the new repo page click **uploading an existing file**, drag **all the files and folders from inside the unzipped folder** (not the folder itself), then **Commit changes**.
   - `index.html` and `package.json` must be at the top level of the repo, not inside another folder.

## Step 2: create the Railway service

1. railway.com → **New Project** → **Deploy from GitHub repo** → pick `simple-cook`.
2. Wait for the build (about 1 minute). It runs `npm start` by itself (`railway.json` already says so).

## Step 3: give it a public address

1. Click the service → **Settings** → **Networking** → **Generate Domain**.
2. Open the address. You should see Simple Cook. Add `/health` to the address: you must see `{"ok":true}`.

## Step 4: attach a Volume (IMPORTANT: this is where accounts and messages are stored)

Without a Volume, every redeploy **erases all accounts, messages and uploads**.

1. In your project, press **Ctrl+K** (or right-click the canvas) → **Volume** → attach it to the service.
2. Set the mount path to `/data`.
3. Railway then sets `RAILWAY_VOLUME_MOUNT_PATH` and the server uses it automatically. The server logs a warning if it runs in production without one.

> Railway's docs say that volumes of **trial** accounts are deleted 30 days after the trial credit ends, unless you upgrade to a paid plan. If the site becomes real, upgrade (Hobby is about $5/month) so your members' data is kept.

## Step 5: variables (Service → **Variables**)

| Variable | Needed? | What it does |
|---|---|---|
| `NODE_ENV` = `production` | yes | production mode |
| `ANTHROPIC_API_KEY` | for the camera AI | without it the camera still opens, but analysing says "not switched on for this site yet" |
| `FDC_API_KEY` | for nutrition numbers | free key from api.data.gov |
| `RESEND_API_KEY` (+ `MAIL_FROM`) | for "Forgot password" | without it, the page honestly says reset is not set up |
| `MAP_STYLE_URL` | recommended before a big launch | e.g. a MapTiler style URL. The default OpenStreetMap tiles are only for light use |
| `PLACES_AUTO_APPROVE` = `0` | optional | new food places added by members wait for you instead of appearing immediately |
| `OSM_PLACES` = `0` | optional | switch off the automatic restaurants from OpenStreetMap (see below) |

Change a variable → Railway redeploys automatically.

## Step 6: test it with TWO browsers (this is the proof it is real)

1. Browser 1: create the account `alice`. Browser 2 (or a private window): create `bob`.
2. As alice: open `#/profile/bob` → **Messages** → send "hello". Bob's browser shows it **instantly** and the Messages badge lights up.
3. Open **Food map**, add a place: the other browser sees it after opening the map.
4. Open **Scan** on your phone (the site is https, so the camera is allowed).

## Restaurants on the map (automatic)

When someone zooms the map into a city (zoom 12 or closer), the server asks OpenStreetMap for every restaurant, fast-food place, café, bakery, ice-cream shop, food court and market in that area, saves them in your database, and shows them with "© OpenStreetMap contributors". The first visit to a new city takes a few seconds; after that it is instant and OpenStreetMap is not asked again for 30 days. Members can still add, review and save places. Places with no name in OpenStreetMap are skipped, and opening hours are not imported.

## Moderation

Reports from users are saved in the database. From the Railway service open the **Shell**, then:

```
node server/admin.js reports
node server/admin.js places pending
node server/admin.js delete-post recipe:p123abc
node server/admin.js delete-user someusername
```

## Updating the site

Change files on GitHub → Railway redeploys. The Volume keeps all data.

## What is real and what is not (honest list)

- Real: accounts (passwords hashed with scrypt, HttpOnly cookie), likes/saves/follows/comments/points shared by everyone, uploads, private chat media (only members can open it), live messages/typing/read receipts, stories (24 h), food places and reviews, camera upload to the AI.
- The 37 + 71 recipes, reels and videos that ship with the site are built-in content. Their starting like numbers are the demo numbers from `data.js`; real activity is added on top.
- Not built: email verification at signup, account deletion button (use `delete-user` above), web admin page, push notifications when the site is closed, a database other than SQLite (one server instance only; fine for thousands of members, not for millions).
- Follower-only stories hide the story from the app, but the photo URL itself is public (like any public file link).

## Running it on your own computer

```
node server/index.js          # then open http://localhost:3000
node tests/server-test.js     # 179 server checks
python3 tests/e2e-railway.py  # 59 browser checks with two users (needs Playwright)
```
Needs Node 22.13 or newer.
