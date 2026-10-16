/**
 * Does the on-device router actually work?
 *
 * Mirrors the Python verification: decode the bundled graphs, route across
 * Central, and check the result is sane. Runs in plain Node, so it works without
 * a device.
 *
 * This deliberately does NOT import pedestrian-router.js: that module uses
 * `require()` for the graph chunks, which Node's ESM resolver does not accept.
 * The algorithms below are the same ones, and `expo export` is what proves the
 * module graph resolves.
 *
 * Run:  node tests/on-device-router.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import packedCentral from '../src/data/network/central.js';
import packedTst from '../src/data/network/tst.js';
import packedCsw from '../src/data/network/cheungShaWan.js';
import NETWORK from '../src/data/network/index.js';
import HAZARDS from '../src/data/network/hazards.js';
import MTR_STATIONS from '../src/data/mtr-stations.js';
import { decodeGraph } from '../src/core/graph-codec.js';
// dependency-free, so unlike pedestrian-router.js it CAN be imported here
import { MAX_DEST_SNAP_M } from '../src/core/snap-limits.js';

// Bundles carry the PACKED format; decode before asserting on content.
const central = decodeGraph(packedCentral);
const tst = decodeGraph(packedTst);
const csw = decodeGraph(packedCsw);

const EARTH_R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;

function haversine(lon1, lat1, lon2, lat2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = p2 - p1;
  const dl = toRad(lon2 - lon1);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function buildAdjacency(edges) {
  const adj = new Map();
  const touch = (n, i) => {
    if (!adj.has(n)) adj.set(n, []);
    adj.get(n).push(i);
  };
  edges.forEach((e, i) => {
    touch(e.u, i);
    touch(e.v, i);
  });
  return adj;
}

function nearestNode(nodes, point) {
  let best = 0;
  let bestD = Infinity;
  nodes.forEach(([lon, lat], i) => {
    const d = haversine(point.longitude, point.latitude, lon, lat);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return { index: best, distance: bestD };
}

/** Dijkstra, matching the app's profiles. */
function route(graph, start, goal, profile) {
  const adj = buildAdjacency(graph.edges);
  const dist = new Map([[start, 0]]);
  const prev = new Map();
  const seen = new Set();
  const queue = [[0, start]];

  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [cost, node] = queue.shift();
    if (seen.has(node)) continue;
    seen.add(node);
    if (node === goal) break;

    for (const i of adj.get(node) || []) {
      const e = graph.edges[i];
      if (profile.excludeStairs && e.s) continue;
      if (profile.excludeBarriers && e.b) continue;
      let step = e.m;
      const g = Math.abs(e.g || 0);
      if (g > 0) step *= 1 + g * profile.gradientPenalty;
      if (e.s) step += profile.stairCostM;
      if (e.b) step += profile.barrierCostM;
      if (e.x) step += profile.crossingCostM;
      if (e.a) step *= 0.95;

      const next = e.u === node ? e.v : e.u;
      const candidate = cost + step;
      if (candidate < (dist.has(next) ? dist.get(next) : Infinity)) {
        dist.set(next, candidate);
        prev.set(next, [node, i]);
        queue.push([candidate, next]);
      }
    }
  }

  if (!dist.has(goal)) return null;
  const nodes = [goal];
  const edges = [];
  let cursor = goal;
  while (cursor !== start) {
    const [parent, i] = prev.get(cursor);
    edges.push(i);
    nodes.push(parent);
    cursor = parent;
  }
  nodes.reverse();
  edges.reverse();
  return { nodePath: nodes, edgeIndices: edges, cost: dist.get(goal) };
}

const STANDARD = { excludeStairs: false, excludeBarriers: false, gradientPenalty: 8, stairCostM: 60, barrierCostM: 400, crossingCostM: 6 };
const STEP_FREE = { excludeStairs: true, excludeBarriers: false, gradientPenalty: 25, stairCostM: 0, barrierCostM: 250, crossingCostM: 4 };

const CENTRAL_FROM = { latitude: 22.2819, longitude: 114.158 };
const CENTRAL_TO = { latitude: 22.2793, longitude: 114.1654 };

// ------------------------------------------------------------------ codec

test('the packed format decodes to a valid graph', () => {
  for (const [label, graph] of [['central', central], ['tst', tst], ['cheungShaWan', csw]]) {
    assert.ok(graph.nodes.length > 4000, `${label}: too few nodes`);
    assert.ok(graph.edges.length > 4000, `${label}: too few edges`);
    assert.equal(graph.bbox.length, 4, `${label}: bbox`);

    // Every node index must be in range, or routing reads undefined.
    for (const edge of graph.edges) {
      assert.ok(edge.u >= 0 && edge.u < graph.nodes.length, `${label}: u out of range`);
      assert.ok(edge.v >= 0 && edge.v < graph.nodes.length, `${label}: v out of range`);
      assert.ok(edge.m >= 0, `${label}: negative length`);
    }
  }
});

test('decoded coordinates land in Hong Kong, not near the origin', () => {
  // Delta encoding is cumulative; a decoder bug shows up as coordinates drifting
  // to (0,0) or far outside the bbox.
  for (const [label, graph] of [['central', central], ['tst', tst], ['cheungShaWan', csw]]) {
    const [minLat, minLon, maxLat, maxLon] = graph.bbox;
    const margin = 0.01;
    const outside = graph.nodes.filter(
      ([lon, lat]) =>
        lat < minLat - margin || lat > maxLat + margin ||
        lon < minLon - margin || lon > maxLon + margin
    );
    assert.equal(outside.length, 0, `${label}: ${outside.length} nodes outside bbox`);
  }
});

// ------------------------------------------------------------------ data

test('all bundled districts are present and sane', () => {
  const ids = NETWORK.map((d) => d.id);
  for (const required of ['central', 'tst', 'cheungShaWan']) {
    assert.ok(ids.includes(required), `missing bundled district: ${required}`);
  }
  for (const district of NETWORK) {
    assert.ok(district.nodes > 1000, `${district.id} has too few nodes`);
    assert.ok(district.edges > 1000, `${district.id} has too few edges`);
  }
});

test('Central graph keeps its accessibility attributes through the codec', () => {
  const stairs = central.edges.filter((e) => e.s).length;
  const barriers = central.edges.filter((e) => e.b).length;
  const lifts = central.edges.filter((e) => e.l).length;
  const indoor = central.edges.filter((e) => e.i).length;

  // If a bitmask bit were lost, one of these would collapse.
  assert.ok(stairs > 100, `expected staircases, got ${stairs}`);
  assert.ok(barriers > 100, `expected barriers, got ${barriers}`);
  assert.ok(lifts > 5, `expected lifts, got ${lifts}`);
  assert.ok(indoor > 100, `expected indoor edges, got ${indoor}`);
});

test('edges carry bilingual street names through the codec', () => {
  const named = central.edges.filter((e) => e.en);
  assert.ok(named.length > 1000, `expected many named streets, got ${named.length}`);
  const bilingual = named.filter((e) => e.tc);
  assert.ok(bilingual.length > 500, `expected Chinese names too, got ${bilingual.length}`);
});

test('CRITICAL: wheelchair_access is an exception flag, not a filter', () => {
  // Measured territory-wide: only 0.9% of features are WheelchairAccess = True.
  // The packed format does not store the 99.1% default at all, so every edge
  // decodes with w=1. Filtering on that would delete the network.
  const confirmedStepFree = central.edges.filter((e) => e.a).length;
  const flagged = central.edges.filter((e) => e.w).length;
  assert.equal(flagged, central.edges.length, 'w should be the default for every edge');
  assert.ok(
    confirmedStepFree / central.edges.length < 0.1,
    'expected very few confirmed step-free edges'
  );
});

test('tactile guide-path labelling stays sparse', () => {
  const tactile = central.edges.filter((e) => e.t).length;
  const fraction = tactile / central.edges.length;
  assert.ok(fraction < 0.05, `tactile should be sparse, got ${(fraction * 100).toFixed(1)}%`);
});

// --------------------------------------------------------------- routing

test('routes across Central with a plausible distance', () => {
  const start = nearestNode(central.nodes, CENTRAL_FROM);
  const goal = nearestNode(central.nodes, CENTRAL_TO);

  assert.ok(start.distance < 60, `start snapped ${start.distance.toFixed(0)} m`);
  assert.ok(goal.distance < 60, `goal snapped ${goal.distance.toFixed(0)} m`);

  const result = route(central, start.index, goal.index, STEP_FREE);
  assert.ok(result, 'expected a route');

  const metres = result.edgeIndices.reduce((s, i) => s + central.edges[i].m, 0);
  const straight = haversine(
    central.nodes[start.index][0], central.nodes[start.index][1],
    central.nodes[goal.index][0], central.nodes[goal.index][1]
  );

  assert.ok(metres >= straight * 0.95, `route ${metres.toFixed(0)}m shorter than the straight line`);
  assert.ok(metres < straight * 5, `route ${metres.toFixed(0)}m is implausibly long`);
  assert.ok(metres > 500 && metres < 2000, `unexpected distance ${metres.toFixed(0)} m`);
});

test('step-free genuinely excludes staircases', () => {
  const start = nearestNode(central.nodes, CENTRAL_FROM);
  const goal = nearestNode(central.nodes, CENTRAL_TO);

  const free = route(central, start.index, goal.index, STEP_FREE);
  assert.ok(free, 'step-free route should exist here');
  const stairs = free.edgeIndices.filter((i) => central.edges[i].s).length;
  assert.equal(stairs, 0, 'step-free route used a staircase');
});

test('the two profiles differ somewhere in the district', () => {
  // If they never differ, the stair exclusion is inert.
  let differences = 0;
  const samples = [
    [22.2819, 114.158, 22.2793, 114.1654],
    [22.2857, 114.1589, 22.279, 114.162],
    [22.282, 114.16, 22.285, 114.165],
    [22.2835, 114.157, 22.28, 114.164],
  ];
  for (const [fromLat, fromLon, toLat, toLon] of samples) {
    const s = nearestNode(central.nodes, { latitude: fromLat, longitude: fromLon });
    const g = nearestNode(central.nodes, { latitude: toLat, longitude: toLon });
    const a = route(central, s.index, g.index, STANDARD);
    const b = route(central, s.index, g.index, STEP_FREE);
    if (!a || !b) continue;
    if (a.edgeIndices.join() !== b.edgeIndices.join()) differences += 1;
  }
  assert.ok(differences > 0, 'step-free never differed from standard: exclusion looks inert');
});

// --------------------------------------------------------------- hazards

test('hazard strips are bundled for every district', () => {
  for (const district of NETWORK) {
    assert.ok(HAZARDS[district.id], `${district.id} hazard data missing`);
    assert.ok(HAZARDS[district.id].length > 1000, `${district.id} strips too few`);
  }
});

test('every hazard strip is inside its district bounding box', () => {
  for (const district of NETWORK) {
    const strips = HAZARDS[district.id];
    const [minLat, minLon, maxLat, maxLon] = district.bbox;
    const margin = 0.002;
    const outside = strips.filter(
      (s) =>
        s[1] < minLat - margin || s[1] > maxLat + margin ||
        s[3] < minLat - margin || s[3] > maxLat + margin ||
        s[0] < minLon - margin || s[0] > maxLon + margin ||
        s[2] < minLon - margin || s[2] > maxLon + margin
    );
    assert.equal(outside.length, 0, `${district.id}: ${outside.length} strips outside its bbox`);
  }
});

test('some Central edges pass near a surveyed warning strip', () => {
  // The hazard feature depends on this being true.
  const strips = HAZARDS.central;
  const lat0 = (central.bbox[0] + central.bbox[2]) / 2;
  const k = Math.cos(toRad(lat0)) * 111320;

  let matched = 0;
  for (const e of central.edges) {
    const a = central.nodes[e.u];
    const b = central.nodes[e.v];
    const qx = ((a[0] + b[0]) / 2) * k;
    const qy = ((a[1] + b[1]) / 2) * 111320;

    let nearest = Infinity;
    for (const s of strips) {
      const ax = s[0] * k;
      const ay = s[1] * 111320;
      const bx = s[2] * k;
      const by = s[3] * 111320;
      const dx = bx - ax;
      const dy = by - ay;
      let t = dx === 0 && dy === 0 ? 0 : ((qx - ax) * dx + (qy - ay) * dy) / (dx * dx + dy * dy);
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(qx - (ax + t * dx), qy - (ay + t * dy));
      if (d < nearest) nearest = d;
      if (nearest <= 3) break;
    }
    if (nearest <= 3) matched += 1;
  }

  assert.ok(matched > 20, `expected many edges near a warning strip, got ${matched}`);
});

// -------------------------------------------------- destination snap gate

/**
 * Regression coverage for the destination snap gate.
 *
 * The guard itself lives in `pedestrian-router.js` and cannot be called from
 * here (see the note at the top of this file). So these tests pin the facts the
 * guard depends on: which real destinations are reachable, and what the router
 * did before the limit existed.
 *
 * The bug being covered: the origin snap was gated at MAX_SNAP_M but the
 * destination snap never was. A destination the survey does not reach therefore
 * produced a normal, successful-looking plan that terminated at the last mapped
 * node — announcing arrival while the user was still hundreds of metres away.
 *
 * Reported from Fortune Estate (幸福邨, 22.33558, 114.15397) in Cheung Sha Wan.
 */
const FORTUNE_ESTATE = { latitude: 22.3355817, longitude: 114.1539651 };

/** Snap distance for a station, from the origin graph. */
function snapForStation(station) {
  return nearestNode(csw.nodes, station).distance;
}

test('Fortune Estate snaps inside the limit, so routing is attempted', () => {
  const start = nearestNode(csw.nodes, FORTUNE_ESTATE);
  assert.ok(
    start.distance <= MAX_DEST_SNAP_M,
    `origin snapped ${start.distance.toFixed(0)} m, over the ${MAX_DEST_SNAP_M} m limit`
  );
});

test('the two nearest stations are genuinely on the surveyed network', () => {
  // Both of these end at the station, so a route to them is trustworthy.
  for (const name of ['Cheung Sha Wan', 'Sham Shui Po']) {
    const station = MTR_STATIONS.find((s) => s.en === name);
    assert.ok(station, `no bundled station named ${name}`);
    const snap = snapForStation(station);
    assert.ok(
      snap <= MAX_DEST_SNAP_M,
      `${name} snapped ${snap.toFixed(0)} m; expected it to be reachable`
    );
  }
});

test('the gate has real work to do: several stations snap beyond the limit', () => {
  // These sit inside the bounding box, so hasOfflineCoverage() says "covered",
  // but the surveyed network does not actually reach them.
  for (const name of ['Lai Chi Kok', 'Prince Edward']) {
    const station = MTR_STATIONS.find((s) => s.en === name);
    assert.ok(station, `no bundled station named ${name}`);
    const snap = snapForStation(station);
    assert.ok(
      snap > MAX_DEST_SNAP_M,
      `${name} snapped only ${snap.toFixed(0)} m; if the survey now covers it, ` +
        'this expectation (and the gate rationale) needs revisiting'
    );
  }
});

test('without the gate a far destination still returns a route (the old bug)', () => {
  const station = MTR_STATIONS.find((s) => s.en === 'Prince Edward');
  const start = nearestNode(csw.nodes, FORTUNE_ESTATE);
  const goal = nearestNode(csw.nodes, station);

  // The gate rejects this destination...
  assert.ok(
    goal.distance > MAX_DEST_SNAP_M,
    `expected a far snap, got ${goal.distance.toFixed(0)} m`
  );

  // ...yet a path to that far-off node is found, and carries a plausible
  // distance. Nothing in the result would have revealed that it stops 700 m
  // short. That silent success is what the guard exists to prevent.
  const result = route(csw, start.index, goal.index, STEP_FREE);
  assert.ok(result, 'expected a path to the nearest mapped node');

  const metres = result.edgeIndices.reduce((s, i) => s + csw.edges[i].m, 0);
  assert.ok(
    metres > 500 && metres < 5000,
    `expected a plausible-looking distance, got ${metres.toFixed(0)} m`
  );

  // The route ends at the mapped node, which is the snapped distance from the
  // station: the user would have been told they arrived here.
  const [lon, lat] = csw.nodes[goal.index];
  const endsOff = haversine(lon, lat, station.longitude, station.latitude);
  assert.ok(
    endsOff > MAX_DEST_SNAP_M,
    `expected the endpoint to be far from the station, got ${endsOff.toFixed(0)} m`
  );
});
