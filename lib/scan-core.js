/* Ingredient scanner core: name -> canonical id resolution and deterministic recipe ranking. No AI in here. */
(function (root, factory) { if (typeof module === "object" && module.exports) module.exports = factory(); else root.SC_SCAN = factory(); })(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f\u064B-\u065F\u0670\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  // Regional / alternative names -> canonical id. Entries whose id is not in the ingredient table are ignored.
  const ALIAS = { aubergine: "eggplant", courgette: "zucchini", cilantro: "coriander", "fresh coriander": "coriander", garbanzo: "chickpeas", "garbanzo beans": "chickpeas", scallion: "spring-onion", "green onion": "spring-onion", capsicum: "bell-pepper", "sweet pepper": "bell-pepper", prawn: "shrimp", prawns: "shrimp", "ground beef": "minced-beef", mince: "minced-beef" };
  const sing = (w) => (w.length > 3 && /ies$/.test(w) ? w.slice(0, -3) + "y" : w.length > 3 && /(oes|ches|shes|sses)$/.test(w) ? w.slice(0, -2) : w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
  function buildIndex(ingredients) {
    const m = new Map(), put = (k, id) => { k = norm(k); if (k && !m.has(k)) m.set(k, id); if (k && !m.has(sing(k))) m.set(sing(k), id); };
    Object.keys(ingredients).forEach((id) => { put(id.replace(/-/g, " "), id); ["en", "fr", "ar"].forEach((l) => ingredients[id][l] && put(ingredients[id][l], id)); });
    Object.keys(ALIAS).forEach((a) => { if (ingredients[ALIAS[a]]) put(a, ALIAS[a]); });
    return m;
  }
  const resolve = (index, name) => { const k = norm(name); return index.get(k) || index.get(sing(k)) || null; };   // exact normalised match only: never fuzzy-merge variants
  const GROUPS = ["everything", "one", "few", "other"];
  function rank(recipes, have, o) {
    o = Object.assign({ assumePantry: true, allergens: [], diet: [], maxMissing: 8, sort: "match" }, o || {});
    const owned = new Set(have), out = [];
    for (const r of recipes) {
      if (o.allergens.some((a) => (r.allergens || []).includes(a))) continue;                    // safety beats score
      if (o.diet.some((d) => !(r.diet && r.diet[d] === true))) continue;                          // unknown diet info => excluded, never assumed
      const subs = {}; (r.substitutions || []).forEach((s) => { (subs[s.from] = subs[s.from] || []).push(s); });
      let need = 0, got = 0; const missing = [], viaSub = [], optMissing = [];
      for (const i of r.ingredients) {
        const id = i.ingredient_id;
        if (i.optional) { if (!owned.has(id)) optMissing.push(id); continue; }
        if (o.assumePantry && i.pantry) continue;
        need++;
        if (owned.has(id)) got++;
        else { const s = (subs[id] || []).find((x) => owned.has(x.to)); if (s) { got++; viaSub.push({ from: id, to: s.to, note: s.note || "" }); } else missing.push(id); }
      }
      if (!got || missing.length > o.maxMissing) continue;
      const pct = need ? Math.round((got / need) * 100) : 100;
      out.push({ slug: r.slug, need, got, pct, missing, optMissing, viaSub, group: missing.length === 0 ? 0 : missing.length === 1 ? 1 : missing.length <= 3 ? 2 : 3, total: (r.times && r.times.total) || 0, diff: r.difficulty });
    }
    const dv = { Easy: 0, Medium: 1, Hard: 2 };
    const cmp = { match: (a, b) => a.group - b.group || b.pct - a.pct || a.missing.length - b.missing.length, missing: (a, b) => a.missing.length - b.missing.length || b.pct - a.pct,
      time: (a, b) => (a.total || 1e9) - (b.total || 1e9), easy: (a, b) => (dv[a.diff] ?? 9) - (dv[b.diff] ?? 9) }[o.sort] || null;
    return out.sort((a, b) => (cmp ? cmp(a, b) : 0) || b.pct - a.pct || a.slug.localeCompare(b.slug));
  }
  return { norm, buildIndex, resolve, rank, GROUPS };
});
