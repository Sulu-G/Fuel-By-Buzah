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
  };
  const row = S.toRow.orders(order);
  assert.equal(row.customer_id, "cust_1");
  assert.equal(row.late_fee, 7.5);
  assert.equal(row.owner_id, undefined, "owner_id is set by the database, never by the client");
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
  assert.deepEqual(S.toRow.customers({ id: "c", name: "Ava" }), { id: "c", name: "Ava", phone: "", address: "", targets: {} });
});

test("isValidDb / isEmpty", () => {
  const empty = { settings: {}, menu: [], customers: [], orders: [] };
  assert.ok(S.isValidDb(empty));
  assert.ok(S.isEmpty(empty));
  assert.ok(!S.isEmpty({ ...empty, menu: [{}] }));
  assert.ok(!S.isValidDb({ hello: 1 }));
  assert.ok(!S.isValidDb(null));
});
