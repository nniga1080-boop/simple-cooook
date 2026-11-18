(function (root) {
  "use strict";
  const DAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const mins = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s)); return m ? +m[1] * 60 + +m[2] : null; };
  function localNow(tz, now) {
    try {
      const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now || new Date());
      const g = (t) => p.find((x) => x.type === t).value;
      return { wd: DAY[g("weekday")], m: +g("hour") * 60 + +g("minute") };
    } catch (e) { return null; }
  }
  // hours = { periods: [{ d: 0-6 (0 = Sunday), o: "HH:MM", c: "HH:MM" }] }; returns true / false / null (unknown)
  function openNow(hours, tz, now) {
    if (!hours || !Array.isArray(hours.periods) || !hours.periods.length || !tz) return null;
    const n = localNow(tz, now); if (!n) return null;
    let valid = false;
    for (const p of hours.periods) {
      const o = mins(p.o), c = mins(p.c); if (o === null || c === null || !(p.d >= 0 && p.d <= 6)) continue; valid = true;
      if (c > o) { if (p.d === n.wd && n.m >= o && n.m < c) return true; }
      else if ((p.d === n.wd && n.m >= o) || (p.d === (n.wd + 6) % 7 && n.m < c)) return true;
    }
    return valid ? false : null;
  }
  const dirUrls = (lat, lng) => ({
    google: "https://www.google.com/maps/dir/?api=1&destination=" + lat + "," + lng,
    apple: "https://maps.apple.com/?daddr=" + lat + "," + lng,
    osm: "https://www.openstreetmap.org/directions?to=" + lat + "%2C" + lng,
  });
  function radiusBounds(lat, lng, km) {
    const dLat = km / 111.32, dLng = km / (111.32 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
    return { south: Math.max(-90, lat - dLat), north: Math.min(90, lat + dLat), west: Math.max(-180, lng - dLng), east: Math.min(180, lng + dLng) };
  }
  const distKm = (a, b, c, d) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
  const safeHttp = (u) => /^https?:\/\/[^\s"'<>]+$/i.test(String(u || "")) ? u : "";
  const api = { openNow, dirUrls, radiusBounds, distKm, safeHttp };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SC_PLACE = api;
})(typeof window !== "undefined" ? window : globalThis);
