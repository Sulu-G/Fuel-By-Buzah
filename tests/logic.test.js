const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../js/logic.js");

const settings = { deliveryFee: 5, pickupDiscountPct: 10, taxRatePct: 0, lateOrders: "fee", lateFee: 7.5 };

const menu = [
  {
    id: "m1",
    name: "Chicken & Rice",
    price: 12,
    macros: { cal: 550, protein: 45, carbs: 60, fat: 12 },
    ingredients: [
      { qty: 0.4, unit: "lb", item: "chicken breast" },
      { qty: 1, unit: "cup", item: "jasmine rice" },
    ],
  },
  {
    id: "m2",
    name: "Turkey Bowl",
    price: 13.5,
    macros: { cal: 600, protein: 42, carbs: 55, fat: 20 },
    ingredients: [
      { qty: 0.35, unit: "lb", item: "ground turkey" },
      { qty: 1, unit: "cup", item: "jasmine rice" },
    ],
  },
];
const menuById = L.indexById(menu);
const customers = [
  { id: "c1", name: "Ava", address: "200 Oak St", phone: "555-0101" },
  { id: "c2", name: "Ben", address: "100 Elm St", phone: "555-0102" },
];
const customersById = L.indexById(customers);

// Week of Mon 2026-10-05 → deliver Sun 2026-10-11
test("weekStart snaps any day to Monday", () => {
  assert.equal(L.weekStart("2026-10-05"), "2026-10-05"); // Mon
  assert.equal(L.weekStart("2026-10-08"), "2026-10-05"); // Thu
  assert.equal(L.weekStart("2026-10-11"), "2026-10-05"); // Sun belongs to same week
  assert.equal(L.weekStart("2026-01-01"), "2025-12-29"); // crosses year boundary
});

test("weekSchedule lays out Thu cutoff, Sat shop, Sun delivery", () => {
  const s = L.weekSchedule("2026-10-05");
  assert.equal(s.ordersClose, "2026-10-08");
  assert.equal(s.shopDay, "2026-10-10");
  assert.equal(s.deliveryDay, "2026-10-11");
});

test("orderWindow: Mon–Thu open, no fee", () => {
  for (const d of ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]) {
    const w = L.orderWindow(d, settings);
    assert.equal(w.status, "open");
    assert.equal(w.weekOf, "2026-10-05");
    assert.equal(w.lateFee, 0);
  }
});

test("orderWindow: Friday with fee policy charges late fee this week", () => {
  const w = L.orderWindow("2026-10-09", settings);
  assert.equal(w.status, "late");
  assert.equal(w.weekOf, "2026-10-05");
  assert.equal(w.lateFee, 7.5);
});

test("orderWindow: Friday with block policy rolls to next week", () => {
  const w = L.orderWindow("2026-10-09", { ...settings, lateOrders: "block" });
  assert.equal(w.status, "closed");
  assert.equal(w.weekOf, "2026-10-12");
});

test("orderWindow: weekend orders roll to next week", () => {
  assert.equal(L.orderWindow("2026-10-10", settings).weekOf, "2026-10-12");
  assert.equal(L.orderWindow("2026-10-11", settings).weekOf, "2026-10-12");
});

test("orderTotals: delivery adds flat fee", () => {
  const t = L.orderTotals({ items: [{ mealId: "m1", qty: 3 }, { mealId: "m2", qty: 2 }], fulfillment: "delivery", lateFee: 0 }, menuById, settings);
  assert.equal(t.subtotal, 63);
  assert.equal(t.deliveryFee, 5);
  assert.equal(t.pickupDiscount, 0);
  assert.equal(t.total, 68);
  assert.equal(t.mealCount, 5);
});

test("orderTotals: pickup gets % discount, late fee added, tax on food only", () => {
  const s = { ...settings, taxRatePct: 8.25 };
  const t = L.orderTotals({ items: [{ mealId: "m1", qty: 5 }], fulfillment: "pickup", lateFee: 7.5 }, menuById, s);
  assert.equal(t.subtotal, 60);
  assert.equal(t.pickupDiscount, 6);
  assert.equal(t.tax, 4.46); // 54 * 8.25% = 4.455 → 4.46
  assert.equal(t.deliveryFee, 0);
  assert.equal(t.total, 65.96); // 54 + 4.46 + 7.5
});

test("orderTotals ignores meals removed from the menu", () => {
  const t = L.orderTotals({ items: [{ mealId: "gone", qty: 2 }, { mealId: "m1", qty: 1 }], fulfillment: "pickup" }, menuById, { ...settings, pickupDiscountPct: 0 });
  assert.equal(t.lines.length, 1);
  assert.equal(t.total, 12);
});

test("orderMacros and macroProgress", () => {
  const m = L.orderMacros({ items: [{ mealId: "m1", qty: 5 }] }, menuById);
  assert.deepEqual(m, { cal: 2750, protein: 225, carbs: 300, fat: 60 });
  const p = L.macroProgress(m, { cal: 2500, protein: 180, carbs: 250, fat: 70 }, 7);
  assert.equal(p.protein.target, 1260);
  assert.equal(p.protein.pct, 18);
  assert.equal(L.macroProgress(m, {}, 7).cal.pct, null);
});

test("parseIngredientLine handles units, fractions, and unitless items", () => {
  assert.deepEqual(L.parseIngredientLine("1.5 lb Chicken Breast"), { qty: 1.5, unit: "lb", item: "chicken breast" });
  assert.deepEqual(L.parseIngredientLine("1/2 cups rice"), { qty: 0.5, unit: "cup", item: "rice" });
  assert.deepEqual(L.parseIngredientLine("2 avocados"), { qty: 2, unit: "ea", item: "avocados" });
  assert.equal(L.parseIngredientLine("salt to taste"), null);
  assert.equal(L.formatIngredient({ qty: 2, unit: "ea", item: "avocados" }), "2 avocados");
});

test("shoppingList merges the same ingredient across meals and orders", () => {
  const orders = [
    { items: [{ mealId: "m1", qty: 2 }] },
    { items: [{ mealId: "m1", qty: 1 }, { mealId: "m2", qty: 2 }] },
  ];
  const list = L.shoppingList(orders, menuById);
  const rice = list.find((r) => r.item === "jasmine rice");
  assert.equal(rice.qty, 5);
  assert.deepEqual(rice.usedIn, ["Chicken & Rice", "Turkey Bowl"]);
  assert.equal(list.find((r) => r.item === "chicken breast").qty, 1.2);
  assert.equal(list.find((r) => r.item === "ground turkey").qty, 0.7);
});

test("prepCounts sorts by quantity", () => {
  const counts = L.prepCounts([{ items: [{ mealId: "m2", qty: 1 }, { mealId: "m1", qty: 4 }] }], menuById);
  assert.deepEqual(counts.map((c) => [c.name, c.qty]), [["Chicken & Rice", 4], ["Turkey Bowl", 1]]);
});

test("fulfillmentSheet splits delivery/pickup and weekSummary totals", () => {
  const orders = [
    { id: "o1", customerId: "c1", items: [{ mealId: "m1", qty: 2 }], fulfillment: "delivery" },
    { id: "o2", customerId: "c2", items: [{ mealId: "m1", qty: 2 }], fulfillment: "delivery" },
    { id: "o3", customerId: "c1", items: [{ mealId: "m2", qty: 2 }], fulfillment: "pickup" },
  ];
  const sheet = L.fulfillmentSheet(orders, customersById, menuById, settings);
  assert.equal(sheet.delivery.length, 2);
  assert.equal(sheet.delivery[0].address, "100 Elm St"); // sorted by address
  assert.equal(sheet.pickup.length, 1);

  const s = L.weekSummary(orders, menuById, settings);
  assert.equal(s.orders, 3);
  assert.equal(s.meals, 6);
  assert.equal(s.revenue, 29 + 29 + 24.3);
  assert.equal(s.deliveries, 2);
  assert.equal(s.pickups, 1);
});

test("validateOrder catches common mistakes", () => {
  assert.deepEqual(L.validateOrder({ customerId: "c1", items: [{ mealId: "m1", qty: 1 }], fulfillment: "pickup" }, menuById, customersById), []);
  const errs = L.validateOrder({ customerId: "nope", items: [], fulfillment: "drone" }, menuById, customersById);
  assert.equal(errs.length, 3);
  assert.ok(L.validateOrder({ customerId: "c1", items: [{ mealId: "m1", qty: 1.5 }], fulfillment: "pickup" }, menuById, customersById).length);
});

test("round2 avoids float drift", () => {
  assert.equal(L.round2(1.005), 1.01);
  assert.equal(L.round2(0.1 + 0.2), 0.3);
});
