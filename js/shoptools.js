/*
 * Fuel by Buzah — small helpers for the customer ordering page:
 * order deadline countdown, Cash App pay links, calendar events and
 * "same as last week" reorders. No DOM access, so it's unit-tested in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FuelShopTools = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TZ = "America/Chicago";

  /** The wall-clock time in Houston for an instant, as numbers. */
  function zonedParts(ms, tz = TZ) {
    const p = {};
    for (const x of new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ms))) p[x.type] = x.value;
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second };
  }

  /** Today's date in Houston as YYYY-MM-DD. */
  function todayInZone(ms = Date.now(), tz = TZ) {
    const p = zonedParts(ms, tz);
    return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  }

  /** The instant (ms) when `dateStr` ends (11:59:59 PM) in Houston. Handles daylight saving time. */
  function endOfDayMs(dateStr, tz = TZ) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const wall = Date.UTC(y, m - 1, d, 23, 59, 59);
    let guess = wall;
    for (let i = 0; i < 2; i++) {
      const p = zonedParts(guess, tz);
      const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
      guess += wall - asUtc;
    }
    return guess;
  }

  /**
   * When ordering for the current window closes.
   * @param win      result of FuelLogic.orderWindow()
   * @param schedule result of FuelLogic.weekSchedule(win.weekOf)
   * @returns { dateStr, ms, kind: "order" | "late" }
   */
  function orderDeadline(win, schedule) {
    if (win.status === "late") return { dateStr: schedule.lateDay, ms: endOfDayMs(schedule.lateDay), kind: "late" };
    return { dateStr: schedule.ordersClose, ms: endOfDayMs(schedule.ordersClose), kind: "order" };
  }

  /** "3 days", "1 day 6 hrs", "5 hrs 12 min", "42 min", "under a minute". */
  function formatCountdown(msLeft) {
    if (msLeft <= 0) return "";
    const min = Math.floor(msLeft / 60000);
    const days = Math.floor(min / 1440);
    const hrs = Math.floor((min % 1440) / 60);
    const mins = min % 60;
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    if (days >= 2) return plural(days, "day");
    if (days === 1) return hrs ? `1 day ${plural(hrs, "hr")}` : "1 day";
    if (hrs) return mins ? `${plural(hrs, "hr")} ${mins} min` : plural(hrs, "hr");
    if (mins) return `${mins} min`;
    return "under a minute";
  }

  /** Cash App link with the amount filled in: https://cash.app/$name/42.50 */
  function cashAppPayUrl(cashtag, amount) {
    const tag = String(cashtag || "").trim().replace(/^\$+/, "");
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(tag)) return "";
    const amt = Number(amount) > 0 ? `/${(Math.round(Number(amount) * 100) / 100).toFixed(2)}` : "";
    return `https://cash.app/$${tag}${amt}`;
  }

  // ---------- Calendar ----------

  const icsEscape = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const compact = (dateStr) => dateStr.replace(/-/g, "");
  function nextDay(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  }

  /** Fold long lines at 75 octets as the iCalendar spec requires (simple ASCII-safe version). */
  function fold(line) {
    const out = [];
    let rest = line;
    while (rest.length > 74) { out.push(rest.slice(0, 74)); rest = " " + rest.slice(74); }
    out.push(rest);
    return out.join("\r\n");
  }

  /**
   * An all-day calendar event for a delivery or pickup day.
   * @param ev { date, title, description, location, uid }
   */
  function buildIcs(ev, now = new Date()) {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    return [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fuel by Buzah//Ordering//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${icsEscape(ev.uid)}@fuelbybuzah`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(ev.date)}`,
      `DTEND;VALUE=DATE:${compact(nextDay(ev.date))}`,
      `SUMMARY:${icsEscape(ev.title)}`,
      ev.description ? `DESCRIPTION:${icsEscape(ev.description)}` : null,
      ev.location ? `LOCATION:${icsEscape(ev.location)}` : null,
      "TRANSP:TRANSPARENT",
      "END:VEVENT", "END:VCALENDAR",
    ].filter(Boolean).map(fold).join("\r\n") + "\r\n";
  }

  /** Google Calendar "add event" link for the same all-day event. */
  function googleCalendarUrl(ev) {
    const q = new URLSearchParams({
      action: "TEMPLATE",
      text: ev.title,
      dates: `${compact(ev.date)}/${compact(nextDay(ev.date))}`,
      details: ev.description || "",
    });
    if (ev.location) q.set("location", ev.location);
    return `https://calendar.google.com/calendar/render?${q.toString()}`;
  }

  // ---------- Reorder ----------

  /**
   * Rebuild last week's cart from what's on the menu now.
   * @returns { cart, missing: [names], meals, changedPrice }
   */
  function reorderCart(last, menu) {
    const byId = new Map(menu.map((m) => [m.id, m]));
    const cart = {};
    const missing = [];
    let meals = 0;
    for (const it of (last && last.items) || []) {
      const qty = Math.max(0, Math.min(50, Math.floor(Number(it.qty) || 0)));
      if (!qty) continue;
      if (byId.has(it.mealId)) { cart[it.mealId] = (cart[it.mealId] || 0) + qty; meals += qty; }
      else missing.push(it.name || "a meal");
    }
    return { cart, missing, meals };
  }

  return { TZ, zonedParts, todayInZone, endOfDayMs, orderDeadline, formatCountdown, cashAppPayUrl, buildIcs, googleCalendarUrl, reorderCart };
});
