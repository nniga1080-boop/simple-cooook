"use strict";
/* Camera features: ingredient scanner + meal recognition (Anthropic vision, key stays on the server) and USDA nutrition lookup.
   Photos are processed in memory only: never written to disk or logged. */
const { get, run } = require("./db");
const { HttpError } = require("./core");
const MODEL = () => process.env.SCAN_MODEL || "claude-haiku-5-5";
const API = () => (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const FDC = () => (process.env.FDC_BASE_URL || "https://api.nal.usda.gov").replace(/\/$/, "");
const DAILY = 20;

const SYS_SCAN = `You identify food ingredients visible in kitchen photos. Rules: list only distinct ingredients you can actually see; never guess the contents of closed or opaque containers; use common English ingredient names (singular); do not infer quantity by weight; "count" is the number of visible discrete items or null; "confidence" is high, medium or low based only on visual evidence; give up to 2 "alternatives" when similar-looking ingredients are possible (e.g. parsley/coriander, lemon/lime). Reply with JSON only: {"ingredients":[{"name":"","category":"vegetable|fruit|meat|seafood|dairy|grain|legume|herb|spice|pantry|other","confidence":"","count":null,"alternatives":[],"image":0}]} where "image" is the 0-based index of the photo. If nothing edible is visible return {"ingredients":[]}.`;
const SYS_MEAL = `You identify a prepared meal in photos for a nutrition tool. Rules: name the dish and list its visible components separately (e.g. grilled chicken, cooked rice, salad, sauce). Use the dish's common name; keep a traditional name if you know it. NEVER give calories, nutrients, grams or portion weights. Say prep method only if visible (grilled, fried, boiled, baked, raw...) else null. Mark hidden=true for anything whose recipe, oil, sugar or sauce content a photo cannot reveal. "confidence" is high, medium or low from visual evidence only. Give up to 3 alternative dish names when the dish is ambiguous. "questions" are at most 3 short questions whose answers would materially change the nutrition (e.g. dressing used? deep-fried or oven-baked?). Reply with JSON only: {"meal":{"name":"","cuisine":null,"confidence":"","alternatives":[]},"components":[{"name":"","category":"","prep":null,"confidence":"","hidden":false,"image":0}],"questions":[]}. If no food is visible return {"meal":null,"components":[],"questions":[]}.`;

const MAGIC = { "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47], "image/webp": [0x52, 0x49, 0x46, 0x46] };
const s60 = (x) => (typeof x === "string" ? x.slice(0, 60) : null);
const OK = ["high", "medium", "low"];

function checkImages(b, max) {
  const imgs = Array.isArray(b.images) ? b.images : [];
  if (imgs.length < 1 || imgs.length > max) throw new HttpError(400, "invalid_image");
  for (const i of imgs) {
    const m = i && MAGIC[i.mime];
    if (!m || typeof i.data !== "string" || i.data.length > 2000000 || !/^[A-Za-z0-9+/=]+$/.test(i.data)) throw new HttpError(400, "invalid_image");
    const head = Buffer.from(i.data.slice(0, 16), "base64"); if (!m.every((v, k) => head[k] === v)) throw new HttpError(400, "invalid_image");
  }
  return imgs;
}
function quota(userId, n) {
  const day = new Date().toISOString().slice(0, 10), row = get("SELECT n FROM scan_quota WHERE user_id=? AND day=?", userId, day);
  if ((row ? row.n : 0) + n > DAILY) throw new HttpError(429, "quota_exceeded");
  run("INSERT INTO scan_quota(user_id,day,n) VALUES(?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET n=n+?", userId, day, n, n);
}
async function vision(system, imgs, prompt) {
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "not_configured");
  const r = await fetch(API() + "/v1/messages", { method: "POST", signal: AbortSignal.timeout(45000), headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL(), max_tokens: 1500, system, messages: [{ role: "user", content: [...imgs.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })), { type: "text", text: prompt }] }] }) });
  if (!r.ok) throw new HttpError(502, "provider_error");
  const txt = ((await r.json()).content || []).map((c) => c.text || "").join("");
  return JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
}
const guard = async (fn) => { try { return await fn(); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(502, "analysis_failed"); } };

const A = {};
A["scan-ingredients"] = (u, b) => { const imgs = checkImages(b, 5); if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "not_configured"); quota(u.id, imgs.length);
  return guard(async () => { const j = await vision(SYS_SCAN, imgs, "Identify the ingredients in these photos.");
    const list = (Array.isArray(j.ingredients) ? j.ingredients : []).slice(0, 40).filter((x) => x && typeof x.name === "string").map((x) => ({ name: x.name.slice(0, 60), category: String(x.category || "other").slice(0, 20), confidence: OK.includes(x.confidence) ? x.confidence : "low",
      count: Number.isInteger(x.count) && x.count > 0 && x.count < 100 ? x.count : null, alternatives: (Array.isArray(x.alternatives) ? x.alternatives : []).filter((a) => typeof a === "string").slice(0, 2).map((a) => a.slice(0, 60)), image: Number.isInteger(x.image) ? x.image : 0 }));
    return { ingredients: list, model: MODEL() }; }); };
A["analyze-meal"] = (u, b) => { const imgs = checkImages(b, 3); if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "not_configured"); quota(u.id, imgs.length);
  return guard(async () => { const j = await vision(SYS_MEAL, imgs, "Identify this meal and its components.");
    const comps = (Array.isArray(j.components) ? j.components : []).slice(0, 12).filter((c) => c && typeof c.name === "string").map((c) => ({ name: c.name.slice(0, 60), category: s60(c.category), prep: s60(c.prep), confidence: OK.includes(c.confidence) ? c.confidence : "low", hidden: c.hidden === true, image: Number.isInteger(c.image) ? c.image : 0 }));
    const m = j.meal && typeof j.meal.name === "string" ? { name: j.meal.name.slice(0, 80), cuisine: s60(j.meal.cuisine), confidence: OK.includes(j.meal.confidence) ? j.meal.confidence : "low", alternatives: (Array.isArray(j.meal.alternatives) ? j.meal.alternatives : []).filter((a) => typeof a === "string").slice(0, 3).map((a) => a.slice(0, 80)) } : null;
    return { meal: m, components: comps, questions: (Array.isArray(j.questions) ? j.questions : []).filter((x) => typeof x === "string").slice(0, 3).map((x) => x.slice(0, 140)), model: MODEL() }; }); };
const NUM = { 208: "kcal", 203: "protein", 205: "carbs", 204: "fat", 606: "satfat", 291: "fiber", 269: "sugar", 307: "sodium" };
A["nutrition-lookup"] = async (u, b) => {
  const query = typeof b.query === "string" ? b.query.trim().slice(0, 80) : ""; if (query.length < 2) throw new HttpError(400, "bad_query");
  if (!process.env.FDC_API_KEY) throw new HttpError(503, "not_configured");
  return guard(async () => {
    const url = new URL(FDC() + "/fdc/v1/foods/search"); url.searchParams.set("query", query); url.searchParams.set("pageSize", "5"); url.searchParams.set("dataType", "Foundation,SR Legacy,Survey (FNDDS)");
    const r = await fetch(url, { headers: { "X-Api-Key": process.env.FDC_API_KEY }, signal: AbortSignal.timeout(15000) }); if (r.status === 429) throw new HttpError(429, "provider_rate_limit"); if (!r.ok) throw new HttpError(502, "provider_error");
    const j = await r.json();
    const candidates = (j.foods || []).map((f) => { const per100 = { kcal: null, protein: null, carbs: null, fat: null, satfat: null, fiber: null, sugar: null, sodium: null };
      for (const n of f.foodNutrients || []) { const k = NUM[String(n.nutrientNumber)]; if (k && typeof n.value === "number" && (k !== "kcal" || n.unitName === "KCAL")) per100[k] = n.value; }
      return { source: "USDA FoodData Central", fdcId: f.fdcId, description: String(f.description || "").slice(0, 120), dataType: f.dataType, per100 }; });
    return { candidates, retrieved: new Date().toISOString().slice(0, 10) };
  });
};
module.exports = { A };
