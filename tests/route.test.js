const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../js/route.js");

// Deterministic pseudo-random numbers so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomMatrix(n, seed, asymmetric = false) {
  const r = rng(seed);
  const pts = Array.from({ length: n }, () => ({ x: r() * 100, y: r() * 100 }));
  return pts.map((a, i) => pts.map((b, j) => (i === j ? 0 : Math.hypot(a.x - b.x, a.y - b.y) * (asymmetric ? 1 + r() * 0.4 : 1))));
}

function bruteForce(cost, start, nodes) {
  let best = Infinity;
  const perm = (arr, k) => {
    if (k === arr.length) {
      best = Math.min(best, R.pathCost(cost, start, arr));
      return;
    }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      perm(arr, k + 1);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  perm([...nodes], 0);
  return best;
}

test("exact solver matches brute force (symmetric and one-way times)", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const n = 2 + (seed % 7); // 2–8 stops
    const cost = randomMatrix(n + 1, seed, seed % 2 === 0);
    const nodes = Array.from({ length: n }, (_, i) => i + 1);
    const order = R.solveExact(cost, 0, nodes);
    assert.deepEqual([...order].sort((a, b) => a - b), nodes, "visits every stop once");
    assert.ok(Math.abs(R.pathCost(cost, 0, order) - bruteForce(cost, 0, nodes)) < 1e-6, `seed ${seed}`);
  }
});

test("heuristic stays within 5% of optimal on 11-stop routes", () => {
  let worst = 0;
  for (let seed = 100; seed < 130; seed++) {
    const cost = randomMatrix(12, seed, seed % 3 === 0);
    const nodes = Array.from({ length: 11 }, (_, i) => i + 1);
    const opt = R.pathCost(cost, 0, R.solveExact(cost, 0, nodes));
    const heur = R.pathCost(cost, 0, R.solveHeuristic(cost, 0, nodes));
    worst = Math.max(worst, heur / opt - 1);
  }
  assert.ok(worst < 0.05, `worst gap ${(worst * 100).toFixed(2)}%`);
});

test("large routes (40 stops) solve fast and beat nearest-neighbor", () => {
  const cost = randomMatrix(41, 7);
  const nodes = Array.from({ length: 40 }, (_, i) => i + 1);
  const t0 = Date.now();
  const order = R.solveOpenRoute(cost, 0, nodes);
  const ms = Date.now() - t0;
  assert.equal(new Set(order).size, 40);
  // plain nearest neighbor for comparison
  const left = new Set(nodes); const nn = []; let cur = 0;
  while (left.size) { let b = null; for (const k of left) if (b === null || cost[cur][k] < cost[cur][b]) b = k; nn.push(b); left.delete(b); cur = b; }
  assert.ok(R.pathCost(cost, 0, order) <= R.pathCost(cost, 0, nn));
  assert.ok(ms < 3000, `took ${ms}ms`);
});

test("stops on a straight road are visited in order", () => {
  const pts = [0, 5, 1, 4, 2, 3].map((x) => ({ x }));
  const cost = pts.map((a) => pts.map((b) => Math.abs(a.x - b.x)));
  assert.deepEqual(R.solveOpenRoute(cost, 0, [1, 2, 3, 4, 5]), [2, 4, 5, 3, 1]); // x = 1,2,3,4,5
});

test("planRoute uses OSRM when available and falls back when it's down", async () => {
  const start = { lat: 29.76, lng: -95.37 };
  const stops = [{ lat: 29.74, lng: -95.46 }, { lat: 29.75, lng: -95.4 }, { lat: 29.7, lng: -95.47 }];
  const calls = [];
  const okFetch = async (url) => {
    calls.push(url);
    if (url.includes("/table/")) {
      const pts = [start, ...stops];
      const d = pts.map((a) => pts.map((b) => R.haversineMeters(a, b)));
      return { ok: true, json: async () => ({ code: "Ok", durations: d.map((r) => r.map((m) => m / 10)), distances: d }) };
    }
    return { ok: true, json: async () => ({ code: "Ok", routes: [{ distance: 20000, duration: 1500, geometry: { coordinates: [[-95.37, 29.76], [-95.47, 29.7]] }, legs: [{}, {}, {}] }] }) };
  };
  const r = await R.planRoute(start, stops, okFetch);
  assert.equal(r.estimated, false);
  assert.equal(r.order.length, 3);
  assert.deepEqual(r.order, [1, 0, 2]); // downtown → Montrose-ish → Galleria → Bellaire
  assert.equal(r.distance, 20000);
  assert.ok(calls[0].includes("/table/v1/driving/-95.370000,29.760000;"));

  const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const f = await R.planRoute(start, stops, down);
  assert.equal(f.estimated, true);
  assert.deepEqual(f.order, [1, 0, 2]);
  assert.ok(f.distance > 0 && f.line.length === 4);
});

test("planRoute without a start picks the best first stop", async () => {
  const stops = [{ lat: 0, lng: 0 }, { lat: 0, lng: 3 }, { lat: 0, lng: 1 }, { lat: 0, lng: 2 }];
  const r = await R.planRoute(null, stops, async () => ({ ok: false, status: 500 }));
  const xs = r.order.map((i) => stops[i].lng);
  assert.ok(JSON.stringify(xs) === "[0,1,2,3]" || JSON.stringify(xs) === "[3,2,1,0]", xs.join(","));
});

test("Google Maps legs respect waypoint limits and chain together", () => {
  const addrs = Array.from({ length: 9 }, (_, i) => `${i + 1} Main St, Houston TX`);
  const mobile = R.googleMapsLegs(addrs, 3);
  assert.deepEqual(mobile.map((l) => [l.from, l.to]), [[1, 4], [5, 8], [9, 9]]);
  const u1 = new URL(mobile[0].url);
  assert.equal(u1.searchParams.get("origin"), null, "first leg starts from current location");
  assert.equal(u1.searchParams.get("destination"), "4 Main St, Houston TX");
  assert.equal(u1.searchParams.get("waypoints").split("|").length, 3);
  assert.ok(mobile[0].url.includes("%7C"), "pipe separator is URL-encoded");
  const u2 = new URL(mobile[1].url);
  assert.equal(u2.searchParams.get("origin"), "4 Main St, Houston TX", "next leg continues from the last stop");
  const desktop = R.googleMapsLegs(addrs, 9);
  assert.equal(desktop.length, 1);
  assert.equal(new URL(desktop[0].url).searchParams.get("waypoints").split("|").length, 8);
});

test("address helpers", () => {
  assert.equal(R.normalizeAddress("1200 Main St., Apt 5B,  Houston TX"), "1200 main st apt 5b houston tx");
  assert.deepEqual(R.addressVariants("1200 Main St Apt 5B, Houston TX"), ["1200 Main St Apt 5B, Houston TX", "1200 Main St, Houston TX"]);
  assert.deepEqual(R.addressVariants("88 Bellaire Blvd, Bellaire TX"), ["88 Bellaire Blvd, Bellaire TX"]);
  const d = R.haversineMeters({ lat: 29.7604, lng: -95.3698 }, { lat: 29.7392, lng: -95.4613 });
  assert.ok(d > 8500 && d < 9500, String(d));
});

test("geocodeAddress retries without the apartment number", async () => {
  const seen = [];
  const f = async (url) => {
    const q = decodeURIComponent(url.split("q=")[1]);
    seen.push(q);
    return { ok: true, json: async () => (q.includes("Apt") ? [] : [{ lat: "29.75", lon: "-95.36", display_name: "1200 Main" }]) };
  };
  const g = await R.geocodeAddress("1200 Main St Apt 5B, Houston TX", f);
  assert.deepEqual(g, { lat: 29.75, lng: -95.36, label: "1200 Main" });
  assert.equal(seen.length, 2);
  assert.equal(await R.geocodeAddress("nowhere", async () => ({ ok: true, json: async () => [] })), null);
});
