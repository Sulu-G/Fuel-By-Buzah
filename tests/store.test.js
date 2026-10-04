const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/store.js");

test("orders map camelCase <-> snake_case and back unchanged", () => {
  const order = {
    id: "ord_1",
    customerId: "cust_1",
    createdOn: "2026-10-05",
    weekOf: "2026-10-05",
    items: [{ mealId: "m1", qty: 2 }],
    fulfillment: "pickup",
    notes: "no onions",
    lateFee: 7.5,
    status: "pending",
    source: "online",
    paymentMethod: "cashapp",
    paid: false,
    quotedTotal: 64.5,
    contact: { name: "Ava", phone: "(713) 555-0100", phoneDigits: "7135550100", address: "1 Main" },
  };
  const row = S.toRow.orders(order);
  assert.equal(row.customer_id, "cust_1");
  assert.equal(row.late_fee, 7.5);
  assert.equal(row.owner_id, undefined, "owner_id is set by the database, never by the client");
  assert.equal(row.payment_method, "cashapp");
  assert.equal(row.quoted_total, 64.5);
  assert.deepEqual(S.fromRow.orders(row), order);
});

test("fromRow coerces Postgres numeric strings and timestamps", () => {
  const meal = S.fromRow.meals({ id: "m1", name: "Bowl", price: "12.50", macros: { cal: 500 }, ingredients: [], active: true });
  assert.equal(meal.price, 12.5);
  const o = S.fromRow.orders({ id: "o", customer_id: "c", created_on: "2026-10-05T00:00:00", week_of: "2026-10-05", items: [], fulfillment: "delivery", notes: null, late_fee: "0.00" });
  assert.equal(o.createdOn, "2026-10-05");
  assert.equal(o.lateFee, 0);
  assert.equal(o.notes, "");
});

test("meals default to active and customers default empty strings", () => {
  assert.equal(S.toRow.meals({ id: "m", name: "x", price: 1 }).active, true);
  assert.equal(S.toRow.meals({ id: "m", name: "x", price: 1, active: false }).active, false);
  assert.deepEqual(S.toRow.customers({ id: "c", name: "Ava" }), { id: "c", name: "Ava", phone: "", address: "", targets: {}, geo: null });
  const geo = { q: "1 main st", lat: 29.7, lng: -95.4 };
  assert.deepEqual(S.fromRow.customers({ id: "c", name: "Ava", geo }).geo, geo);
});

test("isValidDb / isEmpty", () => {
  const empty = { settings: {}, menu: [], customers: [], orders: [] };
  assert.ok(S.isValidDb(empty));
  assert.ok(S.isEmpty(empty));
  assert.ok(!S.isEmpty({ ...empty, menu: [{}] }));
  assert.ok(!S.isValidDb({ hello: 1 }));
  assert.ok(!S.isValidDb(null));
});

test("v1 rows (before online ordering) get safe defaults", () => {
  const o = S.fromRow.orders({ id: "o", customer_id: "c", created_on: "2026-10-05", week_of: "2026-10-05", items: [], fulfillment: "pickup", notes: "", late_fee: 0 });
  assert.equal(o.status, "confirmed");
  assert.equal(o.source, "manager");
  assert.equal(o.paid, false);
  assert.equal(o.quotedTotal, null);
  const row = S.toRow.orders({ id: "o", customerId: "c", createdOn: "2026-10-05", weekOf: "2026-10-05", items: [], fulfillment: "pickup" });
  assert.equal(row.status, "confirmed");
  assert.equal(row.quoted_total, null);
});

test("v6: meal details and weekly plans map both ways", () => {
  const S = require("../js/store.js");
  const meal = { id: "m1", name: "Chicken", price: 12, macros: {}, ingredients: [], active: true, description: "Garlic chicken", allergens: ["milk"], photo: "https://x/y.jpg", weeklyLimit: 15 };
  const row = S.toRow.meals(meal);
  assert.equal(row.photo_url, "https://x/y.jpg");
  assert.equal(row.weekly_limit, 15);
  assert.deepEqual(S.fromRow.meals({ ...row, price: "12.00" }), meal);
  assert.equal(S.toRow.meals({ ...meal, weeklyLimit: "" }).weekly_limit, null);
  assert.deepEqual(S.fromRow.meals({ id: "m2", name: "x", price: 1 }).allergens, []);
  const plan = { id: "plan_1", customerId: "c1", items: [{ mealId: "m1", qty: 2 }], fulfillment: "pickup", paymentMethod: "cash", notes: "", contact: { name: "A" }, status: "paused", skipWeeks: ["2026-10-12"], lastWeek: "2026-10-05", startedFrom: "web_x" };
  const back = S.fromRow.meal_plans({ ...S.toRow.meal_plans(plan), skip_weeks: ["2026-10-12"], last_week: "2026-10-05", created_at: null });
  assert.deepEqual({ ...back, createdAt: undefined }, { ...plan, createdAt: undefined });
  assert.equal(S.dbKey("meal_plans"), "plans");
});
