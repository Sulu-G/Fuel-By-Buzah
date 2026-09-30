/**
 * Fuel by Buzah — core business logic.
 *
 * Pure functions only (no DOM, no storage) so they can be unit-tested in Node
 * and reused by the browser UI. Loaded as a plain <script> in the browser
 * (exposes `window.FuelLogic`) and via `require()` in Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FuelLogic = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MACRO_KEYS = ["cal", "protein", "carbs", "fat"];
  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // ---------- Money & numbers ----------

  /** Round to cents without floating-point drift (e.g. 1.005 -> 1.01). */
  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function formatMoney(n) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(round2(n));
  }

  // ---------- Dates (local time, ISO "YYYY-MM-DD" strings) ----------

  function parseDate(str) {
    const [y, m, d] = String(str).split("-").map(Number);
    if (!y || !m || !d) throw new Error(`Invalid date: ${str}`);
    return new Date(y, m - 1, d);
  }

  function toISODate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function addDays(dateStr, n) {
    const d = parseDate(dateStr);
    d.setDate(d.getDate() + n);
    return toISODate(d);
  }

  /** Monday of the week containing `dateStr` (weeks run Monday → Sunday). */
  function weekStart(dateStr) {
    const d = parseDate(dateStr);
    const daysSinceMonday = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - daysSinceMonday);
    return toISODate(d);
  }

  /** Key dates for an order week: orders Mon–Thu, shop/prep Saturday, cook & deliver Sunday. */
  function weekSchedule(weekOf) {
    return {
      weekOf,
      ordersOpen: weekOf,
      ordersClose: addDays(weekOf, 3), // Thursday
      lateDay: addDays(weekOf, 4), // Friday
      shopDay: addDays(weekOf, 5), // Saturday
      deliveryDay: addDays(weekOf, 6), // Sunday
    };
  }

  function formatDate(dateStr, opts) {
    return parseDate(dateStr).toLocaleDateString("en-US", opts || { weekday: "short", month: "short", day: "numeric" });
  }

  // ---------- Order window ----------

  /**
   * Decide which delivery week an order placed on `dateStr` belongs to.
   *  - Mon–Thu: open, this week, no fee
   *  - Friday:  late — either a premium fee (settings.lateOrders === "fee")
   *             or rolled to next week (settings.lateOrders === "block")
   *  - Sat–Sun: this week's cutoff has passed, rolls to next week
   */
  function orderWindow(dateStr, settings) {
    const day = parseDate(dateStr).getDay();
    const thisWeek = weekStart(dateStr);
    const nextWeek = addDays(thisWeek, 7);

    if (day >= 1 && day <= 4) {
      return { status: "open", weekOf: thisWeek, lateFee: 0, message: "Orders are open for this Sunday's delivery." };
    }
    if (day === 5) {
      if (settings.lateOrders === "fee") {
        return {
          status: "late",
          weekOf: thisWeek,
          lateFee: round2(settings.lateFee),
          message: `Friday order — a ${formatMoney(settings.lateFee)} late fee applies.`,
        };
      }
      return { status: "closed", weekOf: nextWeek, lateFee: 0, message: "Friday orders aren't accepted — this goes to next week." };
    }
    return { status: "closed", weekOf: nextWeek, lateFee: 0, message: `${DAY_NAMES[day]} — this week is closed, order goes to next week.` };
  }

  // ---------- Pricing ----------

  function indexById(list) {
    const map = new Map();
    for (const item of list || []) map.set(item.id, item);
    return map;
  }

  /**
   * Full price breakdown for one order.
   * Pickup discount is a % off the food subtotal; delivery is a flat fee.
   * Tax applies to food only (after discount), not to delivery or late fees.
   */
  function orderTotals(order, menuById, settings) {
    const lines = order.items
      .map((it) => {
        const meal = menuById.get(it.mealId);
        if (!meal) return null;
        return { mealId: meal.id, name: meal.name, qty: it.qty, unitPrice: meal.price, lineTotal: round2(meal.price * it.qty) };
      })
      .filter(Boolean);

    const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
    const pickupDiscount = order.fulfillment === "pickup" ? round2((subtotal * (settings.pickupDiscountPct || 0)) / 100) : 0;
    const taxable = round2(subtotal - pickupDiscount);
    const tax = round2((taxable * (settings.taxRatePct || 0)) / 100);
    const deliveryFee = order.fulfillment === "delivery" ? round2(settings.deliveryFee || 0) : 0;
    const lateFee = round2(order.lateFee || 0);
    const total = round2(taxable + tax + deliveryFee + lateFee);
    const mealCount = lines.reduce((s, l) => s + l.qty, 0);

    return { lines, mealCount, subtotal, pickupDiscount, tax, deliveryFee, lateFee, total };
  }

  // ---------- Macros ----------

  function emptyMacros() {
    return { cal: 0, protein: 0, carbs: 0, fat: 0 };
  }

  function orderMacros(order, menuById) {
    const totals = emptyMacros();
    for (const it of order.items) {
      const meal = menuById.get(it.mealId);
      if (!meal) continue;
      for (const k of MACRO_KEYS) totals[k] += (meal.macros[k] || 0) * it.qty;
    }
    return totals;
  }

  function sumMacros(list) {
    const totals = emptyMacros();
    for (const m of list) for (const k of MACRO_KEYS) totals[k] += m[k] || 0;
    return totals;
  }

  /**
   * Compare a customer's meal-prep macros to their daily targets over `days`.
   * Returns per-macro { actual, target, pct } — pct is how much of the target
   * the prepped meals cover (not capped, so >100% shows overshoot).
   */
  function macroProgress(actual, dailyTargets, days) {
    const out = {};
    for (const k of MACRO_KEYS) {
      const target = (dailyTargets && dailyTargets[k] ? dailyTargets[k] : 0) * days;
      out[k] = { actual: Math.round(actual[k]), target, pct: target > 0 ? Math.round((actual[k] / target) * 100) : null };
    }
    return out;
  }

  // ---------- Kitchen: shopping list & prep counts ----------

  const UNIT_ALIASES = {
    lbs: "lb", pound: "lb", pounds: "lb",
    ounce: "oz", ounces: "oz",
    cups: "cup", tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
    tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
    grams: "g", gram: "g", kg: "kg",
    each: "ea", ea: "ea", pc: "ea", pcs: "ea",
    can: "can", cans: "can", clove: "clove", cloves: "clove",
  };
  const KNOWN_UNITS = new Set(["lb", "oz", "cup", "tbsp", "tsp", "g", "kg", "ea", "can", "clove"]);

  function normalizeUnit(u) {
    const key = String(u || "").toLowerCase();
    return UNIT_ALIASES[key] || key;
  }

  /**
   * Parse "1.5 lb chicken breast" → { qty: 1.5, unit: "lb", item: "chicken breast" }.
   * Unit is optional: "2 avocados" → { qty: 2, unit: "ea", item: "avocados" }.
   * Fractions like "1/2 cup rice" are supported. Returns null for unparseable lines.
   */
  function parseIngredientLine(line) {
    const m = String(line).trim().match(/^(\d+(?:\.\d+)?|\d+\/\d+)\s+(.+)$/);
    if (!m) return null;
    let qty;
    if (m[1].includes("/")) {
      const [a, b] = m[1].split("/").map(Number);
      if (!b) return null;
      qty = a / b;
    } else qty = Number(m[1]);

    const rest = m[2].trim().split(/\s+/);
    const maybeUnit = normalizeUnit(rest[0]);
    if (KNOWN_UNITS.has(maybeUnit) && rest.length > 1) {
      return { qty: round2(qty), unit: maybeUnit, item: rest.slice(1).join(" ").toLowerCase() };
    }
    return { qty: round2(qty), unit: "ea", item: rest.join(" ").toLowerCase() };
  }

  function formatIngredient(ing) {
    return ing.unit === "ea" ? `${ing.qty} ${ing.item}` : `${ing.qty} ${ing.unit} ${ing.item}`;
  }

  /** Aggregate ingredients across all orders (per-serving amounts × qty). */
  function shoppingList(orders, menuById) {
    const map = new Map();
    for (const order of orders) {
      for (const it of order.items) {
        const meal = menuById.get(it.mealId);
        if (!meal) continue;
        for (const ing of meal.ingredients || []) {
          const key = `${ing.item.toLowerCase()}|${ing.unit}`;
          const row = map.get(key) || { item: ing.item.toLowerCase(), unit: ing.unit, qty: 0, usedIn: new Set() };
          row.qty = round2(row.qty + ing.qty * it.qty);
          row.usedIn.add(meal.name);
          map.set(key, row);
        }
      }
    }
    return [...map.values()]
      .map((r) => ({ ...r, usedIn: [...r.usedIn].sort() }))
      .sort((a, b) => a.item.localeCompare(b.item));
  }

  /** How many of each meal to cook this week, most first. */
  function prepCounts(orders, menuById) {
    const counts = new Map();
    for (const order of orders) {
      for (const it of order.items) {
        if (!menuById.has(it.mealId)) continue;
        counts.set(it.mealId, (counts.get(it.mealId) || 0) + it.qty);
      }
    }
    return [...counts.entries()]
      .map(([mealId, qty]) => ({ mealId, name: menuById.get(mealId).name, qty }))
      .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
  }

  // ---------- Sunday delivery sheet ----------

  function fulfillmentSheet(orders, customersById, menuById, settings) {
    const rows = orders.map((o) => {
      const c = customersById.get(o.customerId) || { name: "Unknown customer", address: "", phone: "" };
      const t = orderTotals(o, menuById, settings);
      return { orderId: o.id, customer: c.name, address: c.address, phone: c.phone, meals: t.mealCount, total: t.total, notes: o.notes || "", fulfillment: o.fulfillment };
    });
    return {
      delivery: rows.filter((r) => r.fulfillment === "delivery").sort((a, b) => a.address.localeCompare(b.address)),
      pickup: rows.filter((r) => r.fulfillment === "pickup").sort((a, b) => a.customer.localeCompare(b.customer)),
    };
  }

  // ---------- Weekly summary ----------

  function weekSummary(orders, menuById, settings) {
    let revenue = 0;
    let meals = 0;
    let deliveries = 0;
    for (const o of orders) {
      const t = orderTotals(o, menuById, settings);
      revenue += t.total;
      meals += t.mealCount;
      if (o.fulfillment === "delivery") deliveries++;
    }
    return {
      orders: orders.length,
      meals,
      revenue: round2(revenue),
      avgOrder: orders.length ? round2(revenue / orders.length) : 0,
      deliveries,
      pickups: orders.length - deliveries,
    };
  }

  // ---------- Validation ----------

  function validateOrder(order, menuById, customersById) {
    const errors = [];
    if (!customersById.has(order.customerId)) errors.push("Pick a customer.");
    const items = (order.items || []).filter((it) => it.qty > 0);
    if (items.length === 0) errors.push("Add at least one meal.");
    for (const it of items) {
      if (!Number.isInteger(it.qty)) errors.push("Meal quantities must be whole numbers.");
      if (!menuById.has(it.mealId)) errors.push("One of the meals is no longer on the menu.");
    }
    if (!["delivery", "pickup"].includes(order.fulfillment)) errors.push("Choose delivery or pickup.");
    return [...new Set(errors)];
  }

  function validateMeal(meal) {
    const errors = [];
    if (!meal.name || !meal.name.trim()) errors.push("Meal needs a name.");
    if (!(meal.price > 0)) errors.push("Price must be greater than $0.");
    for (const k of MACRO_KEYS) {
      if (!(meal.macros[k] >= 0)) errors.push(`${k} must be 0 or more.`);
    }
    return errors;
  }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  return {
    MACRO_KEYS,
    DAY_NAMES,
    round2,
    formatMoney,
    parseDate,
    toISODate,
    addDays,
    weekStart,
    weekSchedule,
    formatDate,
    orderWindow,
    indexById,
    orderTotals,
    orderMacros,
    sumMacros,
    macroProgress,
    parseIngredientLine,
    formatIngredient,
    shoppingList,
    prepCounts,
    fulfillmentSheet,
    weekSummary,
    validateOrder,
    validateMeal,
    uid,
  };
});
