/* Simple Cook recipe core: pure functions shared by the browser (window.SC_CORE) and Node scripts/tests.
   No DOM, no I/O. Covered by tests/unit-core.js. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(); else root.SC_CORE = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const UNITS = ["g", "kg", "ml", "l", "tsp", "tbsp", "pinch", "bunch", "handful"];
  const FR = { 0.25: "¼", 0.5: "½", 0.75: "¾" };

  /* "1", "1.5", "1/2", "1 1/2", "2-3" -> {min,max}; "" -> null. Returns undefined when invalid. */
  function parseQuantity(s) {
    s = String(s == null ? "" : s).trim();
    if (!s) return null;
    const one = (t) => {
      t = t.trim();
      let m;
      if ((m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t))) return +m[1] + m[2] / m[3];
      if ((m = /^(\d+)\/(\d+)$/.exec(t))) return m[2] === "0" ? NaN : m[1] / m[2];
      if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
      return NaN;
    };
    const r = s.split(/\s*[-–]\s*/);
    if (r.length === 2) { const a = one(r[0]), b = one(r[1]); return isNaN(a) || isNaN(b) || b < a ? undefined : { min: a, max: b }; }
    const v = one(s);
    return isNaN(v) ? undefined : { min: v, max: v };
  }

  const roundTo = (v, step) => Math.round(v / step) * step;
  function fracText(v, quarter) {
    const step = quarter ? 0.25 : 0.5;
    let r = roundTo(v, step); if (r === 0) r = step;
    const whole = Math.floor(r + 1e-9), frac = Math.round((r - whole) * 100) / 100;
    return (whole ? String(whole) : "") + (frac ? FR[frac] : "") || "0";
  }
  const trim = (n, d) => String(+n.toFixed(d));

  /* Format one number for a unit, applying sensible rounding and unit promotion (1000 ml -> 1 l). */
  function formatAmount(v, unit) {
    if (unit === "g") { if (v >= 1000) return { text: trim(v / 1000, 2), unit: "kg" }; return { text: trim(v < 10 ? roundTo(v, 0.5) : v < 50 ? Math.round(v) : roundTo(v, 5), 1), unit: "g" }; }
    if (unit === "kg") return { text: trim(v, 2), unit: "kg" };
    if (unit === "ml") { if (v >= 1000) return { text: trim(v / 1000, 2), unit: "l" }; return { text: trim(v < 10 ? roundTo(v, 0.5) : v < 50 ? Math.round(v) : roundTo(v, 5), 1), unit: "ml" }; }
    if (unit === "l") return { text: trim(v, 2), unit: "l" };
    if (unit === "tsp" || unit === "tbsp") return { text: fracText(v, true), unit };
    return { text: fracText(v, v < 2), unit: unit || "" };   // counts, pinch, bunch, handful
  }

  /* Scale a structured ingredient ({qty_min, qty_max, unit}) by factor. */
  function scaleIngredient(ing, factor) {
    if (ing.qty_min == null) return { amount: "", unit: ing.unit || "", scalable: false };
    const a = formatAmount(ing.qty_min * factor, ing.unit);
    if (ing.qty_max != null && ing.qty_max !== ing.qty_min) {
      const b = formatAmount(ing.qty_max * factor, ing.unit);
      return { amount: a.text + "–" + b.text, unit: b.unit, scalable: true };
    }
    return { amount: a.text, unit: a.unit, scalable: true };
  }

  const PLURAL_EXC = { leaf: "leaves", chilli: "chillies" };
  function pluralize(name) {
    const w = name.split(" "), last = w[w.length - 1];
    if (/s$/i.test(last)) return name;
    let p = PLURAL_EXC[last.toLowerCase()] || (/(o)$/i.test(last) ? last + "es" : last + "s");
    w[w.length - 1] = p; return w.join(" ");
  }
  const shortName = (en) => String(en).replace(/\s*\(.*?\)\s*/g, " ").trim();
  /* Display line, e.g. {amount:"2", unit:"", name:"Onion"} -> "2 onions" (plural when amount > 1 and no unit). */
  function ingredientLine(ing, name, factor) {
    const s = scaleIngredient(ing, factor == null ? 1 : factor);
    let nm = shortName(name).toLowerCase();
    nm = nm.charAt(0) + nm.slice(1);
    if (s.scalable && !s.unit && parseFloat(s.amount.replace(/[¼½¾]/g, ".5")) > 1) nm = pluralize(nm);
    const head = s.scalable ? [s.amount, s.unit].filter(Boolean).join(" ") + " " : "";
    const toTaste = !s.scalable ? " (to taste)" : "";
    return (head + nm + toTaste).replace(/\s+/g, " ").trim();
  }

  /* Ingredient matching (also implemented in SQL: match_recipes_by_ingredients). haveIds: array of ingredient ids. */
  function matchRecipes(recipes, haveIds, opts) {
    opts = Object.assign({ minCoverage: 0.5, assumePantry: true, limit: 20 }, opts || {});
    const have = new Set(haveIds);
    const out = [];
    for (const r of recipes) {
      let need = 0, got = 0, viaSub = 0; const missing = [];
      const subs = {};
      (r.substitutions || []).forEach((s) => { (subs[s.from] = subs[s.from] || []).push(s.to); });
      for (const i of r.ingredients) {
        if (i.optional) continue;
        if (opts.assumePantry && i.pantry) continue;
        need++;
        if (have.has(i.ingredient_id)) got++;
        else if ((subs[i.ingredient_id] || []).some((t) => have.has(t))) { got++; viaSub++; }
        else missing.push(i.ingredient_id);
      }
      const coverage = need ? got / need : 1;
      missing.sort();   // same order as the SQL function (array_agg ... order by ingredient_id)
      if (coverage >= opts.minCoverage && got > 0) out.push({ id: r.id, coverage: Math.round(coverage * 1000) / 1000, have: got, need, viaSubstitution: viaSub, missing });
    }
    out.sort((a, b) => b.coverage - a.coverage || a.missing.length - b.missing.length || a.id.localeCompare(b.id));
    return out.slice(0, opts.limit);
  }

  const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f\u064B-\u065F\u0670\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase().replace(/œ/g, "oe").replace(/æ/g, "ae").replace(/ß/g, "ss").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

  return { UNITS, parseQuantity, formatAmount, scaleIngredient, ingredientLine, pluralize, matchRecipes, norm };
});
