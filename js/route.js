/**
 * Fuel by Buzah — delivery route planning.
 *
 *  - geocodeAddress():   address → lat/lng (OpenStreetMap Nominatim, free)
 *  - fetchMatrix():      real driving times between every pair of points (OSRM)
 *  - solveOpenRoute():   best stop order, starting at the driver and ending at
 *                        the last stop. Exact up to 15 stops, multi-start
 *                        2-opt + or-opt local search beyond that.
 *  - planRoute():        ties it together, with a straight-line fallback if the
 *                        routing server is unavailable.
 *  - googleMapsLegs():   turn-by-turn hand-off links for the Google Maps app.
 *
 * Network calls take an injectable `fetchFn`, so everything is unit-testable.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FuelRoute = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const NOMINATIM = "https://nominatim.openstreetmap.org/search";
  const OSRM = "https://router.project-osrm.org";
  const EXACT_LIMIT = 15; // stops solved exactly (Held–Karp); above this, multi-start local search
  const FALLBACK_SPEED_MPS = 11.2; // ~25 mph average city driving
  const ROAD_FACTOR = 1.3; // roads are longer than straight lines

  // ---------- Addresses ----------

  function normalizeAddress(a) {
    return String(a || "").toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  }

  /** Queries to try, most specific first. Apartment/unit numbers often confuse geocoders. */
  function addressVariants(a) {
    const base = String(a || "").trim();
    const noUnit = base.replace(/\s*(,\s*)?\b(apt|apartment|unit|suite|ste|bldg|building|#)\s*\.?\s*[\w-]+/gi, "").replace(/\s+,/g, ",").trim();
    return [...new Set([base, noUnit].filter((x) => x.length >= 5))];
  }

  async function geocodeAddress(address, fetchFn) {
    for (const q of addressVariants(address)) {
      const url = `${NOMINATIM}?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
      const res = await fetchFn(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`Address lookup failed (${res.status})`);
      const list = await res.json();
      if (Array.isArray(list) && list.length) {
        const lat = Number(list[0].lat);
        const lng = Number(list[0].lon);
        if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, label: list[0].display_name || q };
      }
    }
    return null;
  }

  // ---------- Distances ----------

  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** Estimated matrix when the routing server can't be reached. */
  function fallbackMatrix(points) {
    const distances = points.map((a) => points.map((b) => haversineMeters(a, b) * ROAD_FACTOR));
    const durations = distances.map((row) => row.map((m) => m / FALLBACK_SPEED_MPS));
    return { durations, distances, source: "estimate" };
  }

  const coordString = (points) => points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");

  async function fetchMatrix(points, fetchFn) {
    const res = await fetchFn(`${OSRM}/table/v1/driving/${coordString(points)}?annotations=duration,distance`);
    if (!res.ok) throw new Error(`Routing server error (${res.status})`);
    const data = await res.json();
    if (data.code !== "Ok" || !Array.isArray(data.durations)) throw new Error(data.message || "Routing server error");
    // Unreachable pairs come back as null; treat them as very far.
    const fix = (m) => m.map((row) => row.map((v) => (v == null ? 1e9 : v)));
    return { durations: fix(data.durations), distances: fix(data.distances || fallbackMatrix(points).distances), source: "osrm" };
  }

  async function fetchRouteLine(points, fetchFn) {
    const res = await fetchFn(`${OSRM}/route/v1/driving/${coordString(points)}?overview=full&geometries=geojson`);
    if (!res.ok) throw new Error(`Routing server error (${res.status})`);
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes || !data.routes.length) throw new Error("No route found");
    const r = data.routes[0];
    return {
      line: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      distance: r.distance,
      duration: r.duration,
      legs: (r.legs || []).map((l) => ({ distance: l.distance, duration: l.duration })),
    };
  }

  // ---------- Solver ----------

  /** Cost of visiting `order` (indexes into cost) starting from node `start`. */
  function pathCost(cost, start, order) {
    let total = 0;
    let prev = start;
    for (const i of order) {
      total += cost[prev][i];
      prev = i;
    }
    return total;
  }

  /** Exact open-path TSP via Held–Karp dynamic programming. */
  function solveExact(cost, start, nodes) {
    const n = nodes.length;
    if (n === 0) return [];
    const FULL = 1 << n;
    const dp = new Float64Array(FULL * n).fill(Infinity);
    const parent = new Int32Array(FULL * n).fill(-1);
    for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = cost[start][nodes[j]];
    for (let mask = 1; mask < FULL; mask++) {
      for (let j = 0; j < n; j++) {
        if (!(mask & (1 << j))) continue;
        const cur = dp[mask * n + j];
        if (cur === Infinity) continue;
        for (let k = 0; k < n; k++) {
          if (mask & (1 << k)) continue;
          const next = mask | (1 << k);
          const v = cur + cost[nodes[j]][nodes[k]];
          if (v < dp[next * n + k]) {
            dp[next * n + k] = v;
            parent[next * n + k] = j;
          }
        }
      }
    }
    let best = Infinity;
    let last = -1;
    for (let j = 0; j < n; j++) {
      if (dp[(FULL - 1) * n + j] < best) {
        best = dp[(FULL - 1) * n + j];
        last = j;
      }
    }
    const order = [];
    let mask = FULL - 1;
    while (last !== -1) {
      order.push(nodes[last]);
      const p = parent[mask * n + last];
      mask ^= 1 << last;
      last = p;
    }
    return order.reverse();
  }

  /** Improve a tour with 2-opt (reverse a segment) and or-opt (move 1–3 stops) until nothing helps. */
  function localSearch(cost, start, initial) {
    const order = initial.slice();
    let bestCost = pathCost(cost, start, order);
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 100) {
      improved = false;
      for (let i = 0; i < order.length - 1; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const cand = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
          const c = pathCost(cost, start, cand);
          if (c < bestCost - 1e-9) {
            order.splice(0, order.length, ...cand);
            bestCost = c;
            improved = true;
          }
        }
      }
      for (let len = 1; len <= 3; len++) {
        for (let i = 0; i + len <= order.length; i++) {
          const seg = order.slice(i, i + len);
          const rest = order.slice(0, i).concat(order.slice(i + len));
          for (let p = 0; p <= rest.length; p++) {
            if (p === i) continue;
            for (const piece of len > 1 ? [seg, seg.slice().reverse()] : [seg]) {
              const cand = rest.slice(0, p).concat(piece, rest.slice(p));
              const c = pathCost(cost, start, cand);
              if (c < bestCost - 1e-9) {
                order.splice(0, order.length, ...cand);
                bestCost = c;
                improved = true;
              }
            }
          }
        }
      }
    }
    return { order, cost: bestCost };
  }

  /**
   * Multi-start local search: begin from the nearest-neighbor tour plus several
   * shuffled tours (seeded, so results are repeatable) and keep the best.
   * Handles one-way (asymmetric) driving times.
   */
  function solveHeuristic(cost, start, nodes, restarts = 24) {
    const left = new Set(nodes);
    const nn = [];
    let cur = start;
    while (left.size) {
      let best = null;
      for (const k of left) if (best === null || cost[cur][k] < cost[cur][best]) best = k;
      nn.push(best);
      left.delete(best);
      cur = best;
    }
    let best = localSearch(cost, start, nn);
    let seed = 12345;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let r = 0; r < restarts; r++) {
      const shuffled = nodes.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const cand = localSearch(cost, start, shuffled);
      if (cand.cost < best.cost - 1e-9) best = cand;
    }
    return best.order;
  }

  /**
   * Best order to visit every node in `nodes`, starting at `start`, ending anywhere.
   * `cost` is a square matrix (seconds). Returns the ordered list of node indexes.
   */
  function solveOpenRoute(cost, start, nodes) {
    return nodes.length <= EXACT_LIMIT ? solveExact(cost, start, nodes) : solveHeuristic(cost, start, nodes);
  }

  // ---------- Orchestration ----------

  /**
   * start: {lat,lng} or null (then the solver also picks the best first stop).
   * stops: [{lat,lng,...}]
   * Returns { order: [stop indexes], distance, duration, line, legs, estimated }.
   */
  async function planRoute(start, stops, fetchFn) {
    if (!stops.length) return { order: [], distance: 0, duration: 0, line: [], legs: [], estimated: false };
    const points = start ? [start, ...stops] : stops;
    let matrix;
    try {
      matrix = await fetchMatrix(points, fetchFn);
    } catch (_) {
      matrix = fallbackMatrix(points);
    }

    let orderPoints;
    if (start) {
      const nodes = stops.map((_, i) => i + 1);
      orderPoints = solveOpenRoute(matrix.durations, 0, nodes);
    } else {
      // No start: add a free "anywhere" node 0 so the solver picks the best first stop.
      const n = stops.length;
      const cost = [new Array(n + 1).fill(0), ...matrix.durations.map((row) => [0, ...row])];
      orderPoints = solveOpenRoute(cost, 0, stops.map((_, i) => i + 1)).map((i) => i - 1);
    }
    const order = start ? orderPoints.map((i) => i - 1) : orderPoints;

    const ordered = order.map((i) => stops[i]);
    const seq = start ? [start, ...ordered] : ordered;
    const idx = start ? [0, ...orderPoints] : orderPoints;
    const sumOf = (m) => idx.slice(1).reduce((s, j, k) => s + m[idx[k]][j], 0);

    let line = seq.map((p) => [p.lat, p.lng]);
    let distance = sumOf(matrix.distances);
    let duration = sumOf(matrix.durations);
    let legs = idx.slice(1).map((j, k) => ({ distance: matrix.distances[idx[k]][j], duration: matrix.durations[idx[k]][j] }));
    let estimated = matrix.source !== "osrm";
    if (!estimated && seq.length > 1) {
      try {
        const r = await fetchRouteLine(seq, fetchFn);
        line = r.line;
        distance = r.distance;
        duration = r.duration;
        if (r.legs.length === legs.length) legs = r.legs;
      } catch (_) {
        /* keep matrix totals and straight lines */
      }
    }
    return { order, distance, duration, line, legs, estimated };
  }

  // ---------- Google Maps hand-off ----------

  /**
   * Split ordered stop addresses into Google Maps directions links.
   * Google allows 9 waypoints per link in a desktop browser but only 3 on mobile.
   * The first leg starts from the phone's current location.
   */
  function googleMapsLegs(addresses, maxWaypoints) {
    const per = Math.max(1, maxWaypoints) + 1; // waypoints + destination
    const legs = [];
    for (let i = 0; i < addresses.length; i += per) {
      const chunk = addresses.slice(i, i + per);
      const params = new URLSearchParams({ api: "1", travelmode: "driving" });
      if (i > 0) params.set("origin", addresses[i - 1]);
      params.set("destination", chunk[chunk.length - 1]);
      if (chunk.length > 1) params.set("waypoints", chunk.slice(0, -1).join("|"));
      legs.push({ from: i + 1, to: i + chunk.length, url: `https://www.google.com/maps/dir/?${params.toString()}` });
    }
    return legs;
  }

  const metersToMiles = (m) => m / 1609.344;

  return {
    normalizeAddress,
    addressVariants,
    geocodeAddress,
    haversineMeters,
    fallbackMatrix,
    fetchMatrix,
    fetchRouteLine,
    pathCost,
    solveExact,
    solveHeuristic,
    solveOpenRoute,
    planRoute,
    googleMapsLegs,
    metersToMiles,
    EXACT_LIMIT,
  };
});
