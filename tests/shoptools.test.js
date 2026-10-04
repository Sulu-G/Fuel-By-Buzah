const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../js/shoptools.js");
const L = require("../js/logic.js");

test("end of day is 11:59:59 PM Houston time, across daylight saving", () => {
  // Thu Oct 1 2026 (CDT, UTC-5) → Oct 2 04:59:59Z
  assert.equal(new Date(T.endOfDayMs("2026-10-01")).toISOString(), "2026-10-02T04:59:59.000Z");
  // Thu Dec 3 2026 (CST, UTC-6) → Dec 4 05:59:59Z
  assert.equal(new Date(T.endOfDayMs("2026-12-03")).toISOString(), "2026-12-04T05:59:59.000Z");
  assert.equal(T.todayInZone(Date.parse("2026-10-02T03:00:00Z")), "2026-10-01"); // 10pm Thursday in Houston
});

test("deadline: open → Thursday, late → Friday, closed → next Thursday", () => {
  const s = { lateOrders: "fee", lateFee: 7.5 };
  const at = (d) => { const w = L.orderWindow(d, s); return T.orderDeadline(w, L.weekSchedule(w.weekOf)); };
  assert.deepEqual([at("2026-09-28").dateStr, at("2026-09-28").kind], ["2026-10-01", "order"]); // Monday
  assert.deepEqual([at("2026-10-02").dateStr, at("2026-10-02").kind], ["2026-10-02", "late"]);  // Friday with fee
  assert.equal(at("2026-10-03").dateStr, "2026-10-08"); // Saturday → next week's Thursday
  const blocked = L.orderWindow("2026-10-02", { lateOrders: "block" });
  assert.equal(T.orderDeadline(blocked, L.weekSchedule(blocked.weekOf)).dateStr, "2026-10-08");
});

test("countdown wording", () => {
  const h = 3600e3, m = 60e3;
  assert.equal(T.formatCountdown(3 * 24 * h + 5 * h), "3 days");
  assert.equal(T.formatCountdown(24 * h + 6 * h + 20 * m), "1 day 6 hrs");
  assert.equal(T.formatCountdown(24 * h + 10 * m), "1 day");
  assert.equal(T.formatCountdown(5 * h + 12 * m), "5 hrs 12 min");
  assert.equal(T.formatCountdown(1 * h), "1 hr");
  assert.equal(T.formatCountdown(42 * m + 5000), "42 min");
  assert.equal(T.formatCountdown(20000), "under a minute");
  assert.equal(T.formatCountdown(0), "");
});

test("Cash App link fills in the amount", () => {
  assert.equal(T.cashAppPayUrl("$buzah", 42.5), "https://cash.app/$buzah/42.50");
  assert.equal(T.cashAppPayUrl("buzah", 61.999), "https://cash.app/$buzah/62.00");
  assert.equal(T.cashAppPayUrl("$buzah", 0), "https://cash.app/$buzah");
  assert.equal(T.cashAppPayUrl("$bad tag", 10), "");
  assert.equal(T.cashAppPayUrl("javascript:alert(1)", 10), "");
});

test("calendar file is a valid all-day event with escaped text", () => {
  const ics = T.buildIcs({ uid: "order-ABC123", date: "2026-10-04", title: "Fuel by Buzah delivery (5 meals)", description: "Order #ABC123, $62.00\nDelivered to: 77 Oak St; Apt 2", location: "77 Oak St, Houston" }, new Date("2026-10-01T12:00:00Z"));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261004\r\n/);
  assert.match(ics, /DTEND;VALUE=DATE:20261005\r\n/);
  assert.match(ics, /DTSTAMP:20261001T120000Z/);
  assert.ok(ics.includes("DESCRIPTION:Order #ABC123\\, $62.00\\nDelivered to: 77 Oak St\\; Apt 2"));
  assert.ok(ics.split("\r\n").every((l) => l.length <= 75));
  assert.match(ics, /END:VCALENDAR\r\n$/);
  // month rollover
  assert.match(T.buildIcs({ uid: "x", date: "2026-10-31", title: "t" }), /DTEND;VALUE=DATE:20261101/);
  const g = new URL(T.googleCalendarUrl({ date: "2026-10-04", title: "Pickup", description: "d" }));
  assert.equal(g.searchParams.get("dates"), "20261004/20261005");
  assert.equal(g.searchParams.get("text"), "Pickup");
});

test("reorder keeps meals still on the menu and reports removed ones", () => {
  const menu = [{ id: "m1", name: "Chicken" }, { id: "m2", name: "Turkey" }];
  const r = T.reorderCart({ items: [{ mealId: "m1", qty: 3 }, { mealId: "m9", qty: 2, name: "Old Salmon" }, { mealId: "m2", qty: 99 }, { mealId: "m2", qty: -1 }] }, menu);
  assert.deepEqual(r.cart, { m1: 3, m2: 50 });
  assert.deepEqual(r.missing, ["Old Salmon"]);
  assert.equal(r.meals, 53);
  assert.deepEqual(T.reorderCart(null, menu), { cart: {}, missing: [], meals: 0 });
});
