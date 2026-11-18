"use strict";
/* Real food places for the map: restaurants, fast food, cafes, bakeries, ice cream, food courts, markets, from OpenStreetMap
   (Overpass API). Loaded on demand for the part of the map the user is looking at, then kept in our own database, so the
   public Overpass server is asked at most once per 11 km square per month. Data licence: ODbL, shown as "© OpenStreetMap contributors". */
const { get, run, tx, now } = require("./db");

const CELL = 0.1, MAX_AGE = 30 * 86400000, RETRY = 10 * 60000;
const ENDPOINT = () => process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const failed = new Map(), inflight = new Map();
const ATTR = "© OpenStreetMap contributors (ODbL)";

function category(t) {
  const a = t.amenity, s = t.shop, cuisine = String(t.cuisine || "");
  if (a === "restaurant") return t["diet:vegan"] === "only" ? "vegan" : /seafood|fish/.test(cuisine) ? "seafood" : "restaurant";
  if (a === "fast_food") return "fast-food";
  if (a === "cafe") return "cafe";
  if (a === "ice_cream") return "ice-cream";
  if (a === "food_court") return "street-food";
  if (a === "marketplace") return "market";
  if (s === "bakery") return "bakery";
  if (s === "pastry" || s === "confectionery") return "dessert";
  return "other";
}
const clip = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

function rows(elements) {
  const out = [];
  for (const e of elements || []) {
    const t = e.tags || {}, lat = e.lat !== undefined ? e.lat : e.center && e.center.lat, lng = e.lon !== undefined ? e.lon : e.center && e.center.lon;
    const name = clip(t.name, 120); if (!name || !(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) continue;
    const site = clip(t.website || t["contact:website"], 300);
    const cc = clip(t["addr:country"], 2);
    out.push({ id: "osm-" + String(e.type || "n")[0] + e.id, name, cat: category(t), lat, lng,
      address: clip([t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "), 200), city: clip(t["addr:city"] || t["addr:town"] || t["addr:village"], 80),
      cc: cc && /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : null, phone: clip(t.phone || t["contact:phone"], 30), site: site && /^https?:\/\/[^\s]{3,}$/i.test(site) ? site : null });
  }
  return out;
}

function save(list, cells) {
  const t = now();
  tx(() => {
    for (const r of list) run("INSERT INTO food_places(id,name,category_id,lat,lng,address,city,country_code,phone,website,source,verification,attribution,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'osm','osm',?,'approved',?) " +
      "ON CONFLICT(id) DO UPDATE SET name=excluded.name, category_id=excluded.category_id, lat=excluded.lat, lng=excluded.lng, address=excluded.address, city=excluded.city, country_code=excluded.country_code, phone=excluded.phone, website=excluded.website WHERE food_places.source='osm'",
      r.id, r.name, r.cat, r.lat, r.lng, r.address, r.city, r.cc, r.phone, r.site, ATTR, t);
    for (const k of cells) run("INSERT INTO osm_cells(key,fetched_at,n) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET fetched_at=excluded.fetched_at, n=excluded.n", k, t, list.length);
  });
}

async function load(cells) {
  const keys = cells.map((c) => c.join(":")), s = Math.min(...cells.map((c) => c[0])) * CELL, n = (Math.max(...cells.map((c) => c[0])) + 1) * CELL, w = Math.min(...cells.map((c) => c[1])) * CELL, e = (Math.max(...cells.map((c) => c[1])) + 1) * CELL;
  const bb = [s, w, n, e].map((x) => x.toFixed(4)).join(",");
  const q = `[out:json][timeout:25];(nwr["amenity"~"^(restaurant|fast_food|cafe|food_court|ice_cream|marketplace)$"]["name"](${bb});nwr["shop"~"^(bakery|pastry|confectionery)$"]["name"](${bb}););out center tags;`;
  try {
    const r = await fetch(ENDPOINT(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "SimpleCook/1.0 (food map)" }, body: "data=" + encodeURIComponent(q), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error("overpass " + r.status);
    const j = await r.json(); save(rows(j.elements), keys);
  } catch (err) { console.error("[osm] could not load food places:", err.message); keys.forEach((k) => failed.set(k, Date.now())); }
}

/* make sure the squares covering this map view are loaded (only at city zoom: small views) */
async function ensure(west, south, east, north) {
  if (process.env.OSM_PLACES === "0" || ![west, south, east, north].every(Number.isFinite) || west > east) return;
  if (east - west > 0.6 || north - south > 0.5) return;
  const cells = [];
  for (let i = Math.floor(south / CELL); i <= Math.floor(north / CELL); i++) for (let j = Math.floor(west / CELL); j <= Math.floor(east / CELL); j++) cells.push([i, j]);
  if (cells.length > 40) return;
  const need = cells.filter((c) => { const k = c.join(":"), r = get("SELECT fetched_at FROM osm_cells WHERE key=?", k); if (r && Date.now() - Date.parse(r.fetched_at) < MAX_AGE) return false; const f = failed.get(k); return !(f && Date.now() - f < RETRY); });
  if (!need.length) return;
  const id = need.map((c) => c.join(":")).join(",");
  if (!inflight.has(id)) inflight.set(id, load(need).finally(() => inflight.delete(id)));
  return inflight.get(id);
}
module.exports = { ensure, rows, category };
