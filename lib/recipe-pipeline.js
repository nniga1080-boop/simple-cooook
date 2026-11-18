/* Node-only pipeline: load compact recipe files -> compile to structured records -> validate -> detect duplicates.
   Used by scripts/*.js and tests. See docs/RECIPE_DATA_FORMAT.md for the authoring syntax. */
"use strict";
const fs = require("fs"), path = require("path");
const core = require("./recipe-core.js");
const ROOT = path.join(__dirname, "..");
const ALLERGENS = ["gluten", "crustaceans", "eggs", "fish", "peanuts", "soybeans", "milk", "nuts", "celery", "mustard", "sesame", "sulphites", "lupin", "molluscs"];
const FLAGS = ["pork", "alcohol"];
const NON_VEG = ["meat", "poultry", "fish", "seafood"];
const MEALS = ["breakfast", "lunch", "dinner", "snack", "starter", "main", "side", "soup", "salad", "dessert", "drink", "street-food", "baking"];
const DIFFS = ["Easy", "Medium", "Hard"];
const CONF = ["high", "medium", "disputed", "low"];
const TRAD = ["traditional", "modern", "regional-variant"];
const SAFE_RE = /cooked through|75 ?°C|no pink|juices run clear|until the (?:prawns|pork|chicken) /i;
const NEEDS_SAFETY = (cat, id) => cat === "poultry" || /-mince$/.test(id) || id === "pork-shoulder" || id === "rabbit";

const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
function loadReference() {
  return { regions: readJSON(path.join(ROOT, "data/reference/regions.json")), countries: readJSON(path.join(ROOT, "data/reference/countries.json")), ingredients: readJSON(path.join(ROOT, "data/reference/ingredients.json")), images: readJSON(path.join(ROOT, "data/reference/images.json")) };
}
function loadRaw() {
  const dir = path.join(ROOT, "data/recipes");
  return fs.readdirSync(dir).filter((f) => /^batch-.*\.json$/.test(f)).sort().flatMap((f) => readJSON(path.join(dir, f)).map((r) => Object.assign({ _file: f }, r)));
}
const flagEmoji = (cc) => String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0)));
const slugify = (s) => core.norm(s).replace(/\s+/g, "-");

/* ---- compile one compact record -> structured record. Errors are collected, never thrown. ---- */
function compile(raw, ref, errs) {
  const E = (m) => errs.push(`${raw.id || "?"}: ${m}`);
  const ings = (raw.ing || []).map((line, idx) => {
    const p = String(line).split("|").map((x) => x.trim());
    if (p.length < 2) { E(`ingredient #${idx + 1} needs 'qty unit | id | prep': "${line}"`); return null; }
    let q = p[0], optional = false;
    if (q.startsWith("?")) { optional = true; q = q.slice(1).trim(); }
    let unit = "", qtyStr = q;
    const m = /^(.*?)\s*([a-z]+)$/.exec(q);
    if (m && core.UNITS.includes(m[2])) { unit = m[2]; qtyStr = m[1]; }
    const qty = core.parseQuantity(qtyStr);
    if (qty === undefined) E(`ingredient #${idx + 1} has an invalid quantity "${q}"`);
    const cat = ref.ingredients[p[1]];
    if (!cat) E(`ingredient #${idx + 1} unknown ingredient id "${p[1]}"`);
    if (qty && !unit && /^(g|kg|ml|l|tsp|tbsp)$/.test(unit)) E(`ingredient #${idx + 1} missing unit`);
    return { position: idx, ingredient_id: p[1], qty_min: qty ? qty.min : null, qty_max: qty ? qty.max : null, unit, optional, prep: p[2] || "", pantry: !!(cat && cat.pantry) };
  }).filter(Boolean);
  const steps = (raw.steps || []).map((s, i) => {
    const p = String(s).split("|"); if (p.length < 3) { E(`step #${i + 1} needs 'Title|minutes|text'`); return null; }
    const text = p.slice(2).join("|").trim(), mins = p[1].trim() === "" ? null : parseInt(p[1], 10);
    if (mins !== null && (isNaN(mins) || mins < 0)) E(`step #${i + 1} invalid minutes`);
    const t = /(\d{2,3})\s?°C/.exec(text);
    return { n: i + 1, title: p[0].trim(), minutes: mins, text, temp_c: t ? +t[1] : null };
  }).filter(Boolean);
  const allergens = new Set(), flags = new Set(); let nonVeg = false, animalDairyEgg = false;
  ings.forEach((i) => { const c = ref.ingredients[i.ingredient_id]; if (!c) return;
    c.allergens.forEach((a) => (FLAGS.includes(a) ? flags : allergens).add(a));
    if (NON_VEG.includes(c.category) || ["fish", "crustaceans", "molluscs"].some((a) => c.allergens.includes(a))) nonVeg = true;
    if (c.category === "dairy" || c.category === "egg" || c.category === "honey") animalDairyEgg = true; });
  const subs = (raw.subs || []).map((s) => { const [pair, note] = s.split("|"); const [from, to] = pair.split(">").map((x) => x.trim()); return { from, to, note: (note || "").trim() }; });
  const countries = raw.countries || [], primary = raw.primary;
  const pc = ref.countries[primary];
  return {
    id: raw.id, slug: raw.id, name: raw.name, local_name: raw.local || null, alt_names: raw.alt || [], names: Object.assign({ en: raw.name }, raw.tr || {}),
    description: raw.desc, origin: { note: raw.origin_note, confidence: raw.confidence, tradition: raw.tradition, countries, primary, region: pc ? pc.region : null, cuisine: raw.cuisine, cuisine_id: slugify(raw.cuisine || "") },
    flags: countries.map((c) => ({ code: c, flag: /^[A-Z]{2}$/.test(c) ? flagEmoji(c) : "" })),
    meal: raw.meal || [], times: { prep: raw.prep, cook: raw.cook, rest: raw.rest || 0, active: (raw.prep || 0) + (raw.cook || 0), total: (raw.prep || 0) + (raw.cook || 0) + (raw.rest || 0) },
    servings: raw.serves, difficulty: raw.diff, ingredients: ings, steps, tips: raw.tips || [], mistakes: raw.mistakes || [], storage: raw.storage || "", reheat: raw.reheat || "",
    substitutions: subs, tags: raw.tags || [], occasions: raw.occasion || [], refs: raw.refs || [], related: raw.related || [], distinct_from: raw.distinct_from || [],
    allergens: [...allergens].sort(), contains: [...flags].sort(),
    diet: { vegetarian: !nonVeg, vegan: !nonVeg && !animalDairyEgg, gluten_free: !allergens.has("gluten"), dairy_free: !allergens.has("milk"), nut_free: !allergens.has("nuts") && !allergens.has("peanuts"), halal_friendly_no_pork_or_alcohol: !flags.has("pork") && !flags.has("alcohol") },
    nutrition: { status: "pending", note: "Not yet calculated. Planned: per-ingredient USDA FoodData Central values (CC0) scaled by quantity; will be labelled 'calculated'." },
    image: (ref.images[raw.id] && raw.id !== "_note") ? { status: ref.images[raw.id].status, file: ref.images[raw.id].file, alt: ref.images[raw.id].alt, match: ref.images[raw.id].match, license: null, source_url: null, creator: null }
      : { status: "pending", file: null, alt: `${raw.name}: photograph pending (licensed source not yet confirmed)`, license: null, source_url: null, creator: null },
    review: { status: "editorial_draft_unreviewed", note: "Written from general culinary knowledge; not yet kitchen-tested or reviewed by a native cook." },
    published_at: "2026-11-07",
  };
}

/* ---- validation ---- */
function validate(recipes, raws, ref) {
  const errors = [], warnings = [];
  const E = (id, m) => errors.push(`${id}: ${m}`), W = (id, m) => warnings.push(`${id}: ${m}`);
  const seen = new Set(); const ids = new Set(recipes.map((r) => r.id));
  Object.entries(ref.ingredients).forEach(([id, c]) => {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) errors.push(`ingredient ${id}: bad id`);
    if (!c.en || !c.fr || !c.ar) errors.push(`ingredient ${id}: missing en/fr/ar name`);
    c.allergens.forEach((a) => { if (![...ALLERGENS, ...FLAGS].includes(a)) errors.push(`ingredient ${id}: unknown allergen "${a}"`); });
    if (c.category === "dairy" && !c.allergens.includes("milk")) errors.push(`ingredient ${id}: dairy must list milk`);
    if (c.category === "egg" && !c.allergens.includes("eggs")) errors.push(`ingredient ${id}: egg must list eggs`);
  });
  Object.keys(ref.images).filter((k) => k !== "_note" && !recipes.some((r) => r.id === k)).forEach((k) => errors.push(`images.json: "${k}" does not match any recipe`));
  Object.entries(ref.countries).forEach(([cc, c]) => { if (!/^[A-Z]{2}$/.test(cc) || !ref.regions[c.region]) errors.push(`country ${cc}: bad code or region`); });
  recipes.forEach((r, k) => {
    const id = r.id, raw = raws[k];
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id || "")) E(id, "id must be lowercase-hyphen slug");
    if (seen.has(id)) E(id, "duplicate id"); seen.add(id);
    if (!r.name || r.name.length < 3) E(id, "name required");
    if (!r.description || r.description.length < 40 || r.description.length > 400) E(id, "description must be 40-400 chars");
    if (!r.origin.note || r.origin.note.length < 40) E(id, "origin_note required (>=40 chars)");
    if (!CONF.includes(r.origin.confidence)) E(id, "confidence must be one of " + CONF);
    if (!TRAD.includes(r.origin.tradition)) E(id, "tradition invalid");
    if (!r.origin.countries.length) E(id, "at least one country");
    r.origin.countries.forEach((c) => { if (!ref.countries[c]) E(id, `unknown country ${c}`); });
    if (!r.origin.countries.includes(r.origin.primary)) E(id, "primary must be one of countries");
    if (r.origin.confidence === "disputed" && r.origin.countries.length < 2) E(id, "disputed/shared origin should list every claimant country");
    if (!r.origin.cuisine) E(id, "cuisine required");
    if (!DIFFS.includes(r.difficulty)) E(id, "difficulty must be Easy|Medium|Hard");
    if (!Number.isInteger(r.servings) || r.servings < 1 || r.servings > 100) E(id, "servings 1-100");
    ["prep", "cook", "rest"].forEach((f) => { if (!Number.isInteger(r.times[f]) || r.times[f] < 0 || r.times[f] > 4320) E(id, `${f} minutes invalid`); });
    if (r.times.active <= 0) E(id, "prep+cook must be > 0");
    if (!r.meal.length || r.meal.some((m) => !MEALS.includes(m))) E(id, "meal types invalid: " + r.meal);
    if (r.ingredients.length < 3) E(id, "needs >= 3 ingredients");
    if (r.steps.length < 3) E(id, "needs >= 3 steps");
    r.steps.forEach((s) => { if (s.text.length < 40) E(id, `step ${s.n} too short to be useful`); if (/cook until ready/i.test(s.text)) E(id, `step ${s.n} vague`); });
    if (!r.tips.length) W(id, "no tips");
    if (r.image.file) { if (!fs.existsSync(path.join(ROOT, r.image.file))) E(id, "image file missing: " + r.image.file); if (!r.image.alt || r.image.alt.length < 15) E(id, "image needs meaningful alt text"); }
    if (!r.storage) E(id, "storage guidance required");
    if (r.tags.some((t) => !/^[a-z0-9-]{1,30}$/.test(t))) E(id, "tags must be lowercase-hyphen");
    const body = r.steps.map((s) => s.text).join(" ");
    if (/\b(oven|bake|roast)\b/i.test(body) && !/°C/.test(body)) E(id, "oven cooking needs a temperature in °C");
    if (/deep.?fry|fry in batches|oil to/i.test(body) && !/°C/.test(body) && r.ingredients.some((i) => /sunflower-oil/.test(i.ingredient_id) && i.qty_min >= 300)) W(id, "frying without oil temperature");
    r.ingredients.forEach((i) => {
      const c = ref.ingredients[i.ingredient_id]; if (!c) return;
      if (i.qty_min === null && !["salt", "black-pepper", "water"].includes(i.ingredient_id)) W(id, `${i.ingredient_id} has no quantity`);
      if (i.qty_min !== null && !i.unit && c.category === "spice" && !["star-anise","cinnamon-stick","clove","chili-guajillo","chili-ancho"].includes(i.ingredient_id)) W(id, `${i.ingredient_id}: spices should have a unit`);
      if (NEEDS_SAFETY(c.category, i.ingredient_id) && !SAFE_RE.test(body)) E(id, `${i.ingredient_id}: needs food-safety doneness guidance in the steps`);
    });
    const used = new Set(r.ingredients.map((i) => i.ingredient_id));
    r.substitutions.forEach((s) => { if (!ref.ingredients[s.from] || !ref.ingredients[s.to]) E(id, `substitution uses unknown ingredient ${s.from}>${s.to}`); else if (!used.has(s.from)) W(id, `substitution from ${s.from} which is not in the recipe`); });
    r.related.forEach((x) => { if (!ids.has(x)) E(id, `related recipe "${x}" does not exist`); if (x === id) E(id, "related to itself"); });
    r.refs.forEach((u) => { if (!/^https:\/\/[^\s]+$/.test(u)) E(id, `bad ref URL ${u}`); });
    if (!r.refs.length) W(id, "no source URL recorded (origin from general knowledge)");
    if (r.names.fr == null || r.names.ar == null) W(id, "missing fr/ar name");
  });
  return { errors, warnings };
}

/* ---- duplicates ---- */
function lev(a, b) { const m = a.length, n = b.length; if (!m) return n; if (!n) return m; let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[n]; }
function jaccard(a, b) { const A = new Set(a), B = new Set(b); let i = 0; A.forEach((x) => B.has(x) && i++); return i / (A.size + B.size - i || 1); }
function detectDuplicates(recipes) {
  const findings = [];
  const names = (r) => [r.name, r.local_name, ...r.alt_names, ...Object.values(r.names)].filter(Boolean).map(core.norm);
  for (let i = 0; i < recipes.length; i++) for (let j = i + 1; j < recipes.length; j++) {
    const a = recipes[i], b = recipes[j];
    if (a.distinct_from.includes(b.id) || b.distinct_from.includes(a.id)) continue;
    const na = names(a), nb = names(b);
    const exact = na.some((x) => nb.includes(x));
    let near = 0; na.forEach((x) => nb.forEach((y) => { if (x && y && x !== y) near = Math.max(near, 1 - lev(x, y) / Math.max(x.length, y.length)); }));
    const ij = jaccard(a.ingredients.map((x) => x.ingredient_id), b.ingredients.map((x) => x.ingredient_id));
    const sameCountry = a.origin.countries.some((c) => b.origin.countries.includes(c));
    if (exact) findings.push({ level: "error", a: a.id, b: b.id, why: "identical name or alternative name" });
    else if (near >= 0.85) findings.push({ level: "warning", a: a.id, b: b.id, why: `very similar names (${near.toFixed(2)})` });
    else if (ij >= 0.7 && sameCountry) findings.push({ level: "warning", a: a.id, b: b.id, why: `same country and ${Math.round(ij * 100)}% ingredient overlap` });
  }
  return findings;
}

function loadAndCompile() {
  const ref = loadReference(), raws = loadRaw(), errs = [];
  const recipes = raws.map((r) => compile(r, ref, errs));
  return { ref, raws, recipes, compileErrors: errs };
}
module.exports = { ALLERGENS, flagEmoji, slugify, loadReference, loadRaw, compile, validate, detectDuplicates, loadAndCompile, ROOT };
