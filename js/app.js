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
    calMonth: null, // month shown in the week picker
    route: null, // planned delivery route for a week (see planDeliveryRoute)
    routeBusy: false,
    routeStatus: "",
    routeStartText: "",
    recalls: null, // { alerts, lastRun, loadedAt } from the nightly recall check (cloud mode)
    recallsLoading: false,
    recallsError: "",
    recallCheck: null, // { status, message } while "Check now" runs
    recallShowHidden: false,
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
    const knownPending = new Set((db ? db.orders : []).filter((o) => o.status === "pending").map((o) => o.id));
    const before = signature(db);
    try {
      db = await store.loadAll();
      if (signature(db) === before) { setSync("saved"); return; } // just the echo of our own save
      const fresh = db.orders.filter((o) => o.status === "pending" && !knownPending.has(o.id));
      if (fresh.length) {
        const who = (fresh[0].contact && fresh[0].contact.name) || "a customer";
        toast(fresh.length === 1 ? `New online order from ${who}!` : `${fresh.length} new online orders!`);
      }
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

  /** Order-independent fingerprint of the data, to tell real changes from echoes of our own saves. */
  function signature(d) {
    if (!d) return "";
    const byId = (list) => [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return JSON.stringify([d.settings, byId(d.menu), byId(d.customers), byId(d.orders)]);
  }

  let remoteTimer;
  function onRemoteChange() {
    clearTimeout(remoteTimer);
    // Wait until our own in-flight saves settle, then reload. Never drop an
    // event: a customer's order can land a split second after we save.
    const wait = Math.max(500, 1500 - (Date.now() - lastWriteAt));
    remoteTimer = setTimeout(() => {
      if (pendingWrites > 0) return onRemoteChange();
      refresh();
    }, wait);
  }

  function newDraft() {
    return { customerId: "", createdOn: today(), qty: {}, fulfillment: "delivery", notes: "", paymentMethod: "" };
  }

  /** Only confirmed orders count toward prep, deliveries and revenue. */
  const isConfirmed = (o) => !o.status || o.status === "confirmed";
  const PAYMENT_LABELS = { cash: "Cash", cashapp: "Cash App", zelle: "Zelle" };

  function ctx() {
    const menuById = L.indexById(db.menu);
    const customersById = L.indexById(db.customers);
    const weekOrders = db.orders.filter((o) => o.weekOf === ui.weekOf && isConfirmed(o)).sort((a, b) => a.createdOn.localeCompare(b.createdOn));
    const pendingOrders = db.orders.filter((o) => o.status === "pending").sort((a, b) => a.createdOn.localeCompare(b.createdOn));
    return { menuById, customersById, weekOrders, pendingOrders, s: db.settings };
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

  // ---------- v6 helpers: photos, allergens, delivery area, weekly plans ----------
  const allergenText = (keys) => (keys || []).map((k) => L.ALLERGEN_LABELS[k] || k).join(", ");
  const safePhoto = (url) => (/^(https:\/\/|data:image\/(jpeg|webp|png);base64,)/.test(String(url || "")) ? url : "");

  /** Shrink a photo in the browser before saving: max side in px, JPEG quality 0–1. */
  async function resizeImage(file, maxSide, quality) {
    if (!file || !/^image\//.test(file.type)) throw new Error("Choose an image file (JPG, PNG or WebP).");
    if (file.size > 15 * 1024 * 1024) throw new Error("That photo is over 15 MB. Choose a smaller one.");
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("Couldn't read that image."));
        i.src = url;
      });
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
      return { blob, dataUrl: canvas.toDataURL("image/jpeg", quality) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Miles from the kitchen for a delivery address, if we know both spots on the map. */
  const distances = new Map(); // normalized address → miles | null (not found)
  let distanceBusy = false;
  function milesFor(address) {
    const s = db.settings;
    if (!s.kitchenGeo || !address) return undefined;
    const key = FuelRoute.normalizeAddress(address);
    if (distances.has(key)) return distances.get(key);
    const c = db.customers.find((x) => x.geo && x.geo.q === key);
    const cached = readJSON(GEO_CACHE_KEY, {})[key];
    const geo = (c && c.geo) || cached;
    if (geo) {
      const mi = FuelRoute.haversineMeters(s.kitchenGeo, geo) / 1609.344;
      distances.set(key, mi);
      return mi;
    }
    return undefined;
  }
  /** Look up any pending delivery addresses we haven't placed on the map yet (politely, 1/sec). */
  async function fillDistances() {
    if (distanceBusy || !db || !db.settings.kitchenGeo) return;
    const todo = [...new Set(db.orders.filter((o) => o.status === "pending" && o.fulfillment === "delivery")
      .map((o) => (o.contact && o.contact.address) || (db.customers.find((c) => c.id === o.customerId) || {}).address || "")
      .filter((a) => a && milesFor(a) === undefined))];
    if (!todo.length) return;
    distanceBusy = true;
    const cache = readJSON(GEO_CACHE_KEY, {});
    for (const addr of todo.slice(0, 10)) {
      const key = FuelRoute.normalizeAddress(addr);
      try {
        const g = await geocodeThrottled(addr);
        if (g) { cache[key] = { q: key, lat: g.lat, lng: g.lng }; writeJSON(GEO_CACHE_KEY, cache); }
        else distances.set(key, null);
      } catch (_) { distances.set(key, null); }
    }
    distanceBusy = false;
    if (ui.tab === "orders") render();
  }
  function distanceBadge(address) {
    const s = db.settings;
    if (!s.kitchenGeo || !address) return "";
    const mi = milesFor(address);
    if (mi === undefined) return `<span class="badge">Checking distance…</span>`;
    if (mi === null) return `<span class="badge late" title="This address couldn't be found on the map">Address not on map</span>`;
    const radius = Number(s.deliveryRadiusMiles) || 0;
    const out = radius > 0 && mi > radius;
    return `<span class="badge ${out ? "out-area" : "in-area"}" title="Straight-line distance from your kitchen">${out ? "Outside area · " : ""}${mi.toFixed(1)} mi</span>`;
  }

  // Weekly plans: what's next for a plan (same rule as the database).
  function planNext(plan) {
    const p = FuelShopTools.zonedParts(Date.now());
    const todayStr = FuelShopTools.todayInZone();
    return L.planNextWeek(plan, todayStr, p.h < 6);
  }
  const planItemsText = (plan) => {
    const byId = L.indexById(db.menu);
    return (plan.items || []).map((it) => {
      const m = byId.get(it.mealId);
      return `${it.qty}× ${m ? m.name : "Removed meal"}${m && m.active === false ? " (off menu)" : ""}`;
    }).join(", ");
  };

  function plansCard() {
    const plans = (db.plans || []).filter((p) => ui.showCancelledPlans || p.status !== "cancelled");
    const active = (db.plans || []).filter((p) => p.status === "active").length;
    const cancelled = (db.plans || []).filter((p) => p.status === "cancelled").length;
    const byId = new Map(db.customers.map((c) => [c.id, c]));
    if (!(db.plans || []).length) {
      return `<section class="card plans-card" style="margin-bottom:16px"><div class="card-head"><h2>Weekly meal plans</h2><span class="badge">0 active</span></div>
        <p class="muted small" style="margin:0">When a customer ticks <strong>Repeat every week</strong> at checkout, their plan shows up here. Each Monday at 6 AM, that week's order is created as <em>pending</em> for you to confirm.</p></section>`;
    }
    return `
      <section class="card plans-card" style="margin-bottom:16px">
        <div class="card-head"><h2>Weekly meal plans</h2><span class="badge pickup">${active} active</span></div>
        <p class="muted small" style="margin-top:-4px">Each Monday at 6 AM, active plans create that week's order as pending in your Orders inbox. Customers can pause, skip a week or cancel from their order page.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Customer</th><th>Meals</th><th>Type</th><th>Status</th><th>Next order</th><th></th></tr></thead>
          <tbody>${plans.map((p) => {
            const c = byId.get(p.customerId);
            const next = planNext(p);
            const skips = (p.skipWeeks || []).filter((w) => w >= L.weekStart(today()));
            return `<tr>
              <td><strong>${esc((c && c.name) || (p.contact && p.contact.name) || "Unknown")}</strong><div class="muted small">${esc((c && c.phone) || (p.contact && p.contact.phone) || "")}</div></td>
              <td class="small">${esc(planItemsText(p))}</td>
              <td>${p.fulfillment === "pickup" ? '<span class="badge pickup">Pickup</span>' : '<span class="badge delivery">Delivery</span>'} <span class="small muted">${esc(PAYMENT_LABELS[p.paymentMethod] || "")}</span></td>
              <td><span class="badge plan-${p.status}">${p.status === "active" ? "Active" : p.status === "paused" ? "Paused" : "Cancelled"}</span></td>
              <td class="small">${next ? `Week of ${shortDate(next)}` : "—"}${skips.length ? `<div class="muted">Skipping ${skips.map(shortDate).join(", ")}</div>` : ""}</td>
              <td class="actions">${p.status === "cancelled" ? "" : `
                ${p.status === "active" ? `<button class="btn btn-ghost btn-sm" data-action="plan-pause" data-id="${p.id}">Pause</button>` : `<button class="btn btn-ghost btn-sm" data-action="plan-resume" data-id="${p.id}">Resume</button>`}
                <button class="btn btn-danger btn-sm" data-action="plan-cancel" data-id="${p.id}">${ui.confirming === "plan-cancel:" + p.id ? "Click again to cancel" : "Cancel"}</button>`}</td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>
        ${cancelled ? `<button class="btn btn-ghost btn-sm" data-action="plans-toggle-cancelled" style="margin-top:8px">${ui.showCancelledPlans ? "Hide" : "Show"} ${cancelled} cancelled</button>` : ""}
      </section>`;
  }

  /** Settings: kitchen address + delivery radius (stays in your account; customers never see it). */
  function deliveryAreaCard() {
    const s = db.settings;
    return `
      <section class="card">
        <div class="card-head"><h2>Delivery area</h2>${s.kitchenGeo && s.deliveryRadiusMiles ? `<span class="badge pickup">${esc(s.deliveryRadiusMiles)} mi</span>` : ""}</div>
        <p class="muted small">New delivery orders show their distance from your kitchen, and orders outside your radius are flagged in the inbox so you can decide. Your kitchen address stays in your account. Customers never see it.</p>
        <form data-form="delivery-area" novalidate>
          ${errorBox("delivery-area")}
          <div class="field"><label for="da-address">Kitchen address</label><input type="text" id="da-address" name="kitchenAddress" value="${esc(s.kitchenAddress || "")}" autocomplete="street-address" placeholder="Street, city, ZIP" /></div>
          <div class="field"><label for="da-radius">Delivery radius (miles)</label><input type="number" id="da-radius" name="radius" min="1" max="100" step="0.5" inputmode="decimal" value="${esc(s.deliveryRadiusMiles || "")}" placeholder="e.g. 15" /></div>
          ${s.kitchenGeo ? `<p class="small muted" style="margin-top:-4px">✓ Found on the map.</p>` : ""}
          <button class="btn" type="submit">${ui.areaBusy ? "Finding address…" : "Save delivery area"}</button>
        </form>
      </section>`;
  }

  /** Settings: allow customers to start weekly plans. */
  function plansSettingsCard() {
    const on = db.settings.plansEnabled !== false;
    return `
      <section class="card">
        <div class="card-head"><h2>Weekly meal plans</h2>${on ? '<span class="badge pickup">On</span>' : '<span class="badge">Off</span>'}</div>
        <p class="muted small">Customers can tick <strong>Repeat every week</strong> at checkout. Every Monday at 6 AM, their order for that week is created as pending, so you still approve each one. Meals that are off the menu or sold out are left out. Manage plans under <a href="#customers" data-action="goto" data-to="customers">Customers</a>.</p>
        <button class="btn ${on ? "btn-ghost" : ""}" type="button" data-action="plans-toggle">${on ? "Stop offering weekly plans" : "Offer weekly plans"}</button>
      </section>`;
  }

  function pendingCount() {
    return db ? db.orders.filter((o) => o.status === "pending").length : 0;
  }

  const normAddr = (a) => String(a || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  /** "New online orders" inbox shown above the Orders tab. */
  function pendingInbox() {
    const { menuById, customersById, pendingOrders, s } = ctx();
    if (!pendingOrders.length) return "";
    return `
      <section class="card inbox" style="margin-bottom:16px">
        <div class="card-head"><h2>New orders to review</h2><span class="badge late">${pendingOrders.length} waiting</span></div>
        <p class="muted small" style="margin-top:-4px">Confirm to add an order to prep and deliveries. Remember to text the customer to let them know.</p>
        <div class="grid grid-cards">
        ${pendingOrders.map((o) => {
          const t = L.orderTotals(o, menuById, s);
          const c = customersById.get(o.customerId);
          const ct = o.contact || {};
          const name = ct.name || (c && c.name) || "Unknown";
          const phone = ct.phone || (c && c.phone) || "";
          const addr = o.fulfillment === "delivery" ? ct.address || (c && c.address) || "" : "";
          const addrDiffers = o.fulfillment === "delivery" && c && c.address && ct.address && normAddr(c.address) !== normAddr(ct.address);
          const priceChanged = o.quotedTotal != null && Math.abs(o.quotedTotal - t.total) > 0.009;
          return `
          <article class="inbox-card">
            <div class="card-head">
              <div><h3>${esc(name)}</h3><div class="muted small">${esc(phone)} · placed ${shortDate(o.createdOn)}</div></div>
              <div class="price num">${money(t.total)}</div>
            </div>
            <ul class="inbox-items">${t.lines.map((l) => `<li><strong>${l.qty}×</strong> ${esc(l.name)}</li>`).join("")}</ul>
            <div class="small" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">${o.source === "plan" ? '<span class="badge plan-active">Weekly plan</span> ' : o.planId ? '<span class="badge plan-active">Starts a weekly plan</span> ' : ""}${fulfillmentBadges(o)} <span class="badge">${esc(PAYMENT_LABELS[o.paymentMethod] || "No payment method")}</span> <span class="badge">for ${longDate(L.weekSchedule(o.weekOf).deliveryDay)}</span>${addr ? " " + distanceBadge(addr) : ""}</div>
            ${addr ? `<div class="small"><span class="muted">Deliver to:</span> ${esc(addr)}</div>` : ""}
            ${addrDiffers ? `<div class="small warn-text">Different from the address on file (${esc(c.address)}).</div>` : ""}
            ${o.notes ? `<div class="small"><span class="muted">Notes:</span> ${esc(o.notes)}</div>` : ""}
            ${priceChanged ? `<div class="small warn-text">They were quoted ${money(o.quotedTotal)}. Your prices changed since then.</div>` : ""}
            <div class="btn-row" style="margin-top:10px">
              <button class="btn btn-sm" data-action="confirm-order" data-id="${o.id}">Confirm</button>
              <button class="btn btn-ghost btn-sm" data-action="decline-order" data-id="${o.id}">Decline</button>
              <button class="btn btn-ghost btn-sm" data-action="invoice" data-id="${o.id}">Details</button>
            </div>
          </article>`;
        }).join("")}
        </div>
      </section>`;
  }

  /** Settings card: public ordering link, open/closed, payment handles. */
  function onlineOrderingCard() {
    const s = db.settings;
    if (!store || store.mode !== "cloud") {
      return `
        <section class="card">
          <div class="card-head"><h2>Online ordering</h2></div>
          <p class="muted">Customers can order from a public link, and orders land here for you to confirm. This needs your cloud database, so sign in to set it up.</p>
          <a class="btn btn-ghost" href="order.html?demo" target="_blank" rel="noopener">Preview the customer page (demo)</a>
        </section>`;
    }
    const link = ui.shopSlug ? new URL(`order.html?shop=${encodeURIComponent(ui.shopSlug)}`, location.href).href : "";
    return `
      <section class="card">
        <div class="card-head"><h2>Online ordering</h2>${s.orderingOpen === false ? '<span class="badge late">Closed</span>' : ui.shopSlug ? '<span class="badge pickup">Live</span>' : ""}</div>
        <form data-form="ordering" novalidate>
          ${errorBox("ordering")}
          <div class="field">
            <label for="sh-slug">Your link name</label>
            <input type="text" id="sh-slug" name="slug" value="${esc(ui.shopSlug || "")}" placeholder="fuel-by-buzah" autocomplete="off" />
            <span class="small muted">Lowercase letters, numbers and dashes.</span>
          </div>
          ${link ? `
          <div class="field">
            <span class="label-text">Share this link with customers</span>
            <div class="link-box"><input type="text" readonly value="${esc(link)}" id="shop-link" aria-label="Ordering link" />
              <button class="btn btn-ghost btn-sm" type="button" data-action="copy-link">Copy</button>
              <a class="btn btn-ghost btn-sm" href="${esc(link)}" target="_blank" rel="noopener">Open</a></div>
          </div>` : ""}
          <label class="check"><input type="checkbox" name="orderingOpen" ${s.orderingOpen !== false ? "checked" : ""}/> Accepting online orders</label>
          <div class="row" style="margin-top:12px">
            <div class="field"><label for="sh-cashapp">Cash App $cashtag</label><input type="text" id="sh-cashapp" name="cashApp" value="${esc(s.cashApp || "")}" placeholder="$YourCashtag" /></div>
            <div class="field"><label for="sh-zelle">Zelle phone or email</label><input type="text" id="sh-zelle" name="zelle" value="${esc(s.zelle || "")}" /></div>
          </div>
          <label class="check"><input type="checkbox" name="acceptCash" ${s.acceptCash !== false ? "checked" : ""}/> Accept cash at pickup/delivery</label>
          <div class="btn-row" style="margin-top:12px"><button class="btn" type="submit">Save online ordering</button></div>
        </form>
      </section>`;
  }

  /** Long random ntfy topic. It works like a password, so it must not be guessable. */
  function newAlertTopic() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    return "fbb-" + Array.from(bytes, (b) => chars[b % chars.length]).join("");
  }

  /** The manager's own address, so tapping an alert opens it. Only https is accepted by the database. */
  const managerUrl = () => (location.protocol === "https:" ? location.href.split("#")[0] : "");

  /** Settings card: push alerts to the owner's phone via the free ntfy app. */
  function alertsCard() {
    if (!store || store.mode !== "cloud") return "";
    const s = db.settings;
    const on = !!(s.alertsEnabled && s.ntfyTopic);
    return `
      <section class="card">
        <div class="card-head"><h2>Phone alerts</h2>${on ? '<span class="badge pickup">On</span>' : ""}</div>
        ${on ? `
          <ol class="steps">
            <li>Install the free <strong>ntfy</strong> app:
              <a href="https://apps.apple.com/us/app/ntfy/id1625396347" target="_blank" rel="noopener">iPhone</a> ·
              <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">Android</a></li>
            <li>In the app, tap <strong>+</strong>, paste this topic and tap <strong>Subscribe</strong>. Keep it private, because anyone who has it can see your alerts.
              <div class="link-box" style="margin-top:6px"><input type="text" readonly value="${esc(s.ntfyTopic)}" id="alert-topic" aria-label="Alert topic" />
                <button class="btn btn-ghost btn-sm" type="button" data-action="copy-topic">Copy</button></div></li>
            <li>Allow notifications when the app asks, then
              <button class="btn btn-sm" type="button" data-action="test-alert">Send test alert</button></li>
          </ol>
          <div class="btn-row" style="margin-top:12px">
            <button class="btn btn-ghost btn-sm" type="button" data-action="alerts-off">Turn off alerts</button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="alerts-new-topic">${ui.confirming === "alerts-new-topic" ? "Click again: your phone must re-subscribe" : "Get a new topic"}</button>
          </div>
          <p class="small muted" style="margin:12px 0 0">Alerts show the customer's first name, meal count, total and day. They pass through ntfy.sh and are deleted after 12 hours.</p>`
        : `
          <p class="muted">Get a notification on your phone the moment a customer places an online order. It's free and uses the ntfy app, with no account needed.</p>
          <button class="btn" type="button" data-action="alerts-on">Turn on alerts</button>`}
      </section>`;
  }

  /**
   * Copy an input's text. The async Clipboard API can hang if a permission
   * prompt is never answered, so fall back to the classic select-and-copy.
   */
  function copyFrom(selector, message) {
    const input = $(selector);
    if (!input) return;
    const fallback = () => {
      input.focus();
      input.select();
      let copied = false;
      try { copied = document.execCommand("copy"); } catch (_) { /* ignore */ }
      toast(copied ? message : "Selected. Press Ctrl+C (or Cmd+C) to copy.");
    };
    if (!navigator.clipboard || !window.isSecureContext) return fallback();
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; fallback(); } }, 800);
    navigator.clipboard.writeText(input.value).then(
      () => { if (!settled) { settled = true; clearTimeout(timer); toast(message); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); fallback(); } }
    );
  }

  // ---------- Week picker (calendar dropdown) ----------

  function weekCounts() {
    const m = {};
    for (const o of db.orders) {
      const k = o.weekOf;
      m[k] = m[k] || { confirmed: 0, pending: 0 };
      if (isConfirmed(o)) m[k].confirmed++;
      else if (o.status === "pending") m[k].pending++;
    }
    return m;
  }

  const monthStart = (iso) => iso.slice(0, 8) + "01";
  function shiftMonth(iso, n) {
    const d = L.parseDate(iso);
    return L.toISODate(new Date(d.getFullYear(), d.getMonth() + n, 1));
  }

  function renderWeekPicker() {
    const pop = $("#week-pop");
    if (!pop || !db) return;
    const first = L.parseDate(ui.calMonth);
    const lastIso = L.toISODate(new Date(first.getFullYear(), first.getMonth() + 1, 0));
    const counts = weekCounts();
    const td = today();
    const thisWeek = L.weekStart(td);
    const rows = [];
    for (let ws = L.weekStart(ui.calMonth); ws <= lastIso; ws = L.addDays(ws, 7)) {
      const c = counts[ws] || { confirmed: 0, pending: 0 };
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = L.addDays(ws, i);
        const cls = ["cal-day", d.slice(0, 7) !== ui.calMonth.slice(0, 7) ? "out" : "", d === td ? "today" : "", i === 6 ? "sun" : ""].join(" ");
        return `<span class="${cls}">${Number(d.slice(8))}</span>`;
      }).join("");
      const label = `Week of ${longDate(ws)}, delivers ${longDate(L.addDays(ws, 6))}: ${c.confirmed} order${c.confirmed === 1 ? "" : "s"}${c.pending ? `, ${c.pending} new online` : ""}`;
      rows.push(`<button type="button" class="cal-week ${ws === ui.weekOf ? "selected" : ""} ${ws === thisWeek ? "this-week" : ""}" data-action="cal-pick" data-week="${ws}" aria-label="${esc(label)}" aria-pressed="${ws === ui.weekOf}">
        ${days}<span class="cal-count">${c.confirmed ? `<span class="n">${c.confirmed}</span>` : ""}${c.pending ? `<span class="p" title="New online orders">${c.pending}</span>` : ""}</span></button>`);
    }
    pop.innerHTML = `
      <div class="cal-head">
        <button type="button" class="icon-btn" data-action="cal-prev" aria-label="Previous month">‹</button>
        <span>${first.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
        <button type="button" class="icon-btn" data-action="cal-next" aria-label="Next month">›</button>
      </div>
      <div class="cal-grid">
        <div class="cal-dows">${["M", "T", "W", "T", "F", "S", "S"].map((d) => `<span>${d}</span>`).join("")}<span>Orders</span></div>
        ${rows.join("")}
      </div>
      <div class="cal-foot">
        <span><span class="cal-count"><span class="n">#</span></span> orders · <span class="cal-count"><span class="p">#</span></span> new online</span>
        <button type="button" class="btn btn-ghost btn-sm" data-action="cal-this">This week</button>
      </div>`;
  }

  function openWeekPicker() {
    ui.calMonth = monthStart(L.addDays(ui.weekOf, 3)); // month containing most of the week
    renderWeekPicker();
    $("#week-pop").hidden = false;
    $("#week-btn").setAttribute("aria-expanded", "true");
    const sel = $("#week-pop .cal-week.selected") || $("#week-pop .cal-week");
    if (sel) sel.focus();
  }

  function closeWeekPicker(returnFocus) {
    const pop = $("#week-pop");
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    $("#week-btn").setAttribute("aria-expanded", "false");
    if (returnFocus) $("#week-btn").focus();
  }

  // ---------- Route planning ----------

  const GEO_CACHE_KEY = "fuel-by-buzah:geo";
  const ROUTE_KEY = "fuel-by-buzah:route";
  const isTouch = () => !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch (_) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ }
  }

  /** Unique delivery addresses for the week (two orders to one address = one stop). */
  function deliveryStops(rows) {
    const map = new Map();
    for (const r of rows) {
      if (!r.address) continue;
      const key = FuelRoute.normalizeAddress(r.address);
      const stop = map.get(key) || { key, address: r.address, names: [], customerIds: [] };
      stop.names.push(r.customer);
      if (r.customerId) stop.customerIds.push(r.customerId);
      map.set(key, stop);
    }
    return [...map.values()];
  }

  const stopsSignature = (stops) => stops.map((s) => s.key).sort().join("|");

  /** The saved route for this week, if the set of addresses hasn't changed since. */
  function currentRoute(stops) {
    const r = ui.route;
    return r && r.weekOf === ui.weekOf && r.signature === stopsSignature(stops) ? r : null;
  }

  function routeCard(stops, route, stale) {
    const miles = route ? FuelRoute.metersToMiles(route.distance) : 0;
    const mins = route ? Math.round(route.duration / 60) : 0;
    const orderedAddrs = route ? route.order.map((k) => (stops.find((s) => s.key === k) || {}).address).filter(Boolean) : [];
    const legs = route ? FuelRoute.googleMapsLegs(orderedAddrs, isTouch() ? 3 : 9) : [];
    return `
      <section class="card route-card" style="margin-bottom:16px">
        <div class="card-head"><h2>Plan the route</h2>${route ? `<span class="badge pickup">${route.order.length} stops</span>` : ""}</div>
        <form class="route-controls no-print" data-form="route" novalidate>
          <div class="field" style="margin:0;flex:1;min-width:220px">
            <label for="rt-start">Starting from</label>
            <input type="text" id="rt-start" name="start" value="${esc(ui.routeStartText || "")}" placeholder="Leave blank to use your current location" autocomplete="street-address" />
          </div>
          <button class="btn" type="submit" id="route-plan-btn" ${ui.routeBusy ? "disabled" : ""}>${ui.routeBusy ? "Planning…" : route ? "Re-plan route" : "Plan best route"}</button>
        </form>
        <div id="route-status" class="small muted" role="status" style="margin-top:8px">${esc(ui.routeBusy ? ui.routeStatus : stale ? "Deliveries changed since you planned. Plan again to update the route." : ui.routeStatus || "")}</div>
        ${route ? `
          <div class="route-summary">
            <div><span class="label">Drive</span><strong>${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`}</strong></div>
            <div><span class="label">Distance</span><strong>${miles.toFixed(1)} mi</strong></div>
            <div><span class="label">Stops</span><strong>${route.order.length}</strong></div>
            <div><span class="label">From</span><strong>${esc(route.startLabel)}</strong></div>
          </div>
          ${route.estimated ? `<div class="small warn-text">The routing server was busy, so times are estimated from straight-line distance. The stop order is still a good one.</div>` : ""}
          ${route.failed && route.failed.length ? `<div class="small warn-text">Couldn't find ${route.failed.length === 1 ? "this address" : "these addresses"} on the map: ${route.failed.map(esc).join("; ")}. Check the spelling in Customers.</div>` : ""}
          <div id="route-map" class="route-map" aria-label="Map of the delivery route"></div>
          <div class="no-print" style="margin-top:12px">
            <span class="label-text">Navigate in Google Maps</span>
            <div class="btn-row" style="margin-top:6px">${legs.map((l, i) => `<a class="btn ${i === 0 ? "" : "btn-ghost"} btn-sm" href="${esc(l.url)}" target="_blank" rel="noopener">${legs.length === 1 ? "Start navigation" : `Stops ${l.from}–${l.to}`}</a>`).join("")}</div>
            ${legs.length > 1 ? `<p class="small muted" style="margin:6px 0 0">Google Maps allows ${isTouch() ? "a few" : "about 10"} stops per trip, so the route is split into legs. Open the next one when you finish a leg.</p>` : ""}
          </div>
          <p class="small muted" style="margin:10px 0 0">Map © OpenStreetMap contributors · Routing by OSRM</p>` : ""}
      </section>`;
  }

  function setRouteStatus(msg) {
    ui.routeStatus = msg;
    const el = $("#route-status");
    if (el) el.textContent = msg;
  }

  function getCurrentPosition() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 }
      );
    });
  }

  let lastGeocodeAt = 0;
  /** Every request to OpenStreetMap, retries included, waits its turn: at most 1 per second (their policy). */
  async function politeFetch(url, opts) {
    const wait = 1100 - (Date.now() - lastGeocodeAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeocodeAt = Date.now();
    return fetch(url, opts);
  }
  const geocodeThrottled = (address) => FuelRoute.geocodeAddress(address, politeFetch);

  /** Coordinates for a stop: from the customer record, then this browser's cache, then a lookup. */
  async function locateStop(stop, cache) {
    for (const id of stop.customerIds) {
      const c = db.customers.find((x) => x.id === id);
      if (c && c.geo && c.geo.q === stop.key) return c.geo;
    }
    if (cache[stop.key]) return cache[stop.key];
    const g = await geocodeThrottled(stop.address);
    if (!g) return null;
    const geo = { q: stop.key, lat: g.lat, lng: g.lng };
    cache[stop.key] = geo;
    writeJSON(GEO_CACHE_KEY, cache);
    // Save on the customer so every device (and next week) skips the lookup.
    for (const id of stop.customerIds) {
      const c = db.customers.find((x) => x.id === id);
      if (c && FuelRoute.normalizeAddress(c.address) === stop.key) {
        c.geo = geo;
        persist({ type: "upsert", kind: "customers", row: c });
      }
    }
    return geo;
  }

  async function planDeliveryRoute(startText) {
    const { menuById, customersById, weekOrders, s } = ctx();
    const stops = deliveryStops(L.fulfillmentSheet(weekOrders, customersById, menuById, s).delivery);
    if (!stops.length) return;
    ui.routeBusy = true;
    ui.routeStartText = startText;
    render();
    try {
      let start = null;
      let startLabel = "Best first stop";
      if (startText) {
        setRouteStatus("Finding your starting address…");
        const g = await geocodeThrottled(startText);
        if (!g) throw new Error("Couldn't find that starting address. Try adding the city, or leave it blank to use your location.");
        start = { lat: g.lat, lng: g.lng };
        startLabel = startText;
      } else {
        setRouteStatus("Getting your location…");
        start = await getCurrentPosition();
        startLabel = start ? "Your location" : "Best first stop";
      }

      const cache = readJSON(GEO_CACHE_KEY, {});
      const found = [];
      const failed = [];
      for (let i = 0; i < stops.length; i++) {
        setRouteStatus(`Finding addresses on the map (${i + 1} of ${stops.length})…`);
        let geo = null;
        try { geo = await locateStop(stops[i], cache); } catch (_) { geo = null; }
        if (geo) found.push({ ...stops[i], lat: geo.lat, lng: geo.lng });
        else failed.push(stops[i].address);
      }
      if (!found.length) throw new Error("None of the addresses could be found on the map. Check them in Customers.");

      setRouteStatus("Working out the fastest order…");
      const plan = await FuelRoute.planRoute(start, found, (url, opts) => fetch(url, opts));
      ui.route = {
        weekOf: ui.weekOf,
        signature: stopsSignature(stops),
        start,
        startLabel,
        order: plan.order.map((i) => found[i].key),
        points: Object.fromEntries(found.map((f) => [f.key, { lat: f.lat, lng: f.lng, names: f.names, address: f.address }])),
        legs: plan.legs,
        line: plan.line,
        distance: plan.distance,
        duration: plan.duration,
        estimated: plan.estimated,
        failed,
      };
      writeJSON(ROUTE_KEY, ui.route);
      ui.routeStatus = start ? "" : "Couldn't get your location, so the route starts at the best first stop.";
    } catch (err) {
      ui.routeStatus = err.message;
    } finally {
      ui.routeBusy = false;
      render();
    }
  }

  let leafletPromise = null;
  function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
      js.onload = () => resolve(window.L);
      js.onerror = () => { leafletPromise = null; reject(new Error("Map couldn't load")); };
      document.head.appendChild(js);
    });
    return leafletPromise;
  }

  let routeMap = null;
  async function drawRouteMap() {
    const el = $("#route-map");
    const route = ui.route;
    if (!el || !route) return;
    let LF;
    try { LF = await loadLeaflet(); } catch (_) {
      el.innerHTML = `<div class="empty">The map couldn't load, but the stop order below is ready.</div>`;
      return;
    }
    if (!document.body.contains(el)) return; // page changed while loading
    if (routeMap) { routeMap.remove(); routeMap = null; }
    routeMap = LF.map(el, { scrollWheelZoom: false });
    LF.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(routeMap);
    const bounds = [];
    if (route.start) {
      LF.marker([route.start.lat, route.start.lng], { icon: LF.divIcon({ className: "route-pin start", html: "You", iconSize: [34, 24] }) })
        .addTo(routeMap).bindPopup(esc(route.startLabel));
      bounds.push([route.start.lat, route.start.lng]);
    }
    route.order.forEach((key, i) => {
      const p = route.points[key];
      if (!p) return;
      LF.marker([p.lat, p.lng], { icon: LF.divIcon({ className: "route-pin", html: String(i + 1), iconSize: [28, 28] }) })
        .addTo(routeMap).bindPopup(`<strong>${i + 1}. ${esc(p.names.join(", "))}</strong><br>${esc(p.address)}`);
      bounds.push([p.lat, p.lng]);
    });
    if (route.line && route.line.length > 1) {
      // Charcoal casing under a lime line: readable on light map tiles, on brand.
      LF.polyline(route.line, { color: "#121214", weight: 8, opacity: 0.85 }).addTo(routeMap);
      LF.polyline(route.line, { color: "#C4FF57", weight: 4, opacity: 1 }).addTo(routeMap);
    }
    if (bounds.length) routeMap.fitBounds(bounds, { padding: [30, 30] });
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
  // ---------- Food recall check (Saturday Prep) ----------
  const R = window.FuelRecalls;
  const recallsOn = () => db.settings.recallChecks !== false;

  /** Alerts to show: live rows in cloud mode, clearly-marked examples in the browser demo. */
  function recallData() {
    if (store && store.mode === "cloud") {
      return { alerts: ui.recalls ? ui.recalls.alerts : [], lastRun: ui.recalls ? ui.recalls.lastRun : null, demo: false };
    }
    if (!ui.sampleRecalls) ui.sampleRecalls = R.sampleAlerts();
    return { alerts: ui.sampleRecalls, lastRun: null, demo: true };
  }

  async function loadRecalls(force) {
    if (!store || store.mode !== "cloud" || !store.getRecalls || ui.recallsLoading) return;
    if (!force && ui.recalls && Date.now() - ui.recalls.loadedAt < 5 * 60 * 1000) return;
    ui.recallsLoading = true;
    try {
      const r = await store.getRecalls();
      ui.recalls = { ...r, loadedAt: Date.now() };
      ui.recallsError = "";
    } catch (err) {
      ui.recallsError = err.message;
    } finally {
      ui.recallsLoading = false;
    }
    if (db && (ui.tab === "prep" || ui.tab === "dashboard")) render();
  }

  function fmtStamp(ts) {
    const d = new Date(ts);
    return isNaN(d) ? "" : d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function recallItem(a, onList, compact) {
    const hz = R.hazardInfo(a.hazard);
    const cls = R.classInfo(a.classification);
    const src = R.SOURCES[a.source] || R.SOURCES.fda;
    const tone = cls ? cls.tone : "muted";
    const key = `${a.id}|${a.ingredient}`;
    const product = a.product.length > 220 ? a.product.slice(0, 217) + "…" : a.product;
    return `
      <li class="recall ${compact ? "compact" : ""} tone-${tone}" data-recall="${esc(key)}">
        <div class="recall-top">
          <div class="recall-tags">
            ${cls ? `<span class="badge cls-${tone}">${esc(cls.label)}</span>` : `<span class="badge">Unclassified</span>`}
            <span class="badge hz${hz.severe ? " hz-severe" : ""}">${esc(hz.label)}</span>
            ${onList ? '<span class="badge onlist">On this week\'s list</span>' : ""}
            ${a.sample ? '<span class="badge">Example</span>' : ""}
          </div>
          <button class="btn btn-ghost btn-sm no-print" type="button" data-action="${a.dismissed ? "recall-restore" : "recall-dismiss"}" data-id="${esc(a.id)}" data-ingredient="${esc(a.ingredient)}">${a.dismissed ? "Show again" : "Hide"}</button>
        </div>
        <div class="recall-match">Matches your <strong>${esc(a.ingredient)}</strong>${a.match === "related" ? " (the product contains it)" : ""}</div>
        <div class="recall-product">${esc(product)}</div>
        <div class="recall-meta muted small">${esc(a.firm || "Unknown firm")} · ${a.recallDate ? `recalled ${esc(shortDate(a.recallDate))}` : "date not listed"} · ${esc(R.texasLine(a.affectsTx))} · ${esc(src.name)} ${esc(a.recallNumber)}</div>
        ${compact ? "" : `<p class="recall-risk"><strong>Health risk:</strong> ${esc(hz.risk)}</p>`}
        <details class="recall-more">
          <summary>${compact ? "Health risk, lot codes &amp; what to do" : "Lot codes, reason &amp; what to do"}</summary>
          ${compact ? `<p><strong>Health risk:</strong> ${esc(hz.risk)}</p>` : ""}
          ${cls ? `<p><strong>${esc(cls.label)}:</strong> ${esc(cls.meaning)}</p>` : ""}
          <p><strong>Reason given:</strong> ${esc(a.reason || "Not stated.")}</p>
          ${a.codeInfo ? `<p><strong>Check these codes:</strong> ${esc(a.codeInfo)}</p>` : ""}
          ${a.distribution ? `<p><strong>Where it was sold:</strong> ${esc(a.distribution)}</p>` : ""}
          ${a.product.length > 220 ? `<p><strong>Full description:</strong> ${esc(a.product)}</p>` : ""}
          <p><strong>What to do</strong></p>
          <ul>${R.WHAT_TO_DO.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
          <p class="small"><a href="${esc(/^https:\/\//.test(a.url) ? a.url : src.url)}" target="_blank" rel="noopener">Official ${esc(src.name)} recall notices</a></p>
        </details>
      </li>`;
  }

  function recallCard(shoppingItems) {
    if (!recallsOn()) {
      return `<section class="card recall-card no-print"><div class="card-head"><h2>Recall check</h2><span class="badge">Off</span></div>
        <p class="muted">Nightly food recall checks are turned off. <button class="btn btn-ghost btn-sm" data-action="goto" data-to="settings">Turn on in Settings</button></p></section>`;
    }
    const cloud = store && store.mode === "cloud";
    if (cloud && !ui.recalls && !ui.recallsError) loadRecalls();
    const { alerts, lastRun, demo } = recallData();
    const g = R.organize(alerts, shoppingItems);
    const listHits = g.direct.filter((a) => g.onList.has(a.ingredient.trim().toLowerCase()));
    const checking = ui.recallCheck && ui.recallCheck.status === "running";

    let head;
    if (cloud && !ui.recalls && !ui.recallsError) head = `<span class="badge">Loading…</span>`;
    else if (listHits.length) head = `<span class="badge cls-bad">${listHits.length} on this week's list</span>`;
    else if (g.direct.length) head = `<span class="badge cls-warn">${g.direct.length} match${g.direct.length === 1 ? "" : "es"} on your menu</span>`;
    else head = `<span class="badge paid">All clear</span>`;

    const sourceLine = lastRun
      ? `<span class="src ${lastRun.fdaOk ? "ok" : "fail"}">FDA ${lastRun.fdaOk ? "✓" : "✗ couldn't be reached"}</span>
         <span class="src ${lastRun.usdaOk ? "ok" : "fail"}">USDA ${lastRun.usdaOk ? "✓" : `✗ not reachable from the server, <a href="${R.SOURCES.usda.url}" target="_blank" rel="noopener">check meat &amp; poultry recalls</a>`}</span>`
      : "";

    const status = demo
      ? `<p class="small muted recall-status">Demo mode: these are made-up <strong>examples</strong> so you can see how alerts look. With cloud sync on, the database checks official FDA recalls every night at 8 PM Central against your menu.</p>`
      : `<p class="small muted recall-status">
          ${lastRun ? `Last checked ${esc(fmtStamp(lastRun.ranAt))}: ${lastRun.recallsChecked} active recalls against ${lastRun.ingredientsChecked} menu ingredients.` : "No check has run yet."}
          Next automatic check: ${esc(R.nextCheckLabel())}.
          ${sourceLine ? `<br />${sourceLine}` : ""}
        </p>`;

    return `
      <section class="card recall-card" id="recalls">
        <div class="card-head"><h2>Recall check</h2>${head}</div>
        ${status}
        ${ui.recallsError ? `<div class="errors" role="alert">Couldn't load recalls: ${esc(ui.recallsError)}</div>` : ""}
        ${ui.recallCheck && ui.recallCheck.message ? `<p class="small recall-progress" role="status">${esc(ui.recallCheck.message)}</p>` : ""}
        ${cloud ? `<div class="btn-row no-print" style="margin-bottom:10px"><button class="btn btn-sm" type="button" data-action="recall-check" ${checking ? "disabled" : ""}>${checking ? "Checking…" : "Check now"}</button></div>` : ""}
        ${g.direct.length ? `<ul class="recall-list">${g.direct.map((a) => recallItem(a, g.onList.has(a.ingredient.trim().toLowerCase()))).join("")}</ul>`
          : (!cloud || ui.recalls) ? `<p class="recall-clear">No active recall is for an item on your menu.</p>` : ""}
        ${g.related.length ? `<details class="recall-related">
            <summary>${g.related.length} possibly related: products that contain one of your ingredients</summary>
            <p class="small muted">These recalls are for prepared foods (sauces, snacks, salads…) that list your ingredient. They matter only if you buy that exact product.</p>
            <ul class="recall-list">${g.related.map((a) => recallItem(a, false, true)).join("")}</ul>
          </details>` : ""}
        ${g.hidden.length ? `<button class="btn btn-ghost btn-sm no-print" type="button" data-action="recall-toggle-hidden" style="margin-top:8px">${ui.recallShowHidden ? "Hide" : "Show"} ${g.hidden.length} hidden</button>
          ${ui.recallShowHidden ? `<ul class="recall-list">${g.hidden.map((a) => recallItem(a, false, true)).join("")}</ul>` : ""}` : ""}
        <p class="small muted" style="margin:10px 0 0">Recall data comes from the U.S. FDA (openFDA). Health information is summarized from the CDC and FDA. It's general information, not medical advice.</p>
      </section>`;
  }

  /** Settings card: turn the nightly recall check on/off. */
  function recallSettingsCard() {
    const on = recallsOn();
    const cloud = store && store.mode === "cloud";
    const alertsReady = !!(db.settings.alertsEnabled && db.settings.ntfyTopic);
    return `
      <section class="card">
        <div class="card-head"><h2>Food recall check</h2>${on ? '<span class="badge pickup">On</span>' : '<span class="badge">Off</span>'}</div>
        <p class="muted">Every night at 8 PM Central, official FDA food recalls are checked against the ingredients on your active menu. On Friday night (before Saturday shopping) you get a summary for this week's shopping list. Other nights you're only alerted if something new matches.</p>
        <ul class="small muted" style="margin:0 0 12px;padding-left:18px">
          <li>Results show on the <strong>Saturday Prep</strong> tab, with the health risk explained.</li>
          <li>${cloud ? (alertsReady ? "Push alerts go to your phone through the ntfy app (set up under Phone alerts)." : "Turn on <strong>Phone alerts</strong> to get these on your phone. Without them, check the Prep tab.") : "Needs cloud sync. The demo shows examples."}</li>
          <li>USDA meat &amp; poultry recalls are checked too when USDA's server allows it. Otherwise the app links you to <a href="https://www.fsis.usda.gov/recalls" target="_blank" rel="noopener">fsis.usda.gov/recalls</a>.</li>
        </ul>
        <button class="btn ${on ? "btn-ghost" : ""}" type="button" data-action="recall-toggle">${on ? "Turn off recall checks" : "Turn on recall checks"}</button>
      </section>`;
  }

  async function setRecallDismissed(id, ingredient, dismissed) {
    const { alerts, demo } = recallData();
    const a = alerts.find((x) => x.id === id && x.ingredient === ingredient);
    if (!a) return;
    a.dismissed = dismissed;
    render();
    if (demo) return;
    try {
      await store.dismissRecall(id, ingredient, dismissed);
      if (dismissed) toast("Hidden. It won't be in Friday's summary.");
    } catch (err) {
      a.dismissed = !dismissed;
      render();
      toast(`Couldn't save: ${err.message}`);
    }
  }

  async function runRecallCheckNow() {
    if (!store || store.mode !== "cloud" || (ui.recallCheck && ui.recallCheck.status === "running")) return;
    ui.recallCheck = { status: "running", message: "Downloading the latest FDA recalls…" };
    render();
    try {
      const batch = await store.runRecallCheck();
      const started = Date.now();
      let st = null;
      while (Date.now() - started < 170000) {
        await new Promise((r) => setTimeout(r, 4000));
        st = await store.recallCheckStatus(batch);
        if (st.done) break;
        ui.recallCheck.message = "Matching recalls against your menu…";
        if (ui.tab === "prep") render();
      }
      if (!st || !st.done) throw new Error("The recall sources are slow right now. Try again in a few minutes.");
      ui.recallCheck = { status: "done", message: "" };
      await loadRecalls(true);
      const n = ui.recalls ? ui.recalls.alerts.filter((a) => !a.dismissed && a.match !== "related").length : 0;
      toast(st.fdaOk ? `Checked ${st.fdaCount} FDA recalls: ${n ? `${n} match${n === 1 ? "" : "es"} on your menu.` : "nothing matches your menu."}` : "FDA couldn't be reached. Try again later.");
    } catch (err) {
      ui.recallCheck = { status: "error", message: `Check failed: ${err.message}` };
    }
    render();
  }

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
      ${pendingCount() ? `<div class="banner inbox-banner"><span class="dot"></span><span><strong>${pendingCount()} new online order${pendingCount() > 1 ? "s" : ""}</strong> waiting for you to confirm.</span><button class="btn btn-sm" data-action="goto" data-to="orders" style="margin-left:auto">Review</button></div>` : ""}
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
          <td>${fulfillmentBadges(o)}${o.source === "online" ? ' <span class="badge online">Online</span>' : o.source === "plan" ? ' <span class="badge plan-active">Plan</span>' : ""}</td>
          <td><button class="badge pay-toggle ${o.paid ? "paid" : ""}" data-action="toggle-paid" data-id="${o.id}" title="Click to mark ${o.paid ? "unpaid" : "paid"}">${o.paid ? "Paid" : "Unpaid"}${PAYMENT_LABELS[o.paymentMethod] ? ` · ${PAYMENT_LABELS[o.paymentMethod]}` : ""}</button></td>
          <td class="right num">${money(t.total)}</td>
          <td class="actions">
            <button class="btn btn-ghost btn-sm" data-action="invoice" data-id="${o.id}">Invoice</button>
            <button class="btn btn-danger btn-sm" data-action="delete-order" data-id="${o.id}" aria-label="Delete order">✕</button>
          </td></tr>`;
      }).join("");

      return `
      ${pendingInbox()}
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
                    <input type="number" min="0" max="50" step="1" inputmode="numeric" list="qty-options" name="qty-${m.id}" aria-label="Quantity of ${esc(m.name)}" value="${d.qty[m.id] || ""}" placeholder="0" />
                  </div>`).join("") : `<div class="muted small">Your menu is empty — add meals in <a href="#menu" data-action="goto" data-to="menu">Menu</a>.</div>`}
              </div>
            </div>
            <datalist id="qty-options">${[1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 15, 20, 21, 25, 30].map((n) => `<option value="${n}"></option>`).join("")}</datalist>
            <div class="field">
              <span class="label-text">Fulfillment</span>
              <div class="radio-group">
                <label><input type="radio" name="fulfillment" value="delivery" ${d.fulfillment === "delivery" ? "checked" : ""}/> Delivery${s.deliveryFee ? ` (+${money(s.deliveryFee)})` : ""}</label>
                <label><input type="radio" name="fulfillment" value="pickup" ${d.fulfillment === "pickup" ? "checked" : ""}/> Pickup${s.pickupDiscountPct ? ` (−${s.pickupDiscountPct}%)` : ""}</label>
              </div>
            </div>
            <div class="field">
              <label for="o-pay">Payment method <span class="muted">(optional)</span></label>
              <select id="o-pay" name="paymentMethod">
                <option value="">Not decided</option>
                ${Object.entries(PAYMENT_LABELS).map(([k, v]) => `<option value="${k}" ${d.paymentMethod === k ? "selected" : ""}>${v}</option>`).join("")}
              </select>
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
            <thead><tr><th>Customer</th><th>Placed</th><th>Meals</th><th>Type</th><th>Payment</th><th class="right">Total</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr><td colspan="5">Week total</td><td class="right num">${money(tableTotal)}</td><td></td></tr></tfoot>
          </table></div>` : `<div class="empty">No orders for this week yet.</div>`}
        </section>
      </div>`;
    },

    menu() {
      const editing = ui.editMealId ? db.menu.find((m) => m.id === ui.editMealId) : null;
      const m = ui.mealDraft || (editing
        ? { name: editing.name, price: editing.price, macros: editing.macros, ingText: editing.ingredients.map(L.formatIngredient).join("\n"),
            description: editing.description || "", allergens: editing.allergens || [], weeklyLimit: editing.weeklyLimit || "" }
        : { name: "", price: "", macros: { cal: "", protein: "", carbs: "", fat: "" }, ingText: "", description: "", allergens: [], weeklyLimit: "" });
      const meals = activeMeals();
      const sold = L.soldForWeek(db.orders, ui.weekOf);
      const photoNow = ui.photoDraft === "remove" ? "" : ui.photoDraft ? ui.photoDraft.dataUrl : safePhoto(editing && editing.photo);
      const removed = db.menu.filter((x) => x.active === false);

      return `
      <div class="split">
        <section class="card">
          <div class="card-head"><h2>${editing ? "Edit meal" : "Add a meal"}</h2></div>
          <form data-form="meal" novalidate>
            ${errorBox("meal")}
            <div class="field"><label for="m-name">Meal name</label><input type="text" id="m-name" name="name" value="${esc(m.name)}" placeholder="e.g. Honey Garlic Chicken" /></div>
            <div class="field"><label for="m-price">Price per meal ($)</label><input type="number" id="m-price" name="price" min="0" step="0.25" value="${esc(m.price)}" /></div>
            <div class="field"><label for="m-desc">Description <span class="muted">(shown to customers)</span></label><textarea id="m-desc" name="description" maxlength="300" rows="2" placeholder="e.g. Honey garlic chicken thighs over jasmine rice with roasted broccoli">${esc(m.description || "")}</textarea></div>
            <div class="field">
              <span class="label-text">Photo</span>
              <div class="photo-field">
                <div class="photo-preview" id="m-photo-preview">${photoNow ? `<img src="${esc(photoNow)}" alt="" />` : `<span class="muted small">No photo</span>`}</div>
                <div class="btn-row">
                  <label class="btn btn-ghost btn-sm" for="m-photo" style="cursor:pointer">${photoNow ? "Change photo" : "Add photo"}</label>
                  <input type="file" id="m-photo" accept="image/jpeg,image/png,image/webp" hidden />
                  <button class="btn btn-ghost btn-sm" type="button" data-action="meal-photo-remove" ${photoNow ? "" : "hidden"}>Remove</button>
                </div>
              </div>
              <span class="small muted">A bright, top-down photo works best. It's shrunk automatically before upload.</span>
            </div>
            <fieldset class="field allergen-field">
              <legend class="label-text">Contains <span class="muted">(major allergens)</span></legend>
              <div class="allergen-grid">${L.ALLERGENS.map(([k, lbl]) => `<label><input type="checkbox" name="allergen" value="${k}" ${(m.allergens || []).includes(k) ? "checked" : ""}/> ${lbl}</label>`).join("")}</div>
            </fieldset>
            <div class="field"><label for="m-limit">Max per week <span class="muted">(optional)</span></label><input type="number" id="m-limit" name="weeklyLimit" min="1" max="999" step="1" inputmode="numeric" value="${esc(m.weeklyLimit || "")}" placeholder="No limit" />
              <span class="small muted">When this many are ordered for a week, customers see "Sold out".</span></div>
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
                ${safePhoto(x.photo) ? `<img class="meal-photo" src="${esc(safePhoto(x.photo))}" alt="" loading="lazy" />` : ""}
                <div class="card-head"><h3>${esc(x.name)}</h3><span class="price">${money(x.price)}</span></div>
                ${x.description ? `<p class="small muted" style="margin:0">${esc(x.description)}</p>` : ""}
                ${macroChips(x.macros)}
                ${(x.allergens || []).length ? `<div class="small"><span class="muted">Contains:</span> ${esc(allergenText(x.allergens))}</div>` : ""}
                <div class="small ${x.weeklyLimit && (sold.get(x.id) || 0) >= x.weeklyLimit ? "warn-text" : "muted"}">${x.weeklyLimit ? `${sold.get(x.id) || 0} of ${x.weeklyLimit} ordered for week of ${shortDate(ui.weekOf)}${(sold.get(x.id) || 0) >= x.weeklyLimit ? " · sold out" : ""}` : `${sold.get(x.id) || 0} ordered for week of ${shortDate(ui.weekOf)}`}</div>
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
      ${plansCard()}
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
      const recallG = recallsOn() ? R.organize(recallData().alerts, list.map((r) => r.item)) : null;
      const flagged = (item) => recallG && recallG.byIngredient.get(String(item).trim().toLowerCase());

      return `
      <div class="page-head">
        <div><h1>Saturday prep</h1><p class="muted">${longDate(sched.shopDay)} · shop &amp; prep for ${weekOrders.length} orders</p></div>
        <button class="btn btn-ghost no-print" data-action="print">Print</button>
      </div>
      ${recallCard(list.map((r) => r.item))}
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
              const hits = flagged(r.item);
              return `<tr class="${done ? "checked" : ""}${hits ? " recalled" : ""}"><td><input type="checkbox" data-check="${esc(k)}" ${done ? "checked" : ""} aria-label="Got ${esc(r.item)}" /></td>
                <td>${esc(r.item)}${hits ? ` <a class="badge cls-bad recall-flag" href="#recalls" data-action="recall-jump" title="${esc(hits.map((a) => `${a.firm}: ${R.hazardInfo(a.hazard).label}`).join("; "))}">Recall: check brand</a>` : ""}</td><td class="right num">${fmtQty(r.qty)} ${r.unit === "ea" ? "" : esc(r.unit)}</td>
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
      const stops = deliveryStops(sheet.delivery);
      const route = currentRoute(stops);
      const stale = ui.route && ui.route.weekOf === ui.weekOf && !route;

      // Put delivery rows in driving order when a route is planned.
      let deliveryRows = sheet.delivery;
      const legByKey = {};
      if (route) {
        const rank = new Map(route.order.map((k, i) => [k, i]));
        route.order.forEach((k, i) => { legByKey[k] = route.legs[i]; });
        const keyOf = (r) => FuelRoute.normalizeAddress(r.address);
        deliveryRows = [...sheet.delivery].sort((a, b) => (rank.has(keyOf(a)) ? rank.get(keyOf(a)) : 1e6) - (rank.has(keyOf(b)) ? rank.get(keyOf(b)) : 1e6));
      }

      const table = (rows, isDelivery) => {
        if (!rows.length) return `<div class="empty">None this week.</div>`;
        let lastKey = null;
        let stopNo = 0;
        return `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Customer</th>${isDelivery ? "<th>Address</th>" : ""}<th>Phone</th><th class="right">Meals</th><th>Notes</th><th class="right">Total</th>${isDelivery && route ? '<th class="right">Drive</th>' : ""}</tr></thead>
        <tbody>${rows.map((r, i) => {
          const key = isDelivery ? FuelRoute.normalizeAddress(r.address) : null;
          const sameStop = key && key === lastKey;
          if (!sameStop) stopNo++;
          lastKey = key;
          const leg = isDelivery && route && !sameStop ? legByKey[key] : null;
          const unmapped = isDelivery && route && r.address && !(key in legByKey);
          return `<tr>
          <td class="num">${isDelivery && route ? (sameStop ? "" : stopNo) : i + 1}</td><td><strong>${esc(r.customer)}</strong></td>
          ${isDelivery ? `<td>${r.address ? esc(r.address) : '<span class="badge late">No address on file</span>'}${unmapped ? ' <span class="badge late">Not on map</span>' : ""}</td>` : ""}
          <td>${esc(r.phone)}</td><td class="right num">${r.meals}</td><td class="muted small">${esc(r.notes)}</td><td class="right num">${money(r.total)}</td>
          ${isDelivery && route ? `<td class="right num small">${leg ? `${Math.max(1, Math.round(leg.duration / 60))} min` : ""}</td>` : ""}</tr>`;
        }).join("")}</tbody>
      </table></div>`;
      };

      return `
      <div class="page-head">
        <div><h1>Sunday deliveries</h1><p class="muted">${longDate(sched.deliveryDay)} · ${sheet.delivery.length} drop-offs, ${sheet.pickup.length} pickups</p></div>
        <button class="btn btn-ghost no-print" data-action="print">Print</button>
      </div>
      ${stops.length ? routeCard(stops, route, stale) : ""}
      <section class="card" style="margin-bottom:16px"><div class="card-head"><h2>Delivery route</h2><span class="muted small">${route ? "In driving order" : "Sorted by address"}</span></div>${table(deliveryRows, true)}</section>
      <section class="card"><div class="card-head"><h2>Pickups</h2></div>${table(sheet.pickup, false)}</section>`;
    },

    settings() {
      const s = db.settings;
      const confirmBtn = (action, label, confirmLabel) =>
        `<button class="btn btn-danger" type="button" data-action="${action}">${ui.confirming === action ? confirmLabel : label}</button>`;
      return `
      <div class="grid grid-2">
        ${onlineOrderingCard()}
        ${alertsCard()}
        ${recallSettingsCard()}
        ${deliveryAreaCard()}
        ${plansSettingsCard()}
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
      status: "confirmed",
      source: "manager",
      paymentMethod: d.paymentMethod || "",
      paid: false,
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
      paymentMethod: fd.get("paymentMethod") || "",
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
        <div style="display:flex;gap:12px;align-items:center"><img class="receipt-logo" src="img/logo-mono.png" alt="" /><div><div class="biz" id="modal-title">${esc(s.businessName)}</div><div class="muted small">${esc(s.tagline || "")}</div></div></div>
        <div class="right"><div><strong>Invoice ${invoiceNo(o)}</strong></div><div class="muted small">Issued ${longDate(o.createdOn)}</div></div>
      </div>
      <div class="receipt-meta">
        <div><span>Bill to</span>${esc(c.name)}${c.phone ? `<br>${esc(c.phone)}` : ""}</div>
        <div><span>${o.fulfillment === "delivery" ? "Deliver to" : "Pickup"}</span>${o.fulfillment === "delivery" ? esc(c.address || "Address needed") : "Customer pickup"}</div>
        <div><span>Ready on</span>${longDate(L.weekSchedule(o.weekOf).deliveryDay)}</div>
        <div><span>Payment</span>${o.paid ? "<strong>Paid</strong>" : "Unpaid"}${PAYMENT_LABELS[o.paymentMethod] ? ` · ${PAYMENT_LABELS[o.paymentMethod]}` : ""}</div>
        ${o.status === "pending" ? `<div><span>Status</span>Waiting for your confirmation</div>` : ""}
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

  function setPlanStatus(id, status, msg) {
    const p = (db.plans || []).find((x) => x.id === id);
    if (!p) return;
    p.status = status;
    render();
    persist({ type: "upsert", kind: "meal_plans", row: p }).then((ok) => ok && toast(msg));
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
    const n = pendingCount();
    const ordersTab = $('#tabs [data-tab="orders"]');
    if (ordersTab) ordersTab.innerHTML = `Orders${n ? ` <span class="tab-badge" aria-label="${n} new">${n}</span>` : ""}`;
    document.title = `${n ? `(${n}) ` : ""}${db.settings.businessName || "Fuel by Buzah"} — Meal Prep Manager`;
    if (routeMap) { routeMap.remove(); routeMap = null; }
    $("#app").innerHTML = ui.onboarding ? onboardingView() : views[ui.tab]();
    if (ui.tab === "deliveries" && $("#route-map")) drawRouteMap();
    if (ui.tab === "orders" && db.settings.kitchenGeo) fillDistances();
  }

  // ---------- Login & first-run screens (cloud mode) ----------
  function showLogin(message) {
    db = null;
    ui.user = null;
    document.body.classList.add("logged-out");
    $("#brand-name").textContent = "Fuel by Buzah";
    $("#app").innerHTML = `
      <section class="card auth-card">
        <div class="logo-banner"><img src="img/logo-full.png" alt="Fuel by Buzah" width="282" height="600" /></div>
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
        <a class="btn btn-ghost" style="width:100%;margin-top:6px" href="order.html?demo">See the customer ordering page</a>
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
    ui.photoDraft = null;
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
    "week-prev": () => { ui.weekOf = L.addDays(ui.weekOf, -7); closeWeekPicker(); render(); },
    "week-next": () => { ui.weekOf = L.addDays(ui.weekOf, 7); closeWeekPicker(); render(); },
    "week-today": () => { ui.weekOf = L.orderWindow(today(), db.settings).weekOf; closeWeekPicker(); render(); },
    "week-picker": () => ($("#week-pop").hidden ? openWeekPicker() : closeWeekPicker()),
    "cal-prev": () => { ui.calMonth = shiftMonth(ui.calMonth, -1); renderWeekPicker(); },
    "cal-next": () => { ui.calMonth = shiftMonth(ui.calMonth, 1); renderWeekPicker(); },
    "cal-pick": (el) => { ui.weekOf = el.dataset.week; closeWeekPicker(true); render(); },
    "cal-this": () => { ui.weekOf = L.orderWindow(today(), db.settings).weekOf; closeWeekPicker(true); render(); },
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

    "edit-meal": (el) => { ui.editMealId = el.dataset.id; ui.mealDraft = null; ui.photoDraft = null; ui.errors = {}; render(); $("#m-name").focus(); },
    "cancel-meal": () => { ui.editMealId = null; ui.mealDraft = null; ui.photoDraft = null; ui.errors = {}; render(); },
    "meal-photo-remove": (el) => {
      ui.photoDraft = "remove";
      $("#m-photo-preview").innerHTML = '<span class="muted small">No photo</span>';
      el.hidden = true;
    },
    "plan-pause": (el) => setPlanStatus(el.dataset.id, "paused", "Plan paused. No orders will be created until you resume it."),
    "plan-resume": (el) => setPlanStatus(el.dataset.id, "active", "Plan resumed."),
    "plan-cancel": (el) => {
      const key = "plan-cancel:" + el.dataset.id;
      if (ui.confirming !== key) { ui.confirming = key; render(); return; }
      ui.confirming = null;
      setPlanStatus(el.dataset.id, "cancelled", "Plan cancelled.");
    },
    "plans-toggle-cancelled": () => { ui.showCancelledPlans = !ui.showCancelledPlans; render(); },
    "plans-toggle": () => {
      db.settings = { ...db.settings, plansEnabled: db.settings.plansEnabled === false };
      render();
      persist({ type: "settings", settings: db.settings }).then((ok) => ok && toast(db.settings.plansEnabled ? "Customers can start weekly plans again." : "Weekly plans are no longer offered. Existing plans keep running until you pause or cancel them."));
    },
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
    "confirm-order": (el) => {
      const o = db.orders.find((x) => x.id === el.dataset.id);
      if (!o) return;
      o.status = "confirmed";
      render();
      persist({ type: "upsert", kind: "orders", row: o });
      const name = (o.contact && o.contact.name) || "Order";
      toast(o.weekOf === ui.weekOf ? `${name}'s order confirmed.` : `${name}'s order confirmed for the week of ${shortDate(o.weekOf)}.`);
    },
    "decline-order": (el) => {
      const o = db.orders.find((x) => x.id === el.dataset.id);
      if (!o) return;
      o.status = "declined";
      render();
      persist({ type: "upsert", kind: "orders", row: o });
      toast("Order declined.", () => {
        o.status = "pending";
        render();
        persist({ type: "upsert", kind: "orders", row: o });
      });
    },
    "toggle-paid": (el) => {
      const o = db.orders.find((x) => x.id === el.dataset.id);
      if (!o) return;
      o.paid = !o.paid;
      render();
      persist({ type: "upsert", kind: "orders", row: o });
    },
    "copy-link": () => copyFrom("#shop-link", "Link copied."),
    "alerts-on": () => {
      db.settings = { ...db.settings, alertsEnabled: true, ntfyTopic: db.settings.ntfyTopic || newAlertTopic(), managerUrl: managerUrl() || db.settings.managerUrl || "" };
      render();
      persist({ type: "settings", settings: db.settings }).then((ok) => ok && toast("Alerts on. Now set up the ntfy app on your phone."));
    },
    "alerts-off": () => {
      db.settings = { ...db.settings, alertsEnabled: false };
      render();
      persist({ type: "settings", settings: db.settings }).then((ok) => ok && toast("Alerts off."));
    },
    "alerts-new-topic": () => {
      if (ui.confirming !== "alerts-new-topic") { ui.confirming = "alerts-new-topic"; render(); return; }
      ui.confirming = null;
      db.settings = { ...db.settings, ntfyTopic: newAlertTopic() };
      render();
      persist({ type: "settings", settings: db.settings }).then((ok) => ok && toast("New topic saved. Subscribe to it in the ntfy app."));
    },
    "copy-topic": () => copyFrom("#alert-topic", "Topic copied."),
    "recall-toggle": () => {
      db.settings = { ...db.settings, recallChecks: !recallsOn() };
      render();
      persist({ type: "settings", settings: db.settings }).then((ok) => ok && toast(recallsOn() ? "Recall checks on. They run nightly at 8 PM Central." : "Recall checks off."));
    },
    "recall-dismiss": (el) => setRecallDismissed(el.dataset.id, el.dataset.ingredient, true),
    "recall-restore": (el) => setRecallDismissed(el.dataset.id, el.dataset.ingredient, false),
    "recall-toggle-hidden": () => { ui.recallShowHidden = !ui.recallShowHidden; render(); },
    "recall-jump": () => { const c = $("#recalls"); if (c) c.scrollIntoView({ behavior: "smooth", block: "start" }); },
    "recall-check": () => runRecallCheckNow(),
    "test-alert": async (el) => {
      el.disabled = true;
      el.textContent = "Sending…";
      const url = managerUrl();
      if (url && url !== db.settings.managerUrl) {
        db.settings = { ...db.settings, managerUrl: url };
        await persist({ type: "settings", settings: db.settings });
      }
      try {
        await store.sendTestAlert();
        toast("Test alert sent. Check your phone; it can take a few seconds.");
      } catch (err) {
        toast(`Couldn't send: ${err.message}`);
      } finally {
        el.disabled = false;
        el.textContent = "Send test alert";
      }
    },
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

    async "delivery-area"(form) {
      const fd = new FormData(form);
      const address = String(fd.get("kitchenAddress") || "").trim();
      const radius = Number(fd.get("radius"));
      const errs = [];
      if (address.length < 5) errs.push("Enter your kitchen address, including the city.");
      if (!(radius >= 1 && radius <= 100)) errs.push("Enter a delivery radius between 1 and 100 miles.");
      if (errs.length) { ui.errors["delivery-area"] = errs; return render(); }
      ui.errors["delivery-area"] = null;
      let geo = db.settings.kitchenGeo;
      if (!geo || address !== db.settings.kitchenAddress) {
        ui.areaBusy = true; render();
        try { geo = await geocodeThrottled(address); } catch (_) { geo = null; }
        ui.areaBusy = false;
        if (!geo) { ui.errors["delivery-area"] = ["Couldn't find that address on the map. Check the spelling and include the city and ZIP."]; return render(); }
        geo = { lat: geo.lat, lng: geo.lng };
      }
      db.settings = { ...db.settings, kitchenAddress: address, kitchenGeo: geo, deliveryRadiusMiles: radius };
      distances.clear();
      render();
      persist({ type: "settings", settings: db.settings }).then((ok) => ok && toast(`Delivery area saved: ${radius} miles from your kitchen.`));
    },

    async meal(form) {
      const fd = new FormData(form);
      const description = String(fd.get("description") || "").trim();
      const allergens = fd.getAll("allergen").map(String).filter((k) => L.ALLERGEN_LABELS[k]);
      const limitRaw = String(fd.get("weeklyLimit") || "").trim();
      const weeklyLimit = limitRaw === "" ? null : Number(limitRaw);
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
      if (weeklyLimit !== null && !(Number.isInteger(weeklyLimit) && weeklyLimit >= 1 && weeklyLimit <= 999)) errs.push("Max per week must be a whole number from 1 to 999, or blank for no limit.");
      if (description.length > 300) errs.push("Keep the description under 300 characters.");
      if (errs.length) {
        ui.errors.meal = errs;
        ui.mealDraft = { name: fd.get("name"), price: fd.get("price"), macros: { cal: fd.get("cal"), protein: fd.get("protein"), carbs: fd.get("carbs"), fat: fd.get("fat") }, ingText: fd.get("ingredients"), description, allergens, weeklyLimit: limitRaw };
        return render();
      }
      Object.assign(meal, { description, allergens, weeklyLimit });
      let saved = ui.editMealId ? db.menu.find((m) => m.id === ui.editMealId) : null;
      const mealId = saved ? saved.id : L.uid("meal");
      const oldPhoto = saved ? saved.photo || "" : "";
      meal.photo = oldPhoto;
      if (ui.photoDraft === "remove") meal.photo = "";
      else if (ui.photoDraft) {
        if (store && store.mode === "cloud" && store.uploadMealPhoto) {
          const btn = form.querySelector('button[type="submit"]');
          if (btn) { btn.disabled = true; btn.textContent = "Uploading photo…"; }
          try {
            meal.photo = await store.uploadMealPhoto(mealId, ui.photoDraft.blob);
          } catch (err) {
            toast(`Photo didn't upload (${err.message}). Saved without it.`);
          }
        } else {
          meal.photo = ui.photoDraft.small || ui.photoDraft.dataUrl; // browser-only mode: a small copy kept in this browser
        }
      }
      if (oldPhoto && oldPhoto !== meal.photo && store && store.deleteMealPhoto) store.deleteMealPhoto(oldPhoto);
      ui.photoDraft = null;
      if (saved) {
        Object.assign(saved, meal);
        toast(`${meal.name} updated.`);
      } else {
        saved = { id: mealId, active: true, ...meal };
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

    route(form) {
      if (ui.routeBusy) return;
      planDeliveryRoute(String(new FormData(form).get("start") || "").trim());
    },

    async ordering(form) {
      const fd = new FormData(form);
      const slug = String(fd.get("slug") || "").trim().toLowerCase();
      let cashApp = String(fd.get("cashApp") || "").trim().replace(/\s+/g, "");
      if (cashApp && !cashApp.startsWith("$")) cashApp = "$" + cashApp;
      const zelle = String(fd.get("zelle") || "").trim();
      const acceptCash = fd.get("acceptCash") === "on";
      const errs = [];
      if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) errs.push("Link name: use 3–40 lowercase letters, numbers or dashes (e.g. fuel-by-buzah).");
      if (!cashApp && !zelle && !acceptCash) errs.push("Turn on at least one way to pay.");
      if (errs.length) { ui.errors.ordering = errs; return render(); }
      ui.errors = {};
      if (slug !== ui.shopSlug) {
        try {
          await store.saveShop(slug);
          ui.shopSlug = slug;
        } catch (err) {
          ui.errors.ordering = [err.message];
          return render();
        }
      }
      db.settings = { ...db.settings, orderingOpen: fd.get("orderingOpen") === "on", cashApp, zelle, acceptCash };
      render();
      persist({ type: "settings", settings: db.settings }).then((ok) => ok && toast("Online ordering saved."));
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
    if (!e.target.closest(".week-picker")) closeWeekPicker();
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
    if (e.target.id === "rt-start") ui.routeStartText = e.target.value;
    const form = e.target.closest("#order-form");
    if (!form) return;
    readOrderForm(form);
    $("#order-preview").innerHTML = orderPreview();
  });

  document.addEventListener("change", async (e) => {
    if (e.target.id === "m-photo" && e.target.files[0]) {
      const file = e.target.files[0];
      e.target.value = "";
      try {
        const big = await resizeImage(file, 1000, 0.82);
        const small = store && store.mode === "cloud" ? null : (await resizeImage(file, 480, 0.72)).dataUrl;
        ui.photoDraft = { ...big, small };
        const prev = $("#m-photo-preview");
        if (prev) prev.innerHTML = `<img src="${big.dataUrl}" alt="" />`;
        const rm = document.querySelector('[data-action="meal-photo-remove"]');
        if (rm) rm.hidden = false;
      } catch (err) {
        toast(err.message);
      }
      return;
    }
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
    if (e.key === "Escape" && !$("#week-pop").hidden) return closeWeekPicker(true);
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
    db.plans = db.plans || [];
    ui.weekOf = L.orderWindow(today(), db.settings).weekOf;
    ui.shopSlug = store.getShop ? await store.getShop().catch(() => "") : "";
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
      store = S.createCloudStore(cfg, lib, window.FuelSeed.defaultSettings());
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
    db.plans = db.plans || [];
    ui.user = null;
    ui.onboarding = false;
    ui.weekOf = L.orderWindow(today(), db.settings).weekOf;
    render();
    if (ui.cloudAvailable && !cloudReady) toast("Couldn't reach the cloud — using this browser's data for now.");
  }

  ui.route = readJSON(ROUTE_KEY, null);
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  boot();
})();
