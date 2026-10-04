/**
 * Fuel by Buzah — customer ordering page.
 *
 *   order.html?shop=<slug>   live ordering (Supabase: get_shop / place_order)
 *   order.html?demo          demo mode with sample menu, nothing is sent
 *
 * The browser only previews prices. The database function place_order()
 * re-validates and re-prices everything, so the server's numbers win.
 */
(function () {
  "use strict";

  const L = window.FuelLogic;
  const T = window.FuelShopTools;
  const $ = (sel, el = document) => el.querySelector(sel);
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const money = L.formatMoney;
  const longDate = (d) => L.formatDate(d, { weekday: "long", month: "short", day: "numeric" });
  const shortDay = (d) => L.formatDate(d, { weekday: "short", month: "short", day: "numeric" });
  const CONTACT_KEY = "fuel-by-buzah:customer";
  const MAX_QTY = 50;
  const PAY_LABELS = { cashapp: "Cash App", zelle: "Zelle", cash: "Cash" };

  const params = new URLSearchParams(location.search);
  const slug = (params.get("shop") || "").trim().toLowerCase();
  const isDemo = params.has("demo");
  const LAST_KEY = `fuel-by-buzah:last-order:${isDemo ? "demo" : slug}`;
  const SHOP_KEY = "fuel-by-buzah:last-shop"; // so the home-screen app reopens the right shop

  const state = {
    shop: null,
    cart: {}, // mealId -> qty
    fulfillment: "delivery",
    payment: "",
    goals: {},
    submitting: false,
    restored: false, // returning customer's preferences applied once
  };
  let installPrompt = null; // Android/desktop Chrome "Install app" event
  let sb = null;

  // ---------- Helpers ----------

  function readContact() {
    try { return JSON.parse(localStorage.getItem(CONTACT_KEY) || "{}"); } catch (_) { return {}; }
  }
  function saveContact(c) {
    try { localStorage.setItem(CONTACT_KEY, JSON.stringify(c)); } catch (_) { /* private mode */ }
  }
  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (_) { return null; }
  }
  function writeJSON(key, v) {
    try { v == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(v)); } catch (_) { /* private mode */ }
  }

  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  const menuById = () => L.indexById(state.shop.menu);
  const cartItems = () => Object.entries(state.cart).filter(([, q]) => q > 0).map(([mealId, qty]) => ({ mealId, qty }));
  const windowInfo = () => L.orderWindow(state.shop.today, state.shop.settings);

  function paymentOptions() {
    const s = state.shop.settings;
    const out = [];
    if (s.cashApp) out.push({ key: "cashapp", label: "Cash App", detail: s.cashApp });
    if (s.zelle) out.push({ key: "zelle", label: "Zelle", detail: s.zelle });
    if (s.acceptCash !== false) out.push({ key: "cash", label: "Cash", detail: state.fulfillment === "pickup" ? "at pickup" : "at delivery" });
    return out;
  }

  function quote() {
    const order = { items: cartItems(), fulfillment: state.fulfillment, lateFee: windowInfo().lateFee };
    return { order, totals: L.orderTotals(order, menuById(), state.shop.settings), macros: L.orderMacros(order, menuById()) };
  }

  function macroChips(m) {
    return `<div class="macros">
      <span class="macro cal"><b>${Math.round(m.cal || 0)}</b> cal</span>
      <span class="macro protein"><b>${Math.round(m.protein || 0)}g</b> protein</span>
      <span class="macro carbs"><b>${Math.round(m.carbs || 0)}g</b> carbs</span>
      <span class="macro fat"><b>${Math.round(m.fat || 0)}g</b> fat</span>
    </div>`;
  }

  function windowBanner() {
    const w = windowInfo();
    const delivery = L.weekSchedule(w.weekOf).deliveryDay;
    const sched = L.weekSchedule(w.weekOf);
    const msg = {
      open: `Order by <strong>${shortDay(sched.ordersClose)}</strong> for <strong>${longDate(delivery)}</strong>.`,
      late: `Late order: a ${money(w.lateFee)} fee applies. Ready <strong>${longDate(delivery)}</strong>.`,
      closed: `This week's orders are closed. Your order will be for <strong>${longDate(delivery)}</strong>.`,
    }[w.status];
    return `<div class="banner ${w.status}"><span class="dot"></span><span>${msg}</span></div>${countdownHtml()}`;
  }

  /** "Orders close in 1 day 6 hrs · Thu 11:59 PM" — refreshed every 30 seconds. */
  function countdownHtml() {
    const w = windowInfo();
    const dl = T.orderDeadline(w, L.weekSchedule(w.weekOf));
    const left = dl.ms - Date.now();
    if (left <= 0) return "";
    const label = dl.kind === "late" ? "Late orders close in" : w.status === "closed" ? "Next week's orders close in" : "Orders close in";
    return `<div class="countdown${left < 24 * 3600e3 ? " urgent" : ""}" id="countdown" role="timer" aria-live="off">
      <span class="cd-label">${label}</span> <strong class="cd-time">${esc(T.formatCountdown(left))}</strong>
      <span class="cd-when">${esc(shortDay(dl.dateStr))}, 11:59 PM</span></div>`;
  }

  let countdownTimer = null;
  function startCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const box = $("#window-banner");
      if (!box || !state.shop) return clearInterval(countdownTimer);
      const w = windowInfo();
      const dl = T.orderDeadline(w, L.weekSchedule(w.weekOf));
      if (Date.now() >= dl.ms) {
        // The deadline passed while the page was open: move to the next window (late fee or next week).
        state.shop = { ...state.shop, today: T.todayInZone() };
        box.innerHTML = windowBanner();
        updateSummary();
        return;
      }
      const t = $("#countdown .cd-time");
      if (t) t.textContent = T.formatCountdown(dl.ms - Date.now());
      const c = $("#countdown");
      if (c) c.classList.toggle("urgent", dl.ms - Date.now() < 24 * 3600e3);
    }, 30000);
  }

  /** Returning customers: greet them and offer last week's order in one tap. */
  function welcomeHtml(c) {
    const last = readJSON(LAST_KEY);
    if (!c.name && !last) return "";
    const first = String(c.name || "").split(" ")[0];
    const re = last ? T.reorderCart(last, state.shop.menu) : null;
    const canReorder = re && re.meals > 0 && !cartItems().length;
    let reorderLine = "";
    if (canReorder) {
      const t = L.orderTotals({ items: Object.entries(re.cart).map(([mealId, qty]) => ({ mealId, qty })), fulfillment: last.fulfillment || state.fulfillment, lateFee: windowInfo().lateFee }, menuById(), state.shop.settings);
      reorderLine = `<button class="btn btn-sm" type="button" data-reorder>Same as last time · ${re.meals} meal${re.meals === 1 ? "" : "s"} · ${money(t.total)}</button>`;
    }
    return `<section class="card welcome" id="welcome">
      <div><strong>Welcome back${first ? `, ${esc(first)}` : ""}!</strong>
        <span class="muted small">${last && last.placedAt ? `Your last order was ${esc(shortDay(last.placedAt))}.` : "Your details are filled in below."}</span></div>
      <div class="btn-row">${reorderLine}<button class="btn btn-ghost btn-sm" type="button" data-forget>Not you?</button></div>
    </section>`;
  }

  function applyReorder() {
    const last = readJSON(LAST_KEY);
    if (!last) return;
    const re = T.reorderCart(last, state.shop.menu);
    state.cart = re.cart;
    if (last.fulfillment) state.fulfillment = last.fulfillment;
    renderShop();
    toast(re.missing.length ? `Added last order. Not on the menu this week: ${re.missing.join(", ")}.` : "Added your last order. Review and place it below.");
    const ck = $("#checkout");
    if (ck) ck.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- Views ----------

  function renderMessage(title, body, extra = "") {
    $("#shop").innerHTML = `<section class="card confirm-card"><h1>${esc(title)}</h1><p class="muted">${body}</p>${extra}</section>`;
  }

  function renderShop() {
    const shop = state.shop;
    const s = shop.settings;
    document.title = `Order · ${shop.businessName}`;
    $("#shop-name").textContent = shop.businessName;
    $("#shop-tagline").textContent = shop.tagline || "Order online";

    if (s.orderingOpen === false) {
      renderMessage("Online ordering is closed right now", `${esc(shop.businessName)} isn't taking online orders at the moment. Please check back soon.`);
      return;
    }
    if (!shop.menu.length) {
      renderMessage("The menu is coming soon", "There are no meals to order yet. Please check back soon.");
      return;
    }

    const c = readContact();
    if (!state.restored) {
      state.restored = true;
      const last = readJSON(LAST_KEY);
      if (last) {
        if (last.fulfillment === "pickup" || last.fulfillment === "delivery") state.fulfillment = last.fulfillment;
        if (last.payment) state.payment = last.payment;
        if (last.goals && !Object.keys(state.goals).length) state.goals = { ...last.goals };
      }
    }
    const pays = paymentOptions();
    if (!pays.some((p) => p.key === state.payment)) state.payment = pays.length === 1 ? pays[0].key : "";

    $("#shop").innerHTML = `
      ${isDemo ? `<div class="demo-note">Demo mode: this uses a sample menu and orders aren't sent anywhere. <a href="index.html">Open the manager app</a></div>` : ""}
      <section class="hero">
        <div class="hero-brand">
          <img class="hero-logo" src="img/logo-full.png" alt="Fuel by Buzah" width="282" height="600" />
          <div>
            <h1>Build your week of <span class="hl">meals</span></h1>
            <p>Pick your meals, see your macros, and choose delivery or pickup.</p>
          </div>
        </div>
        <div id="window-banner">${windowBanner()}</div>
      </section>
      ${welcomeHtml(c)}

      <div class="shop-layout">
        <div>
          <div class="menu-grid">
            ${shop.menu.map((m) => `
              <article class="card menu-card" data-meal="${esc(m.id)}">
                <div class="top"><h3>${esc(m.name)}</h3><span class="price">${money(m.price)}</span></div>
                ${macroChips(m.macros || {})}
                <div class="stepper" data-stepper="${esc(m.id)}">${stepperHtml(m.id)}</div>
              </article>`).join("")}
          </div>

          <h2 class="section-title" id="checkout">Your details</h2>
          <section class="card">
            <form id="checkout-form" novalidate>
              <div id="form-errors"></div>
              <div class="row">
                <div class="field"><label for="c-name">Name</label><input type="text" id="c-name" name="name" autocomplete="name" value="${esc(c.name || "")}" required /></div>
                <div class="field"><label for="c-phone">Phone (for order updates)</label><input type="tel" id="c-phone" name="phone" autocomplete="tel" inputmode="tel" value="${esc(c.phone || "")}" required /></div>
              </div>
              <div class="field">
                <span class="label-text">Delivery or pickup?</span>
                <div class="radio-group">
                  <label><input type="radio" name="fulfillment" value="delivery" ${state.fulfillment === "delivery" ? "checked" : ""}/> Delivery${s.deliveryFee ? ` (+${money(s.deliveryFee)})` : " (free)"}</label>
                  <label><input type="radio" name="fulfillment" value="pickup" ${state.fulfillment === "pickup" ? "checked" : ""}/> Pickup${s.pickupDiscountPct ? ` (save ${s.pickupDiscountPct}%)` : ""}</label>
                </div>
              </div>
              <div class="field" id="address-field" ${state.fulfillment === "pickup" ? "hidden" : ""}>
                <label for="c-address">Delivery address</label>
                <input type="text" id="c-address" name="address" autocomplete="street-address" value="${esc(c.address || "")}" placeholder="Street, apt, city" />
              </div>
              <div class="field">
                <span class="label-text">How will you pay?</span>
                <div class="pay-options" id="pay-options">${payOptionsHtml()}</div>
              </div>
              <div class="field">
                <label for="c-notes">Notes (optional)</label>
                <input type="text" id="c-notes" name="notes" maxlength="500" placeholder="Allergies, gate code, swaps…" />
              </div>
              <div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" name="website" tabindex="-1" autocomplete="off" /></label></div>
              <button class="btn submit-btn" type="submit" id="submit-btn">Place order</button>
              <p class="small muted" style="margin:10px 0 0">We'll text you to confirm. You pay after your order is confirmed.</p>
            </form>
          </section>
        </div>

        <aside class="shop-side">
          <section class="card" id="summary"></section>
          <section class="card">
            <div class="card-head"><h2>Your week's macros</h2></div>
            <div id="macro-summary"></div>
            <details class="goals" ${Object.keys(state.goals).length ? "open" : ""}>
              <summary>Compare with my daily goals</summary>
              <div class="row">
                ${[["cal", "Calories"], ["protein", "Protein (g)"], ["carbs", "Carbs (g)"], ["fat", "Fat (g)"]].map(([k, lbl]) => `
                  <div class="field" style="margin:0"><label for="g-${k}">${lbl}</label><input type="number" min="0" max="20000" inputmode="numeric" id="g-${k}" data-goal="${k}" value="${esc(state.goals[k] || "")}" /></div>`).join("")}
              </div>
              <p class="small muted" style="margin:8px 0 0">Optional. Your goals are shared with the chef so future preps can fit them.</p>
            </details>
          </section>
        </aside>
      </div>`;
    updateSummary();
    startCountdown();
  }

  const QUICK_QTYS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 15, 20, 21, 25, 30];

  /** Quantity control: tap +/−, type a number, or pick one from the ▾ menu. */
  function stepperHtml(id) {
    const q = state.cart[id] || 0;
    const name = (state.shop.menu.find((m) => m.id === id) || {}).name || "meal";
    const menuBtn = `<button type="button" class="qty-menu-btn" data-qtymenu="${esc(id)}" aria-haspopup="listbox" aria-label="Choose how many ${esc(name)}">▾</button>`;
    if (!q) return `<button type="button" class="add add-label" data-add="${esc(id)}" aria-label="Add ${esc(name)}">Add</button>${menuBtn}`;
    return `
      <button type="button" data-dec="${esc(id)}" aria-label="Remove one">−</button>
      <span class="qty-box">
        <input class="qty-input" type="text" inputmode="numeric" pattern="[0-9]*" data-qty="${esc(id)}" value="${q}" aria-label="How many ${esc(name)}" />
        ${menuBtn}
      </span>
      <button type="button" class="add" data-inc="${esc(id)}" aria-label="Add one" ${q >= MAX_QTY ? "disabled" : ""}>+</button>`;
  }

  function closeQtyMenu() {
    const pop = document.getElementById("qty-pop");
    if (pop) pop.remove();
  }

  function openQtyMenu(btn) {
    const id = btn.dataset.qtymenu;
    const wasOpenFor = document.getElementById("qty-pop") && document.getElementById("qty-pop").dataset.for;
    closeQtyMenu();
    if (wasOpenFor === id) return; // second tap closes
    const cur = state.cart[id] || 0;
    const pop = document.createElement("div");
    pop.id = "qty-pop";
    pop.className = "qty-pop";
    pop.dataset.for = id;
    pop.setAttribute("role", "listbox");
    pop.innerHTML = `${cur ? `<button type="button" role="option" data-pick="0" class="remove">Remove</button>` : ""}${QUICK_QTYS.map((n) => `<button type="button" role="option" data-pick="${n}" aria-selected="${n === cur}" class="${n === cur ? "current" : ""}">${n}</button>`).join("")}`;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    const below = r.bottom + 6 + pop.offsetHeight < window.innerHeight;
    pop.style.left = `${left + window.scrollX}px`;
    pop.style.top = `${(below ? r.bottom + 6 : r.top - pop.offsetHeight - 6) + window.scrollY}px`;
    const first = pop.querySelector(".current") || pop.querySelector("button");
    if (first) first.focus();
  }

  /** Apply a typed quantity without re-rendering the input (keeps the cursor where it is). */
  function typedQty(input, commit) {
    const id = input.dataset.qty;
    const digits = input.value.replace(/\D/g, "").slice(0, 2);
    if (digits !== input.value) input.value = digits;
    if (digits === "" && !commit) return; // let them clear the box and type a new number
    const q = Math.min(MAX_QTY, Number(digits || 0));
    // Only rebuild the control when it must switch back to "Add"; rebuilding while the
    // shopper is clicking + / − / ▾ would swallow that click.
    if (commit && q === 0) return setQty(id, 0, true);
    if (commit) {
      input.value = String(q);
      const inc = input.closest(".stepper").querySelector("[data-inc]");
      if (inc) inc.disabled = q >= MAX_QTY;
    }
    state.cart[id] = q;
    const card = input.closest(".menu-card");
    if (card) card.classList.toggle("in-cart", q > 0);
    updateSummary();
  }

  function payOptionsHtml() {
    const pays = paymentOptions();
    if (!pays.length) return `<div class="muted small">Payment details will be shared when your order is confirmed.</div>`;
    return pays.map((p) => `
      <label><input type="radio" name="payment" value="${p.key}" ${state.payment === p.key ? "checked" : ""}/> ${esc(p.label)} <span class="muted">${esc(p.detail)}</span></label>`).join("");
  }

  function updateSummary() {
    const { totals: t, macros } = quote();
    const s = state.shop.settings;
    const days = s.macroDays || 5;

    $("#summary").innerHTML = `
      <div class="card-head"><h2>Your order</h2><span class="badge">${t.mealCount} meal${t.mealCount === 1 ? "" : "s"}</span></div>
      ${t.mealCount ? `
        <div class="table-wrap"><table>${t.lines.map((l) => `<tr><td>${l.qty}× ${esc(l.name)}</td><td class="right num">${money(l.lineTotal)}</td></tr>`).join("")}</table></div>
        <div class="summary">
          <div class="line"><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
          ${t.pickupDiscount ? `<div class="line"><span>Pickup discount</span><span>−${money(t.pickupDiscount)}</span></div>` : ""}
          ${t.tax ? `<div class="line"><span>Tax</span><span>${money(t.tax)}</span></div>` : ""}
          ${t.deliveryFee ? `<div class="line"><span>Delivery</span><span>${money(t.deliveryFee)}</span></div>` : ""}
          ${t.lateFee ? `<div class="line"><span>Late order fee</span><span>${money(t.lateFee)}</span></div>` : ""}
          <div class="line total"><span>Total</span><span>${money(t.total)}</span></div>
        </div>
        <a class="btn" href="#checkout" style="width:100%">Continue to details</a>`
      : `<div class="empty" style="padding:16px 8px">Tap <strong>Add</strong> on a meal to start your order.</div>`}`;

    const goalsSet = L.MACRO_KEYS.some((k) => state.goals[k] > 0);
    const labels = { cal: "Calories", protein: "Protein", carbs: "Carbs", fat: "Fat" };
    const prog = L.macroProgress(macros, state.goals, days);
    $("#macro-summary").innerHTML = t.mealCount
      ? `${macroChips(macros)}
         <div class="per-day">About <strong>${Math.round(macros.cal / days).toLocaleString()} cal</strong> and <strong>${Math.round(macros.protein / days)}g protein</strong> per day over ${days} days.</div>
         ${goalsSet ? `<div class="bars">${L.MACRO_KEYS.map((k) => {
            const p = prog[k];
            if (p.pct == null) return "";
            return `<div class="bar-row"><span>${labels[k]}</span><div class="bar"><span style="width:${Math.min(p.pct, 100)}%;background:var(--${k})"></span></div><span class="right">${p.pct}% of goal</span></div>`;
          }).join("")}</div>` : ""}`
      : `<div class="muted small">Add meals to see your totals.</div>`;

    const btn = $("#submit-btn");
    if (btn && !state.submitting) btn.textContent = t.mealCount ? `Place order · ${money(t.total)}` : "Place order";
    const bar = $("#cart-bar");
    bar.hidden = !t.mealCount;
    $("#cart-count").textContent = `${t.mealCount} meal${t.mealCount === 1 ? "" : "s"}`;
    $("#cart-total").textContent = money(t.total);
  }

  function setQty(id, q, keepFocus) {
    state.cart[id] = Math.max(0, Math.min(MAX_QTY, q));
    const card = document.querySelector(`[data-meal="${CSS.escape(id)}"]`);
    if (card) {
      const box = card.querySelector("[data-stepper]");
      box.innerHTML = stepperHtml(id);
      card.classList.toggle("in-cart", state.cart[id] > 0);
      if (keepFocus) {
        const target = box.querySelector(".qty-input") || box.querySelector("[data-add]");
        if (target) target.focus();
      }
    }
    updateSummary();
  }

  function showErrors(errs) {
    const box = $("#form-errors");
    box.innerHTML = errs.length ? `<div class="errors" role="alert"><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
    if (errs.length) box.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function renderConfirmation(r, contact) {
    const pay = r.paymentMethod;
    const amount = Number(r.total).toFixed(2);
    const cashUrl = T.cashAppPayUrl(r.cashApp, r.total);
    const payBox = {
      cashapp: `<div class="pay-box">After we confirm, send <strong>${money(r.total)}</strong> on Cash App to<div class="handle">${esc(r.cashApp)}</div>Put <span class="ref">${esc(r.ref)}</span> in the note.
        <div class="btn-row" style="margin-top:8px">${cashUrl ? `<a class="btn btn-sm" href="${esc(cashUrl)}" target="_blank" rel="noopener" data-pay-link>Pay ${money(r.total)} in Cash App</a>` : ""}<button class="btn btn-ghost btn-sm" data-copy="${esc(r.ref)}" data-copy-label="Order code copied. Paste it in the note.">Copy order code</button></div>
        <p class="small muted" style="margin:8px 0 0">The amount is filled in for you. Double-check it before you send.</p></div>`,
      zelle: `<div class="pay-box">After we confirm, send <strong>${money(r.total)}</strong> with Zelle to<div class="handle">${esc(r.zelle)}</div>Put <span class="ref">${esc(r.ref)}</span> in the memo.
        <div class="btn-row" style="margin-top:8px"><button class="btn btn-sm" data-copy="${esc(r.zelle)}" data-copy-label="Zelle contact copied.">Copy Zelle contact</button><button class="btn btn-ghost btn-sm" data-copy="${esc(amount)}" data-copy-label="Amount copied.">Copy amount</button><button class="btn btn-ghost btn-sm" data-copy="${esc(r.ref)}" data-copy-label="Order code copied.">Copy order code</button></div></div>`,
      cash: `<div class="pay-box">Pay <strong>${money(r.total)}</strong> in cash at ${contact.fulfillment === "pickup" ? "pickup" : "delivery"}.</div>`,
    }[pay] || "";
    $("#cart-bar").hidden = true;
    $("#shop").innerHTML = `
      <section class="card confirm-card">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px">
          <img src="img/logo-icon.png" alt="" style="height:64px;width:auto" />
          <div class="confirm-check" style="margin:0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
        </div>
        <h1>Order received!</h1>
        <p>Thanks, ${esc(contact.name.split(" ")[0])}. ${esc(r.businessName)} will text you at <strong>${esc(contact.phone)}</strong> to confirm.</p>
        <div class="receipt-meta">
          <div><span>Order</span><span class="ref">#${esc(r.ref)}</span></div>
          <div><span>${contact.fulfillment === "pickup" ? "Pickup" : "Delivery"}</span>${longDate(r.deliveryDay)}</div>
          <div><span>Meals</span>${r.mealCount}</div>
          <div><span>Total</span><strong>${money(r.total)}</strong></div>
        </div>
        ${r.window === "late" ? `<p class="small muted">Includes a ${money(r.lateFee)} late order fee.</p>` : ""}
        ${payBox}
        ${calendarHtml(r, contact)}
        ${installHtml()}
        ${isDemo ? `<p class="small muted">Demo mode: nothing was sent. In the live app this order appears in the manager's "New online orders" inbox.</p>` : ""}
        <button class="btn btn-ghost" data-restart>Start a new order</button>
      </section>`;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** Save the delivery/pickup day to the customer's calendar. */
  let lastEvent = null;
  function calendarHtml(r, contact) {
    if (!r.deliveryDay || !r.mealCount) return "";
    const pickup = contact.fulfillment === "pickup";
    lastEvent = {
      uid: `order-${r.ref}`,
      date: r.deliveryDay,
      title: `${r.businessName || "Meal prep"} ${pickup ? "pickup" : "delivery"} (${r.mealCount} meals)`,
      description: `Order #${r.ref} · ${r.mealCount} meals · ${money(r.total)}${pickup ? "" : "\nDelivered to: " + contact.address}`,
      location: pickup ? "" : contact.address,
    };
    return `<div class="cal-box">
      <span class="small muted">${pickup ? "Pickup" : "Delivery"} day: <strong>${esc(longDate(r.deliveryDay))}</strong></span>
      <div class="btn-row"><button class="btn btn-ghost btn-sm" type="button" data-ics>Add to calendar</button>
        <a class="btn btn-ghost btn-sm" href="${esc(T.googleCalendarUrl(lastEvent))}" target="_blank" rel="noopener">Google Calendar</a></div>
    </div>`;
  }

  function downloadIcs() {
    if (!lastEvent) return;
    const blob = new Blob([T.buildIcs(lastEvent)], { type: "text/calendar;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${lastEvent.uid}.ics`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast("Calendar file saved. Open it to add the event.");
  }

  // ---------- Install as an app ----------
  const isStandalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  function installHtml() {
    if (isDemo || isStandalone()) return "";
    if (installPrompt) {
      return `<div class="install-box"><img src="img/icon-192.png" alt="" width="40" height="40" />
        <div><strong>Order faster next time</strong><span class="small muted">Add ${esc(state.shop.businessName)} to your home screen.</span></div>
        <button class="btn btn-sm" type="button" data-install>Install</button></div>`;
    }
    if (isIOS()) {
      return `<div class="install-box"><img src="img/icon-192.png" alt="" width="40" height="40" />
        <div><strong>Order faster next time</strong><span class="small muted">Tap the Share button <span aria-hidden="true">⎋</span>, then <strong>Add to Home Screen</strong>.</span></div></div>`;
    }
    return "";
  }

  // ---------- Submit ----------

  async function submit(form) {
    if (state.submitting) return;
    const fd = new FormData(form);
    if (fd.get("website")) { // honeypot: bots fill every field
      renderConfirmation({ ref: "000000", total: 0, mealCount: 0, deliveryDay: state.shop.today, businessName: state.shop.businessName, paymentMethod: "" }, { name: "there", phone: "", fulfillment: "pickup" });
      return;
    }
    const contact = {
      name: String(fd.get("name") || "").trim(),
      phone: String(fd.get("phone") || "").trim(),
      address: String(fd.get("address") || "").trim(),
      fulfillment: state.fulfillment,
    };
    const digits = contact.phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    const items = cartItems();
    const errs = [];
    if (!items.length) errs.push("Add at least one meal.");
    if (contact.name.length < 2) errs.push("Please enter your name.");
    if (digits.length !== 10) errs.push("Please enter a 10-digit phone number.");
    if (state.fulfillment === "delivery" && contact.address.length < 5) errs.push("Please enter a delivery address.");
    if (paymentOptions().length && !state.payment) errs.push("Choose how you'll pay.");
    if (errs.length) return showErrors(errs);
    showErrors([]);

    const payload = {
      name: contact.name,
      phone: contact.phone,
      fulfillment: state.fulfillment,
      address: state.fulfillment === "delivery" ? contact.address : "",
      paymentMethod: state.payment,
      notes: String(fd.get("notes") || "").trim(),
      items,
      targets: Object.fromEntries(L.MACRO_KEYS.filter((k) => state.goals[k] > 0).map((k) => [k, state.goals[k]])),
    };

    state.submitting = true;
    const btn = $("#submit-btn");
    btn.disabled = true;
    btn.textContent = "Placing order…";
    try {
      let result;
      if (isDemo) {
        const { totals: t } = quote();
        const w = windowInfo();
        await new Promise((r) => setTimeout(r, 400));
        result = {
          ref: Math.random().toString(36).slice(2, 8).toUpperCase(), status: "pending", window: w.status, weekOf: w.weekOf,
          deliveryDay: L.weekSchedule(w.weekOf).deliveryDay, mealCount: t.mealCount, total: t.total, lateFee: t.lateFee,
          paymentMethod: state.payment, cashApp: state.shop.settings.cashApp, zelle: state.shop.settings.zelle, businessName: state.shop.businessName,
        };
      } else {
        const { data, error } = await sb.rpc("place_order", { p_slug: slug, p_order: payload });
        if (error) throw new Error(error.message);
        result = data;
      }
      saveContact({ name: contact.name, phone: contact.phone, address: contact.address || readContact().address || "" });
      const names = menuById();
      writeJSON(LAST_KEY, {
        items: items.map((it) => ({ ...it, name: (names.get(it.mealId) || {}).name || "" })),
        fulfillment: state.fulfillment, payment: state.payment, goals: state.goals, placedAt: T.todayInZone(), ref: result.ref,
      });
      state.cart = {};
      renderConfirmation(result, contact);
    } catch (err) {
      const msg = err.message || "Something went wrong. Please try again.";
      showErrors([/fetch|network/i.test(msg) ? "We couldn't reach the server. Check your connection and try again." : msg]);
      if (/no longer on the menu/i.test(msg)) setTimeout(() => location.reload(), 2500);
    } finally {
      state.submitting = false;
      const b = $("#submit-btn");
      if (b) { b.disabled = false; updateSummary(); }
    }
  }

  // ---------- Events ----------

  document.addEventListener("click", (e) => {
    const menuBtn = e.target.closest("[data-qtymenu]");
    if (menuBtn) return openQtyMenu(menuBtn);
    const pick = e.target.closest("[data-pick]");
    if (pick) {
      const id = pick.closest("#qty-pop").dataset.for;
      closeQtyMenu();
      return setQty(id, Number(pick.dataset.pick), true);
    }
    if (!e.target.closest("#qty-pop")) closeQtyMenu();
    const t = e.target.closest("[data-add],[data-inc],[data-dec],[data-copy],[data-restart],[data-reorder],[data-forget],[data-ics],[data-install]");
    if (!t) return;
    if (t.hasAttribute("data-reorder")) return applyReorder();
    if (t.hasAttribute("data-ics")) return downloadIcs();
    if (t.hasAttribute("data-install")) {
      if (!installPrompt) return;
      installPrompt.prompt();
      installPrompt.userChoice.finally(() => { installPrompt = null; const box = t.closest(".install-box"); if (box) box.remove(); });
      return;
    }
    if (t.hasAttribute("data-forget")) {
      saveContact({});
      writeJSON(LAST_KEY, null);
      writeJSON(SHOP_KEY, null);
      state.goals = {};
      state.payment = "";
      renderShop();
      return toast("Your saved details were removed from this device.");
    }
    if (t.dataset.add) setQty(t.dataset.add, 1);
    else if (t.dataset.inc) setQty(t.dataset.inc, (state.cart[t.dataset.inc] || 0) + 1);
    else if (t.dataset.dec) setQty(t.dataset.dec, (state.cart[t.dataset.dec] || 0) - 1);
    else if (t.dataset.copy) {
      const v = t.dataset.copy;
      const msg = t.dataset.copyLabel || "Copied.";
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => toast(msg), () => toast(v));
    } else if (t.hasAttribute("data-restart")) {
      renderShop();
      window.scrollTo({ top: 0 });
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.name === "fulfillment") {
      state.fulfillment = e.target.value;
      const addr = $("#address-field");
      if (addr) addr.hidden = state.fulfillment === "pickup";
      $("#pay-options").innerHTML = payOptionsHtml();
      updateSummary();
    }
    if (e.target.name === "payment") state.payment = e.target.value;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.getElementById("qty-pop")) {
      const id = document.getElementById("qty-pop").dataset.for;
      closeQtyMenu();
      const btn = document.querySelector(`[data-qtymenu="${CSS.escape(id)}"]`);
      if (btn) btn.focus();
    }
    if (e.key === "Enter" && e.target.matches && e.target.matches(".qty-input")) {
      e.preventDefault();
      typedQty(e.target, true);
    }
  });

  window.addEventListener("resize", closeQtyMenu);

  // Typed quantities: update totals as they type, tidy up when they leave the box.
  document.addEventListener("focusout", (e) => {
    if (e.target.matches && e.target.matches(".qty-input")) typedQty(e.target, true);
  });

  document.addEventListener("input", (e) => {
    if (e.target.matches && e.target.matches(".qty-input")) return typedQty(e.target, false);
    const k = e.target.dataset && e.target.dataset.goal;
    if (k) {
      const v = Number(e.target.value);
      if (v > 0) state.goals[k] = Math.min(v, 20000); else delete state.goals[k];
      updateSummary();
    }
  });

  document.addEventListener("submit", (e) => {
    if (e.target.id !== "checkout-form") return;
    e.preventDefault();
    submit(e.target);
  });

  // ---------- Boot ----------

  async function boot() {
    if (isDemo) {
      const d = window.FuelSeed.buildDemoData(L.toISODate(new Date()));
      state.shop = {
        slug: "demo",
        businessName: d.settings.businessName,
        tagline: d.settings.tagline,
        today: L.toISODate(new Date()),
        settings: d.settings,
        menu: d.menu.filter((m) => m.active !== false).map(({ id, name, price, macros }) => ({ id, name, price, macros })),
      };
      return renderShop();
    }
    if (!slug) {
      const saved = readJSON(SHOP_KEY);
      if (saved && /^[a-z0-9-]{3,40}$/.test(saved)) return location.replace(`order.html?shop=${encodeURIComponent(saved)}`);
      return renderMessage("Ordering link needed", "This page needs a shop link, like <code>order.html?shop=your-shop</code>.", `<a class="btn btn-ghost" href="order.html?demo">See a demo</a>`);
    }
    const cfg = window.FUEL_CONFIG || {};
    if (!cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase) {
      return renderMessage("We couldn't load the menu", "The ordering service isn't reachable right now. Please try again in a moment.", `<button class="btn" onclick="location.reload()">Try again</button>`);
    }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await sb.rpc("get_shop", { p_slug: slug });
    if (error) {
      return renderMessage("We couldn't load the menu", "Please check your connection and try again.", `<button class="btn" onclick="location.reload()">Try again</button>`);
    }
    if (!data) {
      return renderMessage("Shop not found", "This ordering link doesn't match any shop. Please check the link you were sent.");
    }
    state.shop = data;
    writeJSON(SHOP_KEY, slug);
    renderShop();
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
  });
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  boot();
})();
