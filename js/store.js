/**
 * Fuel by Buzah — storage layer.
 *
 * Two interchangeable backends with the same interface:
 *   - LocalStore: this browser's localStorage (demo mode / no config)
 *   - CloudStore: Supabase (Postgres + Auth + Realtime), synced across devices
 *
 * The app keeps one in-memory `db` object and calls `apply(op)` after each
 * change. An op is one of:
 *   { type: "upsert",   kind: "meals" | "customers" | "orders", row }
 *   { type: "remove",   kind, id }
 *   { type: "settings", settings }
 *   { type: "replaceAll", db }
 *
 * Row mapping (camelCase app objects <-> snake_case table rows) is pure and
 * exported for unit tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FuelStore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LOCAL_KEY = "fuel-by-buzah:v1";
  const KINDS = ["meals", "customers", "orders"];

  // ---------- Mapping ----------

  const toRow = {
    meals: (m) => ({
      id: m.id,
      name: m.name,
      price: m.price,
      macros: m.macros || {},
      ingredients: m.ingredients || [],
      active: m.active !== false,
    }),
    customers: (c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone || "",
      address: c.address || "",
      targets: c.targets || {},
      geo: c.geo || null,
    }),
    orders: (o) => ({
      id: o.id,
      customer_id: o.customerId,
      created_on: o.createdOn,
      week_of: o.weekOf,
      items: o.items || [],
      fulfillment: o.fulfillment,
      notes: o.notes || "",
      late_fee: o.lateFee || 0,
      status: o.status || "confirmed",
      source: o.source || "manager",
      payment_method: o.paymentMethod || "",
      paid: !!o.paid,
      quoted_total: o.quotedTotal == null ? null : o.quotedTotal,
      contact: o.contact || {},
    }),
  };

  const fromRow = {
    meals: (r) => ({
      id: r.id,
      name: r.name,
      price: Number(r.price),
      macros: r.macros || {},
      ingredients: r.ingredients || [],
      active: r.active !== false,
    }),
    customers: (r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone || "",
      address: r.address || "",
      targets: r.targets || {},
      geo: r.geo || null,
    }),
    orders: (r) => ({
      id: r.id,
      customerId: r.customer_id,
      createdOn: String(r.created_on).slice(0, 10),
      weekOf: String(r.week_of).slice(0, 10),
      items: r.items || [],
      fulfillment: r.fulfillment,
      notes: r.notes || "",
      lateFee: Number(r.late_fee) || 0,
      status: r.status || "confirmed",
      source: r.source || "manager",
      paymentMethod: r.payment_method || "",
      paid: !!r.paid,
      quotedTotal: r.quoted_total == null ? null : Number(r.quoted_total),
      contact: r.contact || {},
    }),
  };

  function isValidDb(d) {
    return !!(d && typeof d === "object" && d.settings && Array.isArray(d.menu) && Array.isArray(d.customers) && Array.isArray(d.orders));
  }

  const dbKey = (kind) => (kind === "meals" ? "menu" : kind);

  function isEmpty(db) {
    return !db.menu.length && !db.customers.length && !db.orders.length;
  }

  // ---------- Local backend ----------

  function readLocal() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return isValidDb(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function writeLocal(db) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(db));
  }

  function createLocalStore(seedFn) {
    let current = null;
    return {
      mode: "local",
      async loadAll() {
        current = readLocal() || seedFn();
        writeLocal(current);
        return current;
      },
      // Local ops mutate nothing themselves — the app already changed `db`;
      // we just persist the whole object.
      async apply(op, db) {
        if (op.type === "replaceAll") current = op.db;
        else current = db;
        writeLocal(current);
      },
      subscribe() {
        return () => {};
      },
    };
  }

  // ---------- Cloud backend (Supabase) ----------

  function createCloudStore(config, supabaseLib, defaultSettings) {
    const sb = supabaseLib.createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    let channel = null;

    const check = ({ error }) => {
      if (error) throw new Error(error.message || String(error));
    };

    async function userId() {
      const { data } = await sb.auth.getSession();
      return data.session ? data.session.user.id : null;
    }

    return {
      mode: "cloud",
      client: sb,

      async getUser() {
        const { data } = await sb.auth.getSession();
        return data.session ? data.session.user : null;
      },

      async signIn(email, password) {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message);
        return data.user;
      },

      async signOut() {
        if (channel) sb.removeChannel(channel);
        channel = null;
        await sb.auth.signOut();
      },

      onAuthChange(cb) {
        sb.auth.onAuthStateChange((event, session) => cb(event, session ? session.user : null));
      },

      async loadAll() {
        const [s, m, c, o] = await Promise.all([
          sb.from("settings").select("data").maybeSingle(),
          sb.from("meals").select("*").order("created_at"),
          sb.from("customers").select("*").order("created_at"),
          sb.from("orders").select("*").order("created_on"),
        ]);
        [s, m, c, o].forEach(check);
        return {
          version: 1,
          settings: { ...defaultSettings, ...(s.data ? s.data.data : {}) },
          settingsSaved: !!s.data,
          menu: m.data.map(fromRow.meals),
          customers: c.data.map(fromRow.customers),
          orders: o.data.map(fromRow.orders),
        };
      },

      async apply(op) {
        if (op.type === "upsert") {
          check(await sb.from(op.kind).upsert(toRow[op.kind](op.row), { onConflict: "owner_id,id" }));
        } else if (op.type === "remove") {
          check(await sb.from(op.kind).delete().eq("id", op.id));
        } else if (op.type === "settings") {
          check(await sb.from("settings").upsert({ data: op.settings, updated_at: new Date().toISOString() }, { onConflict: "owner_id" }));
        } else if (op.type === "replaceAll") {
          const uid = await userId();
          if (!uid) throw new Error("Not signed in.");
          // Children first so foreign keys are never violated.
          check(await sb.from("orders").delete().eq("owner_id", uid));
          check(await sb.from("customers").delete().eq("owner_id", uid));
          check(await sb.from("meals").delete().eq("owner_id", uid));
          check(await sb.from("settings").upsert({ data: op.db.settings, updated_at: new Date().toISOString() }, { onConflict: "owner_id" }));
          if (op.db.menu.length) check(await sb.from("meals").insert(op.db.menu.map(toRow.meals)));
          if (op.db.customers.length) check(await sb.from("customers").insert(op.db.customers.map(toRow.customers)));
          if (op.db.orders.length) check(await sb.from("orders").insert(op.db.orders.map(toRow.orders)));
        }
      },

      /** Your public ordering link slug, or "" if not set yet. */
      async getShop() {
        const res = await sb.from("shops").select("slug").maybeSingle();
        check(res);
        return res.data ? res.data.slug : "";
      },

      async saveShop(slug) {
        const res = await sb.from("shops").upsert({ slug }, { onConflict: "owner_id" });
        if (res.error) {
          if (/duplicate|unique/i.test(res.error.message)) throw new Error("That link name is taken. Try another.");
          if (/check/i.test(res.error.message)) throw new Error("Use 3–40 lowercase letters, numbers or dashes.");
          throw new Error(res.error.message);
        }
      },

      /** Asks the database to push a test notification to the owner's ntfy topic. */
      async sendTestAlert() {
        const { error } = await sb.rpc("send_test_alert");
        if (error) throw new Error(error.message);
      },

      /** Calls `onChange()` whenever any of this owner's rows change on any device. */
      subscribe(onChange) {
        if (channel) sb.removeChannel(channel);
        channel = sb.channel("fuel-db");
        for (const table of ["settings", ...KINDS]) {
          channel.on("postgres_changes", { event: "*", schema: "public", table }, () => onChange());
        }
        channel.subscribe();
        return () => {
          if (channel) sb.removeChannel(channel);
          channel = null;
        };
      },
    };
  }

  return { LOCAL_KEY, KINDS, toRow, fromRow, dbKey, isValidDb, isEmpty, readLocal, createLocalStore, createCloudStore };
});
