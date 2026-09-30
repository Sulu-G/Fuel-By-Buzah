/**
 * Fuel by Buzah — UI layer.
 * Renders views from a single `db` object (persisted to localStorage) and a
 * small `ui` object (current tab, week, drafts). All business rules live in
 * logic.js; this file only reads/writes state and builds HTML.
 */
(function () {
  "use strict";

  const L = window.FuelLogic;
  const TABS = ["dashboard", "orders", "menu", "customers", "prep", "deliveries", "settings"];

  // ---------- Helpers ----------
  const $ = (sel, el = document) => el.querySelector(sel);
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const money = L.formatMoney;
  const today = () => L.toISODate(new Date());
  const num = (v) => (v === "" || v == null ? NaN : Number(v));
  const fmtQty = (n) => String(L.round2(n));
  const shortDate = (d) => L.formatDate(d, { month: "short", day: "numeric" });
  const longDate = (d) => L.formatDate(d, { weekday: "short", month: "short", day: "numeric" });
  const invoiceNo = (o) => "INV-" + o.id.replace(/^ord_/, "").slice(-6).toUpperCase();

  // ---------- State ----------
  const S = window.FuelStore;
  const MODE_KEY = "fuel-by-buzah:mode";
  const seed = () => window.FuelSeed.buildDemoData(today());
  let db = null; // loaded in boot()
  let store = null; // LocalStore or CloudStore (see store.js)
  const ui = {
    tab: TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "dashboard",
    weekOf: null,
    orderDraft: newDraft(),
    editMealId: null,
    editCustomerId: null,
    mealDraft: null,
    customerDraft: null,
    errors: {},
    checked: new Set(),
    confirming: null,
    undo: null,
    user: null, // signed-in Supabase user (cloud mode)
    cloudAvailable: false, // config.js has Supabase settings
    onboarding: false, // cloud database is empty on first sign-in
    sync: "idle",
  };

  const isValidDb = S.isValidDb;

  function getPref() {
    try { return localStorage.getItem(MODE_KEY); } catch (_) { return null; }
  }
  function setPref(v) {
    try { v ? localStorage.setItem(MODE_KEY, v) : localStorage.removeItem(MODE_KEY); } catch (_) { /* ignore */ }
  }

  // ---------- Persistence ----------
  let pendingWrites = 0;
  let lastWriteAt = 0;

  function setSync(state) {
    ui.sync = state;
    const pill = $("#sync-pill");
    if (!pill) return;
    const labels = {
      local: ui.cloudAvailable ? "Demo · this browser only" : "Saved in this browser",
      saving: "Saving…",
      saved: "Synced",
      error: "Not saved — retrying",
      offline: "Offline",
    };
    const state2 = store && store.mode === "local" ? "local" : state;
    pill.textContent = labels[state2] || "Synced";
    pill.dataset.state = state2;
  }

  /** Save one change. Optimistic: the UI already shows it; on failure we reload the truth. */
  async function persist(op) {
    pendingWrites++;
    lastWriteAt = Date.now();
    setSync("saving");
    try {
      await store.apply(op, db);
      setSync("saved");
      return true;
    } catch (err) {
      setSync("error");
      toast(`Couldn't save: ${err.message}`);
      await refresh();
      return false;
    } finally {
      pendingWrites--;
      lastWriteAt = Date.now();
    }
  }

  /** Reload everything from the store (used for live sync and error recovery). */
  async function refresh() {
    if (!store || store.mode !== "cloud" || !ui.user) return;
    try {
      db = await store.loadAll();
      setSync("saved");
    } catch (err) {
      setSync("offline");
      return;
    }
    // Don't yank the page out from under someone mid-typing.
    const active = document.activeElement;
    if (active && active.closest && active.closest("#app form")) {
      toast("Updated from another device — changes show when you finish this form.");
      return;
    }
    render();
  }

  let remoteTimer;
  function onRemoteChange() {
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(() => {
      // Ignore the echo of our own writes.
      if (pendingWrites > 0 || Date.now() - lastWriteAt < 1500) return;
      refresh();
    }, 500);
  }

  function newDraft() {
    return { customerId: "", createdOn: today(), qty: {}, fulfillment: "delivery", notes: "" };
  }

  function ctx() {
    const menuById = L.indexById(db.menu);
    const customersById = L.indexById(db.customers);
    const weekOrders = db.orders.filter((o) => o.weekOf === ui.weekOf).sort((a, b) => a.createdOn.localeCompare(b.createdOn));
    return { menuById, customersById, weekOrders, s: db.settings };
  }

  const activeMeals = () => db.menu.filter((m) => m.active !== false);

  // ---------- Small UI pieces ----------
  function macroChips(m) {
    return `<div class="macros">
      <span class="macro cal"><b>${Math.round(m.cal)}</b> cal</span>
      <span class="macro protein"><b>${Math.round(m.protein)}g</b> protein</span>
      <span class="macro carbs"><b>${Math.round(m.carbs)}g</b> carbs</span>
      <span class="macro fat"><b>${Math.round(m.fat)}g</b> fat</span>
    </div>`;
  }

  function macroBars(progress) {
    const labels = { cal: "Calories", protein: "Protein", carbs: "Carbs", fat: "Fat" };
    return `<div class="bars">${L.MACRO_KEYS.map((k) => {
      const p = progress[k];
      const width = p.pct == null ? 0 : Math.min(p.pct, 100);
      const unit = k === "cal" ? "" : "g";
      const right = p.pct == null ? "no target" : `${p.pct}% of ${p.target.toLocaleString()}${unit}`;
      return `<div class="bar-row"><span>${labels[k]}</span><div class="bar"><span style="width:${width}%;background:var(--${k})"></span></div><span class="right">${right}</span></div>`;
    }).join("")}</div>`;
  }

  function hasTargets(targets) {
    return L.MACRO_KEYS.some((k) => targets && Number(targets[k]) > 0);
  }

  /** Customer card body: always shows targets, even before their first order. */
  function customerMacroSection(cu, orderCount, mealsCount, macros, days) {
    const withTargets = hasTargets(cu.targets);
    const t = cu.targets || {};
    const targetLine = withTargets
      ? `<div class="muted small" style="margin-top:6px">Daily targets: ${[
          t.cal ? `${Number(t.cal).toLocaleString()} cal` : "",
          t.protein ? `${t.protein}g protein` : "",
          t.carbs ? `${t.carbs}g carbs` : "",
          t.fat ? `${t.fat}g fat` : "",
        ].filter(Boolean).join(" · ")}</div>`
      : `<div class="muted small" style="margin-top:6px">No macro targets set. <a href="#" data-action="edit-customer" data-id="${cu.id}">Add targets</a> to track their progress.</div>`;
    const orderBtn = `<button class="btn btn-ghost btn-sm" style="margin-top:10px" data-action="order-for" data-id="${cu.id}">+ New order for ${esc(cu.name.split(" ")[0])}</button>`;

    if (orderCount) {
      return `<div class="small"><strong>${mealsCount} meals</strong> this week</div>
        ${macroChips(macros)}
        ${withTargets ? macroBars(L.macroProgress(macros, cu.targets, days)) : targetLine}`;
    }
    return `<div class="small"><strong>No order this week yet.</strong></div>
      ${targetLine}
      ${withTargets ? macroBars(L.macroProgress(L.sumMacros([]), cu.targets, days)) : ""}
      ${orderBtn}`;
  }

  function errorBox(key) {
    const errs = ui.errors[key];
    if (!errs || !errs.length) return "";
    return `<div class="errors" role="alert"><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`;
  }

  function fulfillmentBadges(o) {
    return `<span class="badge ${o.fulfillment}">${o.fulfillment === "delivery" ? "Delivery" : "Pickup"}</span>${o.lateFee ? ' <span class="badge late">Late</span>' : ""}`;
  }

  function windowBanner(win) {
    return `<div class="banner ${win.status}"><span class="dot"></span><span>${esc(win.message)}</span></div>`;
  }

  // ---------- Views ----------
  const views = {
    dashboard() {
      const { menuById, customersById, weekOrders, s } = ctx();
      const sum = L.weekSummary(weekOrders, menuById, s);
      const sched = L.weekSchedule(ui.weekOf);
      const win = L.orderWindow(today(), s);
      const counts = L.prepCounts(weekOrders, menuById);
      const max = counts.length ? counts[0].qty : 1;
      const recent = [...weekOrders].reverse().slice(0, 5);

      return `
      ${windowBanner({ ...win, message: `Today (${longDate(today())}): ${win.message}` })}
      <div class="stats">
        <div class="card stat"><div class="label">Orders</div><div class="value">${sum.orders}</div><div class="hint">${sum.deliveries} delivery · ${sum.pickups} pickup</div></div>
        <div class="card stat"><div class="label">Meals to cook</div><div class="value">${sum.meals}</div><div class="hint">${counts.length} different meals</div></div>
        <div class="card stat"><div class="label">Revenue</div><div class="value">${money(sum.revenue)}</div><div class="hint">incl. fees${s.taxRatePct ? " & tax" : ""}</div></div>
        <div class="card stat"><div class="label">Avg order</div><div class="value">${money(sum.avgOrder)}</div><div class="hint">per customer</div></div>
      </div>
      <div class="grid grid-2">
        <section class="card">
          <div class="card-head"><h2>Top meals this week</h2><button class="btn btn-ghost btn-sm" data-action="goto" data-to="prep">Prep list →</button></div>
          ${counts.length ? `<div class="hbar-list">${counts.map((c) => `
            <div class="hbar"><span>${esc(c.name)}</span><span class="right num">${c.qty}</span>
              <div class="track"><span style="width:${(c.qty / max) * 100}%"></span></div></div>`).join("")}</div>`
            : `<div class="empty">No orders yet for this week.</div>`}
        </section>
        <section class="card">
          <div class="card-head"><h2>This week's schedule</h2></div>
          <div class="table-wrap"><table>
            <tr><td>Orders open</td><td class="right">${longDate(sched.ordersOpen)} – ${longDate(sched.ordersClose)}</td></tr>
            <tr><td>Late orders</td><td class="right">${longDate(sched.lateDay)} · ${s.lateOrders === "fee" ? `+${money(s.lateFee)} fee` : "rolled to next week"}</td></tr>
            <tr><td>Shop &amp; prep</td><td class="right">${longDate(sched.shopDay)}</td></tr>
            <tr><td>Cook &amp; deliver</td><td class="right">${longDate(sched.deliveryDay)}</td></tr>
          </table></div>
          <h3 style="margin-top:16px">Latest orders</h3>
          ${recent.length ? `<div class="table-wrap"><table>${recent.map((o) => {
            const t = L.orderTotals(o, menuById, s);
            const c = customersById.get(o.customerId);
            return `<tr><td>${esc(c ? c.name : "Unknown")}<div class="muted small">${t.mealCount} meals · ${shortDate(o.createdOn)}</div></td><td>${fulfillmentBadges(o)}</td><td class="right num">${money(t.total)}</td></tr>`;
          }).join("")}</table></div>` : `<div class="empty">Nothing yet — <a href="#orders" data-action="goto" data-to="orders">add an order</a>.</div>`}
        </section>
      </div>`;
    },

    orders() {
      const { menuById, customersById, weekOrders, s } = ctx();
      const d = ui.orderDraft;
      const meals = activeMeals();
      const customers = [...db.customers].sort((a, b) => a.name.localeCompare(b.name));
      let tableTotal = 0;

      const rows = weekOrders.map((o) => {
        const t = L.orderTotals(o, menuById, s);
        tableTotal += t.total;
        const c = customersById.get(o.customerId);
        return `<tr>
          <td><strong>${esc(c ? c.name : "Unknown")}</strong>${o.notes ? `<div class="muted small">${esc(o.notes)}</div>` : ""}</td>
          <td>${shortDate(o.createdOn)}</td>
          <td class="num">${t.mealCount}</td>
          <td>${fulfillmentBadges(o)}</td>
          <td class="right num">${money(t.total)}</td>
          <td class="actions">
            <button class="btn btn-ghost btn-sm" data-action="invoice" data-id="${o.id}">Invoice</button>
            <button class="btn btn-danger btn-sm" data-action="delete-order" data-id="${o.id}" aria-label="Delete order">✕</button>
          </td></tr>`;
      }).join("");

      return `
      <div class="split">
        <section class="card">
          <div class="card-head"><h2>New order</h2></div>
          <form id="order-form" data-form="order" novalidate>
            ${errorBox("order")}
            <div class="field">
              <label for="o-customer">Customer</label>
              <select id="o-customer" name="customerId">
                <option value="">Choose a customer…</option>
                ${customers.map((c) => `<option value="${c.id}" ${c.id === d.customerId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
              </select>
              ${customers.length ? "" : `<span class="small muted">No customers yet — add one in <a href="#customers" data-action="goto" data-to="customers">Customers</a>.</span>`}
            </div>
            <div class="field">
              <label for="o-date">Order date</label>
              <input type="date" id="o-date" name="createdOn" value="${esc(d.createdOn)}" required />
            </div>
            <div class="field">
              <span class="label-text">Meals</span>
              <div class="qty-list">
                ${meals.length ? meals.map((m) => `
                  <div class="qty-row">
                    <div><div class="name">${esc(m.name)}</div><div class="muted small">${m.macros.cal} cal · ${m.macros.protein}g protein</div></div>
                    <span class="num muted">${money(m.price)}</span>
                    <input type="number" min="0" step="1" inputmode="numeric" name="qty-${m.id}" aria-label="Quantity of ${esc(m.name)}" value="${d.qty[m.id] || ""}" placeholder="0" />
                  </div>`).join("") : `<div class="muted small">Your menu is empty — add meals in <a href="#menu" data-action="goto" data-to="menu">Menu</a>.</div>`}
              </div>
            </div>
            <div class="field">
              <span class="label-text">Fulfillment</span>
              <div class="radio-group">
                <label><input type="radio" name="fulfillment" value="delivery" ${d.fulfillment === "delivery" ? "checked" : ""}/> Delivery${s.deliveryFee ? ` (+${money(s.deliveryFee)})` : ""}</label>
                <label><input type="radio" name="fulfillment" value="pickup" ${d.fulfillment === "pickup" ? "checked" : ""}/> Pickup${s.pickupDiscountPct ? ` (−${s.pickupDiscountPct}%)` : ""}</label>
              </div>
            </div>
            <div class="field">
              <label for="o-notes">Notes</label>
              <input type="text" id="o-notes" name="notes" value="${esc(d.notes)}" placeholder="Allergies, gate code, swaps…" />
            </div>
            <div id="order-preview">${orderPreview()}</div>
            <div class="btn-row">
              <button class="btn" type="submit">Save order</button>
              <button class="btn btn-ghost" type="button" data-action="clear-draft">Clear</button>
            </div>
          </form>
        </section>
        <section class="card">
          <div class="card-head"><h2>Orders · week of ${shortDate(ui.weekOf)}</h2><span class="badge">${weekOrders.length}</span></div>
          ${weekOrders.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Customer</th><th>Placed</th><th>Meals</th><th>Type</th><th class="right">Total</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr><td colspan="4">Week total</td><td class="right num">${money(tableTotal)}</td><td></td></tr></tfoot>
          </table></div>` : `<div class="empty">No orders for this week yet.</div>`}
        </section>
      </div>`;
    },

    menu() {
      const editing = ui.editMealId ? db.menu.find((m) => m.id === ui.editMealId) : null;
      const m = ui.mealDraft || (editing
        ? { name: editing.name, price: editing.price, macros: editing.macros, ingText: editing.ingredients.map(L.formatIngredient).join("\n") }
        : { name: "", price: "", macros: { cal: "", protein: "", carbs: "", fat: "" }, ingText: "" });
      const meals = activeMeals();
      const removed = db.menu.filter((x) => x.active === false);

      return `
      <div class="split">
        <section class="card">
          <div class="card-head"><h2>${editing ? "Edit meal" : "Add a meal"}</h2></div>
          <form data-form="meal" novalidate>
            ${errorBox("meal")}
            <div class="field"><label for="m-name">Meal name</label><input type="text" id="m-name" name="name" value="${esc(m.name)}" placeholder="e.g. Honey Garlic Chicken" /></div>
            <div class="field"><label for="m-price">Price per meal ($)</label><input type="number" id="m-price" name="price" min="0" step="0.25" value="${esc(m.price)}" /></div>
            <span class="label-text">Macros per meal</span>
            <div class="row" style="margin:4px 0 12px">
              ${[["cal", "Calories"], ["protein", "Protein (g)"], ["carbs", "Carbs (g)"], ["fat", "Fat (g)"]].map(([k, lbl]) => `
                <div class="field" style="margin:0"><label for="m-${k}">${lbl}</label><input type="number" id="m-${k}" name="${k}" min="0" value="${esc(m.macros[k])}" /></div>`).join("")}
            </div>
            <div class="field">
              <label for="m-ing">Ingredients per serving — one per line</label>
              <textarea id="m-ing" name="ingredients" placeholder="0.4 lb chicken breast&#10;1 cup jasmine rice&#10;2 cloves garlic">${esc(m.ingText)}</textarea>
              <span class="small muted">Format: amount, unit (lb, oz, cup, tbsp, tsp, g, can, clove — optional), item. These roll up into Saturday's shopping list.</span>
            </div>
            <div class="btn-row">
              <button class="btn" type="submit">${editing ? "Save changes" : "Add to menu"}</button>
              ${editing ? `<button class="btn btn-ghost" type="button" data-action="cancel-meal">Cancel</button>` : ""}
            </div>
          </form>
        </section>
        <section>
          <div class="grid grid-cards">
            ${meals.map((x) => `
              <article class="card meal-card">
                <div class="card-head"><h3>${esc(x.name)}</h3><span class="price">${money(x.price)}</span></div>
                ${macroChips(x.macros)}
                <ul>${x.ingredients.map((i) => `<li>${esc(L.formatIngredient(i))}</li>`).join("") || "<li>No ingredients listed</li>"}</ul>
                <div class="btn-row">
                  <button class="btn btn-ghost btn-sm" data-action="edit-meal" data-id="${x.id}">Edit</button>
                  <button class="btn btn-danger btn-sm" data-action="remove-meal" data-id="${x.id}">Remove</button>
                </div>
              </article>`).join("") || `<div class="card empty">No meals on the menu yet.</div>`}
          </div>
          ${removed.length ? `
            <section class="card" style="margin-top:16px">
              <div class="card-head"><h3>Removed from menu</h3><span class="muted small">Kept so past invoices stay accurate</span></div>
              <div class="table-wrap"><table>${removed.map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${money(x.price)}</td><td class="actions"><button class="btn btn-ghost btn-sm" data-action="restore-meal" data-id="${x.id}">Restore</button></td></tr>`).join("")}</table></div>
            </section>` : ""}
        </section>
      </div>`;
    },

    customers() {
      const { menuById, weekOrders, s } = ctx();
      const editing = ui.editCustomerId ? db.customers.find((c) => c.id === ui.editCustomerId) : null;
      const c = ui.customerDraft || editing || { name: "", phone: "", address: "", targets: { cal: "", protein: "", carbs: "", fat: "" } };
      const customers = [...db.customers].sort((a, b) => a.name.localeCompare(b.name));
      const days = s.macroDays || 5;

      return `
      <div class="split">
        <section class="card">
          <div class="card-head"><h2>${editing ? "Edit customer" : "Add a customer"}</h2></div>
          <form data-form="customer" novalidate>
            ${errorBox("customer")}
            <div class="field"><label for="c-name">Name</label><input type="text" id="c-name" name="name" value="${esc(c.name)}" /></div>
            <div class="field"><label for="c-phone">Phone</label><input type="tel" id="c-phone" name="phone" value="${esc(c.phone)}" /></div>
            <div class="field"><label for="c-address">Delivery address</label><input type="text" id="c-address" name="address" value="${esc(c.address)}" placeholder="Leave blank for pickup-only" /></div>
            <span class="label-text">Daily macro targets (optional)</span>
            <div class="row" style="margin:4px 0 12px">
              ${[["cal", "Calories"], ["protein", "Protein (g)"], ["carbs", "Carbs (g)"], ["fat", "Fat (g)"]].map(([k, lbl]) => `
                <div class="field" style="margin:0"><label for="c-${k}">${lbl}</label><input type="number" id="c-${k}" name="${k}" min="0" value="${esc(c.targets[k])}" /></div>`).join("")}
            </div>
            <div class="btn-row">
              <button class="btn" type="submit">${editing ? "Save changes" : "Add customer"}</button>
              ${editing ? `<button class="btn btn-ghost" type="button" data-action="cancel-customer">Cancel</button>` : ""}
            </div>
          </form>
        </section>
        <section class="grid">
          <p class="muted small" style="margin:0">Bars show how much of each customer's daily targets this week's meals cover over ${days} days (change in Settings).</p>
          ${customers.map((cu) => {
            const theirs = weekOrders.filter((o) => o.customerId === cu.id);
            const macros = L.sumMacros(theirs.map((o) => L.orderMacros(o, menuById)));
            const mealsCount = theirs.reduce((n, o) => n + L.orderTotals(o, menuById, s).mealCount, 0);
            return `
            <article class="card">
              <div class="card-head">
                <div><h3>${esc(cu.name)}</h3><div class="muted small">${esc(cu.phone || "No phone")} · ${cu.address ? esc(cu.address) : "Pickup only"}</div></div>
                <div class="btn-row">
                  <button class="btn btn-ghost btn-sm" data-action="edit-customer" data-id="${cu.id}">Edit</button>
                  <button class="btn btn-danger btn-sm" data-action="delete-customer" data-id="${cu.id}" aria-label="Delete ${esc(cu.name)}">✕</button>
                </div>
              </div>
              ${customerMacroSection(cu, theirs.length, mealsCount, macros, days)}
            </article>`;
          }).join("") || `<div class="card empty">No customers yet.</div>`}
        </section>
      </div>`;
    },

    prep() {
      const { menuById, weekOrders } = ctx();
      const sched = L.weekSchedule(ui.weekOf);
      const counts = L.prepCounts(weekOrders, menuById);
      const list = L.shoppingList(weekOrders, menuById);
      const totalMeals = counts.reduce((n, c) => n + c.qty, 0);
      const key = (r) => `${ui.weekOf}|${r.item}|${r.unit}`;

      return `
      <div class="page-head">
        <div><h1>Saturday prep</h1><p class="muted">${longDate(sched.shopDay)} · shop &amp; prep for ${weekOrders.length} orders</p></div>
        <button class="btn btn-ghost no-print" data-action="print">Print</button>
      </div>
      <div class="grid grid-2">
        <section class="card">
          <div class="card-head"><h2>Cook list</h2><span class="badge">${totalMeals} meals</span></div>
          ${counts.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Meal</th><th class="right">Qty</th></tr></thead>
            <tbody>${counts.map((c) => `<tr><td>${esc(c.name)}</td><td class="right num">${c.qty}</td></tr>`).join("")}</tbody>
          </table></div>` : `<div class="empty">No orders this week.</div>`}
        </section>
        <section class="card">
          <div class="card-head"><h2>Shopping list</h2><span class="muted small">${list.length} items</span></div>
          ${list.length ? `<div class="table-wrap"><table>
            <thead><tr><th></th><th>Item</th><th class="right">Amount</th><th>Used in</th></tr></thead>
            <tbody>${list.map((r) => {
              const k = key(r);
              const done = ui.checked.has(k);
              return `<tr class="${done ? "checked" : ""}"><td><input type="checkbox" data-check="${esc(k)}" ${done ? "checked" : ""} aria-label="Got ${esc(r.item)}" /></td>
                <td>${esc(r.item)}</td><td class="right num">${fmtQty(r.qty)} ${r.unit === "ea" ? "" : esc(r.unit)}</td>
                <td class="muted small">${esc(r.usedIn.join(", "))}</td></tr>`;
            }).join("")}</tbody>
          </table></div>` : `<div class="empty">Nothing to buy yet.</div>`}
        </section>
      </div>`;
    },

    deliveries() {
      const { menuById, customersById, weekOrders, s } = ctx();
      const sched = L.weekSchedule(ui.weekOf);
      const sheet = L.fulfillmentSheet(weekOrders, customersById, menuById, s);

      const table = (rows, isDelivery) => rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Customer</th>${isDelivery ? "<th>Address</th>" : ""}<th>Phone</th><th class="right">Meals</th><th>Notes</th><th class="right">Total</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr>
          <td class="num">${i + 1}</td><td><strong>${esc(r.customer)}</strong></td>
          ${isDelivery ? `<td>${r.address ? esc(r.address) : '<span class="badge late">No address on file</span>'}</td>` : ""}
          <td>${esc(r.phone)}</td><td class="right num">${r.meals}</td><td class="muted small">${esc(r.notes)}</td><td class="right num">${money(r.total)}</td></tr>`).join("")}</tbody>
      </table></div>` : `<div class="empty">None this week.</div>`;

      return `
      <div class="page-head">
        <div><h1>Sunday deliveries</h1><p class="muted">${longDate(sched.deliveryDay)} · ${sheet.delivery.length} drop-offs, ${sheet.pickup.length} pickups</p></div>
        <button class="btn btn-ghost no-print" data-action="print">Print</button>
      </div>
      <section class="card" style="margin-bottom:16px"><div class="card-head"><h2>Delivery route</h2><span class="muted small">Sorted by address</span></div>${table(sheet.delivery, true)}</section>
      <section class="card"><div class="card-head"><h2>Pickups</h2></div>${table(sheet.pickup, false)}</section>`;
    },

    settings() {
      const s = db.settings;
      const confirmBtn = (action, label, confirmLabel) =>
        `<button class="btn btn-danger" type="button" data-action="${action}">${ui.confirming === action ? confirmLabel : label}</button>`;
      return `
      <div class="grid grid-2">
        <section class="card">
          <div class="card-head"><h2>Business &amp; pricing</h2></div>
          <form data-form="settings" novalidate>
            <div class="field"><label for="s-name">Business name</label><input type="text" id="s-name" name="businessName" value="${esc(s.businessName)}" /></div>
            <div class="field"><label for="s-tag">Tagline (shown on invoices)</label><input type="text" id="s-tag" name="tagline" value="${esc(s.tagline || "")}" /></div>
            <div class="row">
              <div class="field"><label for="s-del">Delivery fee ($)</label><input type="number" id="s-del" name="deliveryFee" min="0" step="0.5" value="${s.deliveryFee}" /></div>
              <div class="field"><label for="s-pick">Pickup discount (%)</label><input type="number" id="s-pick" name="pickupDiscountPct" min="0" max="100" step="1" value="${s.pickupDiscountPct}" /></div>
              <div class="field"><label for="s-tax">Sales tax (%)</label><input type="number" id="s-tax" name="taxRatePct" min="0" max="30" step="0.01" value="${s.taxRatePct}" /></div>
            </div>
            <div class="field">
              <span class="label-text">Friday orders</span>
              <div class="radio-group">
                <label><input type="radio" name="lateOrders" value="fee" ${s.lateOrders === "fee" ? "checked" : ""}/> Accept with late fee</label>
                <label><input type="radio" name="lateOrders" value="block" ${s.lateOrders === "block" ? "checked" : ""}/> Push to next week</label>
              </div>
            </div>
            <div class="row">
              <div class="field"><label for="s-late">Late fee ($)</label><input type="number" id="s-late" name="lateFee" min="0" step="0.5" value="${s.lateFee}" /></div>
              <div class="field"><label for="s-days">Days a prep covers</label><input type="number" id="s-days" name="macroDays" min="1" max="7" step="1" value="${s.macroDays || 5}" /></div>
            </div>
            <button class="btn" type="submit">Save settings</button>
          </form>
        </section>
        <section class="card">
          <div class="card-head"><h2>Your data</h2></div>
          ${store && store.mode === "cloud" ? `
            <div class="banner open"><span class="dot"></span><span>Synced to your cloud database. Signed in as <strong>${esc(ui.user ? ui.user.email : "")}</strong>.</span></div>
            <p class="muted">Changes save automatically and show up live on your other devices. Export a backup file every now and then for safekeeping.</p>
            <div class="btn-row" style="margin-bottom:16px"><button class="btn btn-ghost" type="button" data-action="sign-out">Sign out</button></div>`
          : ui.cloudAvailable ? `
            <div class="banner late"><span class="dot"></span><span>Demo mode. This data lives only in this browser.</span></div>
            <div class="btn-row" style="margin-bottom:16px"><button class="btn" type="button" data-action="use-cloud">Sign in to your database</button></div>`
          : `<p class="muted">Everything is stored in this browser. Export a backup file regularly, or move your data to another device with Import.</p>`}
          <div class="btn-row" style="margin-bottom:16px">
            <button class="btn btn-ghost" type="button" data-action="export">Export backup (.json)</button>
            <label class="btn btn-ghost" for="import-file" style="cursor:pointer">Import backup</label>
            <input type="file" id="import-file" accept="application/json,.json" hidden />
          </div>
          <div class="btn-row">
            ${confirmBtn("reset-demo", "Reset to demo data", "Click again to confirm reset")}
            ${confirmBtn("clear-all", "Start fresh (erase all)", "Click again to erase everything")}
          </div>
        </section>
      </div>`;
    },
  };

  function orderPreview() {
    const { menuById, s } = ctx();
    const d = ui.orderDraft;
    let win;
    try {
      win = L.orderWindow(d.createdOn, s);
    } catch (_) {
      return `<div class="summary muted">Enter a valid order date.</div>`;
    }
    const order = draftToOrder(win);
    const t = L.orderTotals(order, menuById, s);
    const macros = L.orderMacros(order, menuById);
    const week = `Delivers ${longDate(L.weekSchedule(win.weekOf).deliveryDay)}`;
    if (!t.mealCount) {
      return `${windowBanner({ ...win, message: `${win.message} ${week}.` })}<div class="summary muted">Add meals to see the total and macros.</div>`;
    }
    return `
      ${windowBanner({ ...win, message: `${win.message} ${week}.` })}
      <div class="summary">
        <div class="line"><span>Subtotal (${t.mealCount} meals)</span><span>${money(t.subtotal)}</span></div>
        ${t.pickupDiscount ? `<div class="line"><span>Pickup discount</span><span>−${money(t.pickupDiscount)}</span></div>` : ""}
        ${t.tax ? `<div class="line"><span>Tax</span><span>${money(t.tax)}</span></div>` : ""}
        ${t.deliveryFee ? `<div class="line"><span>Delivery</span><span>${money(t.deliveryFee)}</span></div>` : ""}
        ${t.lateFee ? `<div class="line"><span>Late order fee</span><span>${money(t.lateFee)}</span></div>` : ""}
        <div class="line total"><span>Total</span><span>${money(t.total)}</span></div>
      </div>
      ${t.mealCount ? macroChips(macros) : ""}`;
  }

  function draftToOrder(win) {
    const d = ui.orderDraft;
    return {
      id: L.uid("ord"),
      customerId: d.customerId,
      createdOn: d.createdOn,
      weekOf: win.weekOf,
      items: Object.entries(d.qty).filter(([, q]) => q > 0).map(([mealId, qty]) => ({ mealId, qty })),
      fulfillment: d.fulfillment,
      notes: d.notes.trim(),
      lateFee: win.lateFee,
    };
  }

  function readOrderForm(form) {
    const fd = new FormData(form);
    const qty = {};
    for (const [k, v] of fd.entries()) {
      if (k.startsWith("qty-") && v !== "") qty[k.slice(4)] = Number(v);
    }
    ui.orderDraft = {
      customerId: fd.get("customerId") || "",
      createdOn: fd.get("createdOn") || "",
      qty,
      fulfillment: fd.get("fulfillment") || "delivery",
      notes: fd.get("notes") || "",
    };
  }

  // ---------- Invoice modal ----------
  function openInvoice(orderId) {
    const { menuById, customersById, s } = ctx();
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) return;
    const c = customersById.get(o.customerId) || { name: "Unknown customer" };
    const t = L.orderTotals(o, menuById, s);
    const macros = L.orderMacros(o, menuById);
    $("#modal-body").innerHTML = `
      <div class="receipt-head">
        <div><div class="biz" id="modal-title">${esc(s.businessName)}</div><div class="muted small">${esc(s.tagline || "")}</div></div>
        <div class="right"><div><strong>Invoice ${invoiceNo(o)}</strong></div><div class="muted small">Issued ${longDate(o.createdOn)}</div></div>
      </div>
      <div class="receipt-meta">
        <div><span>Bill to</span>${esc(c.name)}${c.phone ? `<br>${esc(c.phone)}` : ""}</div>
        <div><span>${o.fulfillment === "delivery" ? "Deliver to" : "Pickup"}</span>${o.fulfillment === "delivery" ? esc(c.address || "Address needed") : "Customer pickup"}</div>
        <div><span>Ready on</span>${longDate(L.weekSchedule(o.weekOf).deliveryDay)}</div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Meal</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Amount</th></tr></thead>
        <tbody>${t.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="right num">${l.qty}</td><td class="right num">${money(l.unitPrice)}</td><td class="right num">${money(l.lineTotal)}</td></tr>`).join("")}</tbody>
      </table></div>
      <div class="summary">
        <div class="line"><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
        ${t.pickupDiscount ? `<div class="line"><span>Pickup discount</span><span>−${money(t.pickupDiscount)}</span></div>` : ""}
        ${t.tax ? `<div class="line"><span>Tax (${s.taxRatePct}%)</span><span>${money(t.tax)}</span></div>` : ""}
        ${t.deliveryFee ? `<div class="line"><span>Delivery</span><span>${money(t.deliveryFee)}</span></div>` : ""}
        ${t.lateFee ? `<div class="line"><span>Late order fee</span><span>${money(t.lateFee)}</span></div>` : ""}
        <div class="line total"><span>Amount due</span><span>${money(t.total)}</span></div>
      </div>
      <p class="small muted" style="margin-bottom:6px">Week's macros across ${t.mealCount} meals</p>
      ${macroChips(macros)}
      ${o.notes ? `<p class="small" style="margin-top:12px"><strong>Notes:</strong> ${esc(o.notes)}</p>` : ""}
      <div class="btn-row no-print" style="margin-top:20px;justify-content:flex-end">
        <button class="btn btn-ghost" data-action="close-modal">Close</button>
        <button class="btn" data-action="print-invoice">Print / Save PDF</button>
      </div>`;
    $("#modal").hidden = false;
    $('#modal [data-action="print-invoice"]').focus();
  }

  function closeModal() {
    $("#modal").hidden = true;
    $("#modal-body").innerHTML = "";
  }

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg, undoFn) {
    const el = $("#toast");
    ui.undo = undoFn || null;
    el.innerHTML = `${esc(msg)}${undoFn ? ' <button class="btn btn-sm" data-action="undo" style="margin-left:8px">Undo</button>' : ""}`;
    el.style.pointerEvents = undoFn ? "auto" : "none";
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove("show");
      el.style.pointerEvents = "none";
      ui.undo = null;
    }, undoFn ? 6000 : 2800);
  }

  // ---------- Render ----------
  function render() {
    if (!db) return;
    document.body.classList.remove("logged-out");
    const sched = L.weekSchedule(ui.weekOf);
    $("#brand-name").textContent = db.settings.businessName || "Fuel by Buzah";
    $("#week-title").textContent = `Week of ${shortDate(ui.weekOf)}`;
    $("#week-sub").textContent = `Delivers ${longDate(sched.deliveryDay)}`;
    document.querySelectorAll("#tabs [data-tab]").forEach((b) => {
      if (b.dataset.tab === ui.tab && !ui.onboarding) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    setSync(ui.sync === "idle" ? "saved" : ui.sync);
    $("#app").innerHTML = ui.onboarding ? onboardingView() : views[ui.tab]();
  }

  // ---------- Login & first-run screens (cloud mode) ----------
  function showLogin(message) {
    db = null;
    ui.user = null;
    document.body.classList.add("logged-out");
    $("#brand-name").textContent = "Fuel by Buzah";
    $("#app").innerHTML = `
      <section class="card auth-card">
        <h1>Sign in</h1>
        <p class="muted">Sign in to open your meal-prep manager. Your data syncs across your phone and computer.</p>
        ${message ? `<div class="errors" role="alert">${esc(message)}</div>` : ""}
        <form data-form="login" novalidate>
          <div class="field"><label for="l-email">Email</label><input type="email" id="l-email" name="email" autocomplete="username" required /></div>
          <div class="field"><label for="l-pass">Password</label><input type="password" id="l-pass" name="password" autocomplete="current-password" required /></div>
          <button class="btn" type="submit" style="width:100%">Sign in</button>
        </form>
        <div class="auth-divider"><span>or</span></div>
        <button class="btn btn-ghost" style="width:100%" data-action="use-demo">Explore the demo</button>
        <p class="small muted" style="margin-top:10px">The demo runs on sample data saved only in your browser. Nothing is sent to the database.</p>
      </section>`;
    const email = $("#l-email");
    if (email) email.focus();
  }

  function onboardingView() {
    const local = S.readLocal();
    const localCounts = local && !S.isEmpty(local) ? `${local.orders.length} orders, ${local.customers.length} customers, ${local.menu.length} meals` : null;
    return `
      <section class="card auth-card" style="max-width:560px">
        <h1>Welcome${ui.user ? `, ${esc(ui.user.email)}` : ""}</h1>
        <p class="muted">Your cloud database is connected but empty. How do you want to start?</p>
        <div class="grid" style="gap:10px">
          ${localCounts ? `<button class="btn" data-action="onboard" data-choice="local">Copy what's in this browser<span class="small" style="opacity:.8">(${localCounts})</span></button>` : ""}
          <button class="btn ${localCounts ? "btn-ghost" : ""}" data-action="onboard" data-choice="demo">Start with demo data</button>
          <button class="btn btn-ghost" data-action="onboard" data-choice="blank">Start blank (just settings)</button>
          <label class="btn btn-ghost" for="import-file" style="cursor:pointer">Import a backup file</label>
          <input type="file" id="import-file" accept="application/json,.json" hidden />
        </div>
      </section>`;
  }

  function setTab(tab) {
    if (!TABS.includes(tab) || !db) return;
    ui.tab = tab;
    ui.errors = {};
    ui.mealDraft = null;
    ui.customerDraft = null;
    ui.confirming = null;
    if (location.hash.slice(1) !== tab) history.replaceState(null, "", `#${tab}`);
    render();
    window.scrollTo({ top: 0 });
  }

  /** Swap in a whole new dataset (import / reset / erase / onboarding). */
  async function replaceAll(next, doneMsg) {
    db = next;
    ui.onboarding = false;
    ui.confirming = null;
    ui.orderDraft = newDraft();
    ui.weekOf = L.orderWindow(today(), db.settings).weekOf;
    render();
    const ok = await persist({ type: "replaceAll", db: next });
    if (ok && doneMsg) toast(doneMsg);
  }

  // ---------- Actions ----------
  const actions = {
    "week-prev": () => { ui.weekOf = L.addDays(ui.weekOf, -7); render(); },
    "week-next": () => { ui.weekOf = L.addDays(ui.weekOf, 7); render(); },
    "week-today": () => { ui.weekOf = L.orderWindow(today(), db.settings).weekOf; render(); },
    goto: (el) => setTab(el.dataset.to),
    invoice: (el) => openInvoice(el.dataset.id),
    "close-modal": closeModal,
    "print-invoice": () => {
      document.body.classList.add("printing-modal");
      window.print();
    },
    print: () => window.print(),
    "clear-draft": () => { ui.orderDraft = newDraft(); ui.errors = {}; render(); },

    "delete-order": (el) => {
      const idx = db.orders.findIndex((o) => o.id === el.dataset.id);
      if (idx < 0) return;
      const [removed] = db.orders.splice(idx, 1);
      render();
      persist({ type: "remove", kind: "orders", id: removed.id });
      toast("Order deleted.", () => {
        db.orders.splice(idx, 0, removed);
        render();
        persist({ type: "upsert", kind: "orders", row: removed });
      });
    },

    "edit-meal": (el) => { ui.editMealId = el.dataset.id; ui.mealDraft = null; ui.errors = {}; render(); $("#m-name").focus(); },
    "cancel-meal": () => { ui.editMealId = null; ui.mealDraft = null; ui.errors = {}; render(); },
    "remove-meal": (el) => {
      const meal = db.menu.find((m) => m.id === el.dataset.id);
      if (!meal) return;
      meal.active = false;
      if (ui.editMealId === meal.id) ui.editMealId = null;
      render();
      persist({ type: "upsert", kind: "meals", row: meal });
      toast(`${meal.name} removed from menu.`, () => {
        meal.active = true;
        render();
        persist({ type: "upsert", kind: "meals", row: meal });
      });
    },
    "restore-meal": (el) => {
      const meal = db.menu.find((m) => m.id === el.dataset.id);
      if (!meal) return;
      meal.active = true;
      render();
      persist({ type: "upsert", kind: "meals", row: meal });
    },

    "edit-customer": (el) => { ui.editCustomerId = el.dataset.id; ui.customerDraft = null; ui.errors = {}; render(); $("#c-name").focus(); },
    "order-for": (el) => {
      ui.orderDraft = { ...newDraft(), customerId: el.dataset.id };
      setTab("orders");
    },
    "cancel-customer": () => { ui.editCustomerId = null; ui.customerDraft = null; ui.errors = {}; render(); },
    "delete-customer": (el) => {
      const id = el.dataset.id;
      const n = db.orders.filter((o) => o.customerId === id).length;
      if (n) { toast(`Can't delete — this customer has ${n} order${n > 1 ? "s" : ""} on file.`); return; }
      const idx = db.customers.findIndex((c) => c.id === id);
      if (idx < 0) return;
      const [removed] = db.customers.splice(idx, 1);
      render();
      persist({ type: "remove", kind: "customers", id: removed.id });
      toast(`${removed.name} deleted.`, () => {
        db.customers.splice(idx, 0, removed);
        render();
        persist({ type: "upsert", kind: "customers", row: removed });
      });
    },

    export: () => {
      const { settingsSaved, ...plain } = db;
      const blob = new Blob([JSON.stringify(plain, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `fuel-by-buzah-backup-${today()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    "reset-demo": () => {
      if (ui.confirming !== "reset-demo") { ui.confirming = "reset-demo"; render(); return; }
      replaceAll(seed(), "Demo data restored.");
    },
    "clear-all": () => {
      if (ui.confirming !== "clear-all") { ui.confirming = "clear-all"; render(); return; }
      replaceAll({ version: 1, settings: db.settings, menu: [], customers: [], orders: [] }, "All menu, customer and order data erased.");
    },
    undo: () => {
      const fn = ui.undo;
      ui.undo = null;
      $("#toast").classList.remove("show");
      if (fn) fn();
    },

    // --- Cloud / account ---
    onboard: (el) => {
      const choice = el.dataset.choice;
      if (choice === "local") replaceAll(S.readLocal(), "Copied your browser data to the cloud.");
      else if (choice === "demo") replaceAll(seed(), "Demo data loaded — replace it with your real menu anytime.");
      else {
        const blank = { version: 1, settings: db.settings, menu: [], customers: [], orders: [] };
        db = blank;
        ui.onboarding = false;
        render();
        persist({ type: "settings", settings: blank.settings }).then((ok) => ok && toast("You're all set. Start by adding meals to your menu."));
        setTab("menu");
      }
    },
    "use-demo": () => { setPref("demo"); boot(); },
    "use-cloud": () => { setPref(null); boot(); },
    "sign-out": async () => {
      await store.signOut();
      ui.checked.clear();
      showLogin();
    },
    "sync-pill": () => setTab("settings"),
  };

  // ---------- Form submits ----------
  const forms = {
    order(form) {
      readOrderForm(form);
      const { menuById, customersById, s } = ctx();
      let win;
      try { win = L.orderWindow(ui.orderDraft.createdOn, s); } catch (_) { ui.errors.order = ["Enter a valid order date."]; return render(); }
      const order = draftToOrder(win);
      const errs = L.validateOrder(order, menuById, customersById);
      if (errs.length) { ui.errors.order = errs; return render(); }
      db.orders.push(order);
      ui.errors = {};
      ui.orderDraft = { ...newDraft(), createdOn: ui.orderDraft.createdOn };
      if (order.weekOf !== ui.weekOf) {
        ui.weekOf = order.weekOf;
        toast(`Saved to the week of ${shortDate(order.weekOf)}.`);
      } else toast("Order saved.");
      render();
      persist({ type: "upsert", kind: "orders", row: order });
    },

    meal(form) {
      const fd = new FormData(form);
      const lines = String(fd.get("ingredients") || "").split("\n").map((l) => l.trim()).filter(Boolean);
      const parsed = lines.map((l) => ({ line: l, ing: L.parseIngredientLine(l) }));
      const bad = parsed.filter((p) => !p.ing).map((p) => `Couldn't read ingredient "${p.line}" — start it with an amount, e.g. "1 cup rice".`);
      const meal = {
        name: String(fd.get("name") || "").trim(),
        price: L.round2(num(fd.get("price"))),
        macros: { cal: num(fd.get("cal")), protein: num(fd.get("protein")), carbs: num(fd.get("carbs")), fat: num(fd.get("fat")) },
        ingredients: parsed.filter((p) => p.ing).map((p) => p.ing),
      };
      const errs = [...L.validateMeal(meal), ...bad];
      if (errs.length) {
        ui.errors.meal = errs;
        ui.mealDraft = { name: fd.get("name"), price: fd.get("price"), macros: { cal: fd.get("cal"), protein: fd.get("protein"), carbs: fd.get("carbs"), fat: fd.get("fat") }, ingText: fd.get("ingredients") };
        return render();
      }
      let saved = ui.editMealId ? db.menu.find((m) => m.id === ui.editMealId) : null;
      if (saved) {
        Object.assign(saved, meal);
        toast(`${meal.name} updated.`);
      } else {
        saved = { id: L.uid("meal"), active: true, ...meal };
        db.menu.push(saved);
        toast(`${meal.name} added to the menu.`);
      }
      ui.editMealId = null; ui.mealDraft = null; ui.errors = {};
      render();
      persist({ type: "upsert", kind: "meals", row: saved });
    },

    customer(form) {
      const fd = new FormData(form);
      const targets = {};
      for (const k of L.MACRO_KEYS) {
        const v = num(fd.get(k));
        targets[k] = v > 0 ? v : 0;
      }
      const cust = { name: String(fd.get("name") || "").trim(), phone: String(fd.get("phone") || "").trim(), address: String(fd.get("address") || "").trim(), targets };
      if (!cust.name) { ui.errors.customer = ["Customer needs a name."]; ui.customerDraft = cust; return render(); }
      let saved = ui.editCustomerId ? db.customers.find((c) => c.id === ui.editCustomerId) : null;
      if (saved) {
        Object.assign(saved, cust);
        toast(`${cust.name} updated.`);
      } else {
        saved = { id: L.uid("cust"), ...cust };
        db.customers.push(saved);
        toast(`${cust.name} added.`);
      }
      ui.editCustomerId = null; ui.customerDraft = null; ui.errors = {};
      render();
      persist({ type: "upsert", kind: "customers", row: saved });
    },

    settings(form) {
      const fd = new FormData(form);
      const nonNeg = (k, fallback) => { const v = num(fd.get(k)); return v >= 0 ? v : fallback; };
      db.settings = {
        ...db.settings,
        businessName: String(fd.get("businessName") || "").trim() || "Fuel by Buzah",
        tagline: String(fd.get("tagline") || "").trim(),
        deliveryFee: nonNeg("deliveryFee", 0),
        pickupDiscountPct: Math.min(nonNeg("pickupDiscountPct", 0), 100),
        taxRatePct: nonNeg("taxRatePct", 0),
        lateOrders: fd.get("lateOrders") === "block" ? "block" : "fee",
        lateFee: nonNeg("lateFee", 0),
        macroDays: Math.min(Math.max(Math.round(nonNeg("macroDays", 5)) || 5, 1), 7),
      };
      render();
      persist({ type: "settings", settings: db.settings }).then((ok) => ok && toast("Settings saved."));
    },

    async login(form) {
      const fd = new FormData(form);
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Signing in…";
      try {
        const user = await store.signIn(String(fd.get("email") || "").trim(), String(fd.get("password") || ""));
        await startCloud(user);
      } catch (err) {
        showLogin(/invalid/i.test(err.message) ? "Wrong email or password." : err.message);
      }
    },
  };

  // ---------- Event wiring ----------
  document.addEventListener("click", (e) => {
    const tabBtn = e.target.closest("[data-tab]");
    if (tabBtn) return setTab(tabBtn.dataset.tab);
    const el = e.target.closest("[data-action]");
    if (!el || !actions[el.dataset.action]) return;
    if (el.tagName === "A") e.preventDefault();
    actions[el.dataset.action](el);
  });

  document.addEventListener("submit", (e) => {
    const form = e.target.closest("form[data-form]");
    if (!form) return;
    e.preventDefault();
    forms[form.dataset.form](form);
  });

  document.addEventListener("input", (e) => {
    const form = e.target.closest("#order-form");
    if (!form) return;
    readOrderForm(form);
    $("#order-preview").innerHTML = orderPreview();
  });

  document.addEventListener("change", (e) => {
    if (e.target.matches("[data-check]")) {
      const k = e.target.dataset.check;
      if (e.target.checked) ui.checked.add(k); else ui.checked.delete(k);
      e.target.closest("tr").classList.toggle("checked", e.target.checked);
    }
    if (e.target.id === "import-file" && e.target.files[0]) {
      const reader = new FileReader();
      reader.onload = () => {
        let data;
        try {
          data = JSON.parse(reader.result);
          if (!isValidDb(data)) throw new Error("bad shape");
        } catch (_) {
          toast("That file isn't a Fuel by Buzah backup.");
          return;
        }
        delete data.settingsSaved;
        replaceAll(data, "Backup imported.");
      };
      reader.readAsText(e.target.files[0]);
      e.target.value = "";
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#modal").hidden) closeModal();
  });

  window.addEventListener("afterprint", () => document.body.classList.remove("printing-modal"));
  window.addEventListener("hashchange", () => setTab(location.hash.slice(1)));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });

  // ---------- Boot ----------
  async function startCloud(user) {
    ui.user = user;
    $("#app").innerHTML = `<div class="empty">Loading your data…</div>`;
    try {
      db = await store.loadAll();
    } catch (err) {
      showLogin(`Couldn't load your data: ${err.message}`);
      return;
    }
    ui.weekOf = L.orderWindow(today(), db.settings).weekOf;
    ui.onboarding = S.isEmpty(db) && !db.settingsSaved;
    ui.sync = "saved";
    store.subscribe(onRemoteChange);
    render();
  }

  async function boot() {
    const cfg = window.FUEL_CONFIG || {};
    const lib = window.supabase;
    ui.cloudAvailable = !!(cfg.supabaseUrl && cfg.supabaseKey);
    const cloudReady = ui.cloudAvailable && lib && typeof lib.createClient === "function";

    if (cloudReady && getPref() !== "demo") {
      store = S.createCloudStore(cfg, lib, seed().settings);
      store.onAuthChange((event) => {
        if (event === "SIGNED_OUT" && ui.user) showLogin("You've been signed out.");
      });
      const user = await store.getUser().catch(() => null);
      if (user) await startCloud(user);
      else showLogin();
      return;
    }

    store = S.createLocalStore(seed);
    try {
      db = await store.loadAll();
    } catch (_) {
      db = seed(); // storage blocked (private window) — still usable, just not saved
    }
    ui.user = null;
    ui.onboarding = false;
    ui.weekOf = L.orderWindow(today(), db.settings).weekOf;
    render();
    if (ui.cloudAvailable && !cloudReady) toast("Couldn't reach the cloud — using this browser's data for now.");
  }

  boot();
})();
