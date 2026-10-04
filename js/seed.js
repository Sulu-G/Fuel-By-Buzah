/**
 * Demo data so the app is useful the first time it opens.
 * Orders are generated relative to today, so the current week always has data.
 */
(function (root) {
  "use strict";
  const L = root.FuelLogic;

  const ing = (line) => L.parseIngredientLine(line);

  /** Defaults for a brand-new account (no payment handles filled in). */
  function defaultSettings() {
    return {
      businessName: "Fuel by Buzah",
      tagline: "Fitness-friendly meal prep, delivered Sunday",
      deliveryFee: 5,
      pickupDiscountPct: 5,
      taxRatePct: 0,
      lateOrders: "fee",
      lateFee: 7.5,
      macroDays: 5,
      orderingOpen: true,
      acceptCash: true,
      cashApp: "",
      zelle: "",
      alertsEnabled: false,
      recallChecks: true,
      plansEnabled: true, // customers may tick "Repeat every week" at checkout
      kitchenAddress: "",
      kitchenGeo: null,
      deliveryRadiusMiles: null, // nightly FDA/USDA recall check against the menu (cloud mode)
      ntfyTopic: "",
      managerUrl: "",
    };
  }

  function buildDemoData(todayISO) {
    const settings = { ...defaultSettings(), cashApp: "$FuelByBuzahDemo", zelle: "demo@fuelbybuzah.com" };

    const menu = [
      {
        id: "meal_chicken_rice",
        description: "Garlic-herb chicken breast over jasmine rice with roasted broccoli.",
        allergens: [],
        photo: "",
        weeklyLimit: null,
        name: "Garlic Chicken & Jasmine Rice",
        price: 12,
        macros: { cal: 540, protein: 48, carbs: 58, fat: 11 },
        ingredients: ["0.4 lb chicken breast", "1 cup jasmine rice", "1 cup broccoli", "2 cloves garlic"].map(ing),
      },
      {
        id: "meal_turkey_bowl",
        description: "Seasoned ground turkey, rice, black beans, fresh salsa and avocado.",
        allergens: [],
        photo: "",
        weeklyLimit: null,
        name: "Turkey Taco Bowl",
        price: 12.5,
        macros: { cal: 610, protein: 44, carbs: 62, fat: 19 },
        ingredients: ["0.35 lb ground turkey", "1 cup jasmine rice", "0.5 cup black beans", "0.25 cup salsa", "0.5 ea avocado"].map(ing),
      },
      {
        id: "meal_steak_potato",
        description: "Grilled sirloin with a roasted sweet potato and garlicky green beans.",
        allergens: [],
        photo: "",
        weeklyLimit: 10,
        name: "Sirloin & Sweet Potato",
        price: 15,
        macros: { cal: 620, protein: 46, carbs: 52, fat: 22 },
        ingredients: ["0.4 lb sirloin steak", "1 ea sweet potato", "1 cup green beans"].map(ing),
      },
      {
        id: "meal_salmon",
        description: "Lemon-pepper salmon on fluffy quinoa with roasted asparagus.",
        allergens: ["fish"],
        photo: "",
        weeklyLimit: 12,
        name: "Lemon Salmon & Quinoa",
        price: 16,
        macros: { cal: 580, protein: 40, carbs: 45, fat: 24 },
        ingredients: ["0.35 lb salmon", "0.75 cup quinoa", "1 cup asparagus", "0.5 ea lemon"].map(ing),
      },
      {
        id: "meal_shrimp_pasta",
        description: "Cajun shrimp tossed in a light alfredo with high-protein pasta and spinach.",
        allergens: ["shellfish", "milk", "wheat"],
        photo: "",
        weeklyLimit: null,
        name: "Cajun Shrimp Pasta (lite)",
        price: 13.5,
        macros: { cal: 560, protein: 38, carbs: 66, fat: 14 },
        ingredients: ["0.3 lb shrimp", "3 oz protein pasta", "0.5 cup light alfredo", "1 cup spinach"].map(ing),
      },
      {
        id: "meal_oats",
        description: "Overnight oats with Greek yogurt, a scoop of protein and mixed berries.",
        allergens: ["milk"],
        photo: "",
        weeklyLimit: null,
        name: "Protein Overnight Oats",
        price: 7,
        macros: { cal: 420, protein: 32, carbs: 50, fat: 10 },
        ingredients: ["0.75 cup rolled oats", "1 ea protein scoop", "0.5 cup greek yogurt", "0.5 cup berries"].map(ing),
      },
    ];

    const customers = [
      { id: "cust_maya", name: "Maya Johnson", phone: "(713) 555-0142", address: "4410 Westheimer Rd, Houston TX", targets: { cal: 1900, protein: 140, carbs: 190, fat: 60 } },
      { id: "cust_derrick", name: "Derrick Allen", phone: "(832) 555-0198", address: "1200 Main St Apt 5B, Houston TX", targets: { cal: 2800, protein: 200, carbs: 300, fat: 85 } },
      { id: "cust_priya", name: "Priya Patel", phone: "(281) 555-0117", address: "88 Bellaire Blvd, Bellaire TX", targets: { cal: 1700, protein: 120, carbs: 170, fat: 55 } },
      { id: "cust_marcus", name: "Marcus Reed", phone: "(713) 555-0170", address: "", targets: { cal: 3000, protein: 210, carbs: 320, fat: 90 } },
      { id: "cust_tasha", name: "Tasha Williams", phone: "(832) 555-0133", address: "2525 Kirby Dr, Houston TX", targets: { cal: 2000, protein: 150, carbs: 200, fat: 65 } },
    ];

    const weekOf = L.orderWindow(todayISO, settings).weekOf;
    const day = (n) => L.addDays(weekOf, n);
    const order = (id, customerId, createdOn, items, fulfillment, notes, lateFee, extra) => ({
      id,
      customerId,
      createdOn,
      weekOf,
      items,
      fulfillment,
      notes: notes || "",
      lateFee: lateFee || 0,
      status: "confirmed",
      source: "manager",
      paymentMethod: "",
      paid: false,
      ...(extra || {}),
    });

    const orders = [
      order("ord_1001", "cust_maya", day(0), [{ mealId: "meal_chicken_rice", qty: 3 }, { mealId: "meal_salmon", qty: 2 }, { mealId: "meal_oats", qty: 5 }], "delivery", "Leave at front door"),
      order("ord_1002", "cust_derrick", day(1), [{ mealId: "meal_steak_potato", qty: 5 }, { mealId: "meal_turkey_bowl", qty: 5 }], "delivery", "Extra rice if possible"),
      order("ord_1003", "cust_priya", day(1), [{ mealId: "meal_salmon", qty: 3 }, { mealId: "meal_shrimp_pasta", qty: 2 }], "delivery", "No spice on shrimp"),
      order("ord_1004", "cust_marcus", day(2), [{ mealId: "meal_chicken_rice", qty: 7 }, { mealId: "meal_oats", qty: 7 }], "pickup", ""),
      order("ord_1005", "cust_tasha", day(4), [{ mealId: "meal_turkey_bowl", qty: 3 }, { mealId: "meal_chicken_rice", qty: 2 }], "delivery", "Friday order", settings.lateFee),
      // An online order waiting for approval, so the "New orders" inbox has something to show.
      order("web_demo01", "cust_jordan", day(2), [{ mealId: "meal_chicken_rice", qty: 3 }, { mealId: "meal_oats", qty: 3 }], "delivery", "Can you do extra broccoli?", 0, {
        status: "pending",
        source: "online",
        paymentMethod: "cashapp",
        quotedTotal: 62,
        contact: { name: "Jordan Brooks", phone: "(281) 555-0188", phoneDigits: "2815550188", address: "900 Gessner Rd, Houston TX" },
      }),
    ];
    customers.push({ id: "cust_jordan", name: "Jordan Brooks", phone: "(281) 555-0188", address: "900 Gessner Rd, Houston TX", targets: { cal: 2400, protein: 180, carbs: 240, fat: 75 } });

    // A weekly plan, so the plans list has something to show.
    const plans = [{
      id: "plan_demo01", customerId: "cust_maya", items: [{ mealId: "meal_chicken_rice", qty: 3 }, { mealId: "meal_salmon", qty: 2 }, { mealId: "meal_oats", qty: 5 }],
      fulfillment: "delivery", paymentMethod: "zelle", notes: "Leave at front door", status: "active", skipWeeks: [], lastWeek: weekOf, startedFrom: "ord_1001",
      contact: { name: "Maya Johnson", phone: "(713) 555-0142", phoneDigits: "7135550142", address: "4410 Westheimer Rd, Houston TX" },
    }];
    orders[0].planId = "plan_demo01";

    return { version: 1, settings, menu, customers, orders, plans };
  }

  root.FuelSeed = { buildDemoData, defaultSettings };
})(typeof self !== "undefined" ? self : this);
