const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const R = require("../js/recalls.js");

const sql = fs.readFileSync(path.join(__dirname, "../supabase/v5_recall_checks.sql"), "utf8");

test("every hazard the database can return has a plain-language explanation", () => {
  const hazardFn = sql.slice(sql.indexOf("function fuel_private.recall_hazard"), sql.indexOf("function fuel_private.hazard_short"));
  const keys = [...hazardFn.matchAll(/then '([a-z_]+)'/g)].map((m) => m[1]).concat("other");
  assert.ok(keys.length >= 10);
  for (const k of keys) {
    assert.ok(R.HAZARDS[k], `missing hazard ${k}`);
    assert.ok(R.HAZARDS[k].risk.length > 40, `thin explanation for ${k}`);
  }
  assert.equal(R.hazardInfo("nonsense"), R.HAZARDS.other);
});

test("recall classes are read from FDA and USDA wording", () => {
  assert.equal(R.classKey("Class I"), "I");
  assert.equal(R.classKey("Class II"), "II");
  assert.equal(R.classKey("Class III"), "III");
  assert.equal(R.classKey("High - Class I"), "I");
  assert.equal(R.classKey("Low - Class II"), "II");
  assert.equal(R.classKey(""), "");
  assert.equal(R.classInfo("Class I").tone, "bad");
  assert.equal(R.classInfo("Not Yet Classified"), null);
});

test("organize: direct vs related, hidden, on-list first, Class I first", () => {
  const a = (id, ingredient, extra = {}) => ({ id, ingredient, match: "direct", classification: "Class II", recallDate: "2026-09-01", dismissed: false, ...extra });
  const alerts = [
    a("1", "spinach", { classification: "Class I" }),
    a("2", "Chicken Breast"),
    a("3", "chicken breast", { classification: "Class I" }),
    a("4", "berries", { match: "related" }),
    a("5", "garlic", { dismissed: true }),
  ];
  const g = R.organize(alerts, ["chicken breast", "jasmine rice"]);
  assert.deepEqual(g.direct.map((x) => x.id), ["3", "2", "1"]);
  assert.deepEqual(g.related.map((x) => x.id), ["4"]);
  assert.deepEqual(g.hidden.map((x) => x.id), ["5"]);
  assert.deepEqual([...g.onList], ["chicken breast"]);
  assert.equal(g.byIngredient.get("chicken breast").length, 2);
  assert.equal(g.byIngredient.has("garlic"), false, "hidden alerts don't flag the shopping list");
  assert.equal(g.byIngredient.has("berries"), false, "related alerts don't flag the shopping list");
});

test("Texas line and next-check label", () => {
  assert.equal(R.texasLine("yes"), "Sold in Texas");
  assert.equal(R.texasLine("no"), "Texas not listed");
  assert.equal(R.texasLine("unknown"), "Distribution unclear");
  // Thu Oct 1 2026, 3pm Central → tonight
  assert.equal(R.nextCheckLabel(new Date("2026-10-01T20:00:00Z")), "tonight at 8 PM Central");
  // Thu 9pm Central → Friday summary
  assert.match(R.nextCheckLabel(new Date("2026-10-02T02:00:00Z")), /^Friday at 8 PM Central \(full pre-shopping summary\)$/);
  // Fri 10am Central → tonight, with summary note
  assert.match(R.nextCheckLabel(new Date("2026-10-02T15:00:00Z")), /^tonight .*summary/);
});

test("demo examples are clearly marked and use made-up firms", () => {
  const s = R.sampleAlerts(new Date("2026-10-01T12:00:00Z"));
  assert.ok(s.length >= 2);
  for (const x of s) {
    assert.equal(x.sample, true);
    assert.match(x.firm, /\(sample\)/);
    assert.ok(R.HAZARDS[x.hazard]);
  }
});
