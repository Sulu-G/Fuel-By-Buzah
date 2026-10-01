/*
 * Fuel by Buzah — food recall helpers (plain-language health risks).
 * Works in the browser (window.FuelRecalls) and in Node (require) for tests.
 *
 * The nightly check itself runs in the database (supabase/v5_recall_checks.sql):
 * it downloads official FDA (and, when reachable, USDA FSIS) recalls and stores
 * the ones that match your menu. This file explains them in plain language.
 *
 * Health information is summarized from the CDC and FDA. It's general
 * information for deciding what to buy, not medical advice.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FuelRecalls = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Keys must match fuel_private.recall_hazard() in the SQL. */
  const HAZARDS = {
    listeria: {
      label: "Listeria",
      risk: "Listeria can cause listeriosis: fever, muscle aches and tiredness, sometimes with headache, stiff neck, confusion or loss of balance. Symptoms usually start within 2 weeks but can take up to 10 weeks. It is most dangerous during pregnancy (miscarriage, stillbirth, or a seriously ill newborn), for adults 65 and older, and for people with weakened immune systems. It can grow in the fridge and spread to other foods and surfaces.",
      severe: true,
    },
    salmonella: {
      label: "Salmonella",
      risk: "Salmonella causes diarrhea, fever and stomach cramps, usually starting 6 hours to 6 days after eating and lasting 4–7 days. Most people recover without treatment, but it can be severe for children under 5, adults 65 and older, and people with weakened immune systems, and it can spread to the bloodstream.",
      severe: true,
    },
    ecoli: {
      label: "E. coli (STEC)",
      risk: "Shiga toxin-producing E. coli causes severe stomach cramps, diarrhea (often bloody) and vomiting, usually 3–4 days after eating. About 5–10% of people diagnosed develop hemolytic uremic syndrome (HUS), a type of kidney failure, most often young children and older adults.",
      severe: true,
    },
    botulism: {
      label: "Botulism",
      risk: "Botulism is a rare, life-threatening illness caused by a toxin. It causes double or blurred vision, drooping eyelids, slurred speech, trouble swallowing or breathing, and muscle weakness, usually 12–36 hours after eating. It is a medical emergency. Do not open or taste the product.",
      severe: true,
    },
    hepatitis_a: {
      label: "Hepatitis A",
      risk: "Hepatitis A is a liver infection. Symptoms include tiredness, nausea, stomach pain, dark urine and yellow skin or eyes, starting 15–50 days after eating. If someone ate the product in the last 2 weeks and isn't vaccinated, a vaccine or treatment from a doctor can prevent illness.",
      severe: true,
    },
    cyclospora: {
      label: "Cyclospora",
      risk: "Cyclospora is a parasite that causes watery diarrhea, loss of appetite, cramps, bloating and tiredness, usually about a week after eating. Without treatment it can last weeks. It is usually linked to fresh produce, and washing does not reliably remove it.",
      severe: false,
    },
    norovirus: {
      label: "Norovirus",
      risk: "Norovirus causes vomiting, diarrhea, nausea and stomach pain 12–48 hours after eating, usually lasting 1–3 days. It spreads very easily between people and through food handling.",
      severe: false,
    },
    allergen: {
      label: "Undeclared allergen",
      risk: "The label is missing an allergen (the reason below says which one). For people allergic to it, eating it can cause a serious or life-threatening reaction (anaphylaxis). For everyone else the food is safe. It matters if any customer has that allergy.",
      severe: false,
    },
    foreign: {
      label: "Foreign material",
      risk: "Pieces of metal, plastic, glass or similar material may be in the product. They can cause choking, cuts in the mouth or throat, or broken teeth.",
      severe: false,
    },
    heavy_metals: {
      label: "Lead / heavy metals",
      risk: "The product has elevated levels of lead or another heavy metal. Short-term exposure usually causes no symptoms, but repeated exposure can harm children's brain development and affect adults' kidneys and blood pressure.",
      severe: false,
    },
    process: {
      label: "Safety-control problem",
      risk: "The product was made without required safety controls, for example without inspection, at the wrong temperature, or under-processed. The health risk depends on the problem. Follow the recall notice.",
      severe: false,
    },
    other: {
      label: "See recall notice",
      risk: "Read the reason below and the official notice for the specific risk.",
      severe: false,
    },
  };

  /** FDA recall classes (USDA uses the same three levels). */
  const CLASSES = {
    I: { label: "Class I", tone: "bad", meaning: "Most serious: a reasonable chance the product will cause serious health problems or death." },
    II: { label: "Class II", tone: "warn", meaning: "May cause temporary or medically reversible health problems. Serious problems are unlikely." },
    III: { label: "Class III", tone: "muted", meaning: "Not likely to cause health problems, for example a labeling issue." },
  };

  const WHAT_TO_DO = [
    "Only the products described are recalled. Compare the brand, size, UPC and lot or best-by codes on the package. Other brands of the same food are fine.",
    "Don't buy it. If you already have it, don't use it: throw it away or return it to the store for a refund.",
    "Clean and sanitize fridge shelves, containers, cutting boards and counters it touched (especially for Listeria).",
    "If someone got sick after eating it, contact a doctor and mention the recall.",
  ];

  const SOURCES = {
    fda: { name: "FDA", url: "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts" },
    usda: { name: "USDA FSIS", url: "https://www.fsis.usda.gov/recalls" },
  };

  /** "Class I", "High - Class I", "I" → "I" | "II" | "III" | "". */
  function classKey(classification) {
    const m = String(classification || "").match(/class\s*(iii|ii|i)\b/i) || String(classification || "").match(/^\s*(iii|ii|i)\s*$/i);
    return m ? m[1].toUpperCase() : "";
  }

  const hazardInfo = (key) => HAZARDS[key] || HAZARDS.other;
  const classInfo = (classification) => CLASSES[classKey(classification)] || null;
  const norm = (s) => String(s || "").trim().toLowerCase();

  /**
   * Splits alerts for display.
   * @param alerts  rows from store.getRecalls()
   * @param shoppingItems item names on this week's shopping list
   * @returns { direct, related, hidden, onList:Set<ingredient>, byIngredient:Map }
   */
  function organize(alerts, shoppingItems = []) {
    const list = new Set(shoppingItems.map(norm));
    const rank = (a) => [a.dismissed ? 1 : 0, list.has(norm(a.ingredient)) ? 0 : 1, { I: 0, II: 1, III: 2 }[classKey(a.classification)] ?? 3];
    const cmp = (a, b) => {
      const ra = rank(a), rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      return String(b.recallDate || "").localeCompare(String(a.recallDate || ""));
    };
    const visible = alerts.filter((a) => !a.dismissed);
    const direct = visible.filter((a) => a.match !== "related").sort(cmp);
    const related = visible.filter((a) => a.match === "related").sort(cmp);
    const hidden = alerts.filter((a) => a.dismissed).sort(cmp);
    const onList = new Set(direct.filter((a) => list.has(norm(a.ingredient))).map((a) => norm(a.ingredient)));
    const byIngredient = new Map();
    for (const a of direct) {
      const k = norm(a.ingredient);
      if (!byIngredient.has(k)) byIngredient.set(k, []);
      byIngredient.get(k).push(a);
    }
    return { direct, related, hidden, onList, byIngredient };
  }

  /** Plain-language Texas line. */
  function texasLine(affectsTx) {
    if (affectsTx === "yes") return "Sold in Texas";
    if (affectsTx === "no") return "Texas not listed";
    return "Distribution unclear";
  }

  /** When the next automatic check runs (8pm Central), as a friendly label. */
  function nextCheckLabel(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", hour12: false }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour").value) % 24;
    const wd = parts.find((p) => p.type === "weekday").value;
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const tonight = hour < 20;
    const day = tonight ? wd : days[(days.indexOf(wd) + 1) % 7];
    const when = tonight ? "tonight" : day === "Fri" ? "Friday" : "tomorrow";
    return `${when} at 8 PM Central${day === "Fri" ? " (full pre-shopping summary)" : ""}`;
  }

  /**
   * Example alerts for the browser-only demo, built from the demo menu.
   * The firm names are made up and every alert is marked as an example.
   */
  function sampleAlerts(today = new Date()) {
    const d = (n) => new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);
    return [
      { id: "fda:F-DEMO-1", ingredient: "spinach", match: "direct", source: "fda", recallNumber: "F-DEMO-1", sample: true,
        product: "Example Farms Fresh Baby Spinach, 10 oz clamshell, UPC 0 00000 00001 0", firm: "Example Farms (sample)",
        reason: "Potential contamination with Listeria monocytogenes.", hazard: "listeria", classification: "Class I",
        status: "Ongoing", recallDate: d(3), distribution: "Distributed in TX, OK and LA through retail stores.", affectsTx: "yes",
        codeInfo: "Best if used by dates 10/04 through 10/09; lot codes beginning with EX24.", url: "", dismissed: false },
      { id: "fda:F-DEMO-2", ingredient: "chicken breast", match: "direct", source: "fda", recallNumber: "F-DEMO-2", sample: true,
        product: "Sample Brand Boneless Skinless Chicken Breast Strips, frozen, 2 lb bag", firm: "Sample Poultry Co. (sample)",
        reason: "Products may be contaminated with Salmonella.", hazard: "salmonella", classification: "Class II",
        status: "Ongoing", recallDate: d(9), distribution: "Nationwide", affectsTx: "yes",
        codeInfo: "Lot 2409-A and 2409-B, best by 03/2027.", url: "", dismissed: false },
      { id: "fda:F-DEMO-3", ingredient: "berries", match: "related", source: "fda", recallNumber: "F-DEMO-3", sample: true,
        product: "Demo Snacks Mixed Berry Yogurt Bars, 6 ct", firm: "Demo Snacks (sample)",
        reason: "Undeclared peanuts.", hazard: "allergen", classification: "Class I",
        status: "Ongoing", recallDate: d(5), distribution: "CA, NV, AZ", affectsTx: "no", codeInfo: "All lots.", url: "", dismissed: false },
    ];
  }

  return { HAZARDS, CLASSES, WHAT_TO_DO, SOURCES, classKey, hazardInfo, classInfo, organize, texasLine, nextCheckLabel, sampleAlerts };
});
