/**
 * On-device pedestrian routing over the CSDI 3D Pedestrian Network.
 *
 * Runs entirely on the phone: the graphs are bundled modules, so routing needs no
 * network, no API key and no server. That matters beyond convenience — the app's
 * job is to guide someone who may be standing in the rain with no signal.
 *
 * WHY NOT OSRM/VALHALLA, in one line each:
 *   OSRM's foot profile gives `steps` the SAME speed as `footway`, so it applies
 *   no stair penalty and will route a wheelchair user down a staircase. It also
 *   has no indoor network, and 5.5% of Hong Kong's pedestrian network is indoors.
 *
 * MEASURED ATTRIBUTE DISTRIBUTIONS (territory-wide, 465,892 features):
 *   WheelchairAccess = True      4,177    0.9%
 *   WheelchairAccess = False   461,715   99.1%
 *   WheelchairBarrier = True    34,928    7.5%
 *   Location = Indoor           25,784    5.5%
 *   FeatureType = Staircase     22,012    4.7%
 *   FeatureType = Lift           1,911    0.4%
 *
 * `WheelchairAccess` is an EXCEPTION flag, not a filter. Excluding on
 * `WheelchairAccess = False` would delete 99.1% of the network and no route would
 * ever be found. Exclude on `barrier` and `stairs`; treat `a` (confirmed
 * step-free) as a small reward.
 *
 * TACTILE PAVING IS NOT A ROUTE WEIGHT. Measured: the TD guide-path layer
 * labelled 7 of 4,995 edges in Central (0.14%) and 1 of 5,034 in Tsim Sha Tsui
 * (0.02%). A preference matching 0.1% of edges cannot change a route, so
 * claiming it "prioritises tactile paving" would be false. The TD tactile
 * WARNING stripe layer is used instead, where it is reliable: as a spoken hazard
 * at decision points.
 *
 * Edge field keys (kept short because there are ~5,000 per district):
 *   u,v  node indices        m   metres           t  on a tactile guide path
 *   s    staircase           e   escalator        l  lift
 *   r    ramp                x   crossing         i  indoor
 *   a    confirmed step-free w   not wheelchair-accessible
 *   b    barrier             c   covered          g  gradient
 *   ft   CSDI FeatureType    en/tc  street names
 */

import graphs from '../data/network/index';

import { decodeGraph } from './graph-codec';
import { HAZARD_PROXIMITY_M, hazardsFor } from './hazards-network';

/**
 * Graph chunks, loaded lazily so a district's data is only parsed when it is
 * actually routed in. `require` (not `import`) is deliberate: Metro supports it,
 * and it keeps the ~0.8 MB per district out of the startup path.
 */
const GRAPH_MODULES = {
  central: () => require('../data/network/central').default,
  tst: () => require('../data/network/tst').default,
  cheungShaWan: () => require('../data/network/cheungShaWan').default,
};

export const NETWORK = graphs;

const METRES_PER_DEG_LAT = 111320;
const EARTH_R = 6371008.8;

/** A run must be this long before its bearing is trustworthy. */
const MIN_BEARING_M = 15;

/** A "turn around" needs this much distance behind it to be believable. */
const MIN_UTURN_M = 30;

/** Snapping further than this means the fix is bad, not the network. */
const MAX_SNAP_M = 60;

export const WALKING_SPEED_MPS = 1.2;

// --------------------------------------------------------------- geometry

const toRad = (deg) => (deg * Math.PI) / 180;

export function haversine(lon1, lat1, lon2, lat2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = p2 - p1;
  const dl = toRad(lon2 - lon1);
  const h =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(lon1, lat1, lon2, lat2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

export function turnWord(fromBearing, toBearing) {
  const delta = ((toBearing - fromBearing + 540) % 360) - 180;
  const magnitude = Math.abs(delta);
  if (magnitude < 20) return null;
  const side = delta > 0 ? 'right' : 'left';
  if (magnitude < 45) return `Bear ${side}`;
  if (magnitude < 120) return `Turn ${side}`;
  if (magnitude <= 160) return `Sharp ${side}`;
  return 'Turn around';
}

const plural = (metres) => (metres === 1 ? '1 metre' : `${metres} metres`);

// --------------------------------------------------------------- profiles

/**
 * Weights and exclusions. More than one profile because "accessible" is not one
 * thing: a wheelchair user, a cane user and a sighted walker want different
 * routes over the same network.
 */
export const PROFILES = {
  standard: {
    id: 'standard',
    label: 'Standard',
    description: 'No exclusions. Mild penalties for stairs and steep slopes.',
    excludeStairs: false,
    excludeBarriers: false,
    gradientPenalty: 8,
    stairCostM: 60,
    barrierCostM: 400,
    crossingCostM: 6,
  },  stepFree: {
    id: 'stepFree',
    label: 'Step-free',
    description: 'No staircases. Strongly avoids barriers and steep slopes.',
    excludeStairs: true,
    /**
     * Stairs are excluded outright: they are impassable for a wheelchair and
     * unambiguous in the data.
     *
     * Barriers are NOT excluded, and that is a deliberate change. Measured in
     * Cheung Sha Wan, 1,055 of 14,943 edges (7%) carry `WheelchairBarrier`, and
     * excluding them fragmented the graph badly enough that several nearby
     * pairs returned NO step-free route at all, while the one that succeeded was
     * forced down long straight edges (877 m over only 31 edges).
     *
     * The reason is what `ObstaclesType` actually contains: Accessible,
     * BridgePier, BusStop, FireHydrant, LightPole, RoadSign, TrafficLight,
     * TrafficSign, SignPole, **Bollard**, Tree, ElectricBox, ParkingMeter. Most
     * of those are things you walk *around*, not walls. So a barrier becomes a
     * heavy penalty instead of a wall.
     */
    excludeBarriers: false,
    gradientPenalty: 25,
    stairCostM: 0,
    barrierCostM: 250,
    crossingCostM: 4,
  },
};

function edgeCost(edge, profile) {
  if (profile.excludeStairs && edge.s) return null;
  if (profile.excludeBarriers && edge.b) return null;

  let cost = edge.m;

  const gradient = Math.abs(edge.g || 0);
  if (gradient > 0) cost *= 1 + gradient * profile.gradientPenalty;

  if (edge.s) cost += profile.stairCostM;
  if (edge.b) cost += profile.barrierCostM;
  if (edge.x) cost += profile.crossingCostM;

  // 0.9% of edges are explicitly confirmed step-free. A small reward, never a
  // requirement.
  if (edge.a) cost *= 0.95;

  return Math.max(cost, 0.01);
}

// --------------------------------------------------------------- graph

class Graph {
  constructor(payload) {
    this.name = payload.name;
    this.bbox = payload.bbox;
    this.nodes = payload.nodes;
    this.edges = payload.edges;
    this.lat0 = (payload.bbox[0] + payload.bbox[2]) / 2;

    /** node index -> edge indices touching it */
    this.adjacency = new Map();
    for (let i = 0; i < this.edges.length; i += 1) {
      const edge = this.edges[i];
      if (!this.adjacency.has(edge.u)) this.adjacency.set(edge.u, []);
      if (!this.adjacency.has(edge.v)) this.adjacency.set(edge.v, []);
      this.adjacency.get(edge.u).push(i);
      this.adjacency.get(edge.v).push(i);
    }
  }

  contains(point, marginDeg = 0.01) {
    const [minLat, minLon, maxLat, maxLon] = this.bbox;
    return (
      point.latitude >= minLat - marginDeg &&
      point.latitude <= maxLat + marginDeg &&
      point.longitude >= minLon - marginDeg &&
      point.longitude <= maxLon + marginDeg
    );
  }

  nearestNode(point) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    const { nodes } = this;
    for (let i = 0; i < nodes.length; i += 1) {
      const d = haversine(point.longitude, point.latitude, nodes[i][0], nodes[i][1]);
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = i;
      }
    }
    return { index: bestIndex, distance: bestDistance };
  }

  /** Dijkstra. Returns { nodePath, edgeIndices, cost } or null. */
  route(start, goal, profile) {
    if (start === goal) return { nodePath: [start], edgeIndices: [], cost: 0 };

    const dist = new Map([[start, 0]]);
    const previous = new Map();
    const settled = new Set();
    // Small binary heap keyed on cost.
    const heap = new MinHeap();
    heap.push(0, start);

    while (heap.size > 0) {
      const [cost, node] = heap.pop();
      if (settled.has(node)) continue;
      settled.add(node);
      if (node === goal) break;

      const touching = this.adjacency.get(node);
      if (!touching) continue;

      for (const edgeIndex of touching) {
        const edge = this.edges[edgeIndex];
        const step = edgeCost(edge, profile);
        if (step === null) continue;

        const next = edge.u === node ? edge.v : edge.u;
        const candidate = cost + step;
        const known = dist.has(next) ? dist.get(next) : Infinity;
        if (candidate < known) {
          dist.set(next, candidate);
          previous.set(next, [node, edgeIndex]);
          heap.push(candidate, next);
        }
      }
    }

    if (!dist.has(goal)) return null;

    const nodePath = [goal];
    const edgeIndices = [];
    let cursor = goal;
    while (cursor !== start) {
      const [parent, edgeIndex] = previous.get(cursor);
      edgeIndices.push(edgeIndex);
      nodePath.push(parent);
      cursor = parent;
    }
    nodePath.reverse();
    edgeIndices.reverse();
    return { nodePath, edgeIndices, cost: dist.get(goal) };
  }
}

/** Minimal binary min-heap. A sorted array was measurably slower at this size. */
class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(cost, value) {
    this.items.push([cost, value]);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent][0] <= this.items[i][0]) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }

  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.items.length && this.items[left][0] < this.items[smallest][0]) smallest = left;
        if (right < this.items.length && this.items[right][0] < this.items[smallest][0]) smallest = right;
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

// --------------------------------------------------------------- graph cache

const cache = new Map();

export function loadGraph(id) {
  if (cache.has(id)) return cache.get(id);
  const loader = GRAPH_MODULES[id];
  if (!loader) return null;
  // The bundles carry the PACKED form (18% of the verbose size), so decode on
  // first use. A district's data is only parsed when routed in, which keeps the
  // ~0.15-0.45 MB per district off the startup path.
  const graph = new Graph(decodeGraph(loader()));
  cache.set(id, graph);
  return graph;
}

/** Which bundled district covers this point, if any. */
export function graphFor(point) {
  for (const district of NETWORK) {
    if (
      point.latitude >= district.bbox[0] - 0.01 &&
      point.latitude <= district.bbox[2] + 0.01 &&
      point.longitude >= district.bbox[1] - 0.01 &&
      point.longitude <= district.bbox[3] + 0.01
    ) {
      const graph = loadGraph(district.id);
      if (graph) return graph;
    }
  }
  return null;
}

// --------------------------------------------------------------- description

const FEATURE_LABEL = {
  1: 'footway',
  2: 'footbridge',
  4: 'subway',
  8: 'escalator',
  9: 'travelator',
  10: 'lift',
  11: 'ramp',
  12: 'staircase',
  30: 'signalised crossing',
  31: 'zebra crossing',
  32: 'cautionary crossing',
  33: 'crossing',
};

function edgeCategory(edge) {
  if (edge.s) return 'stairs';
  if (edge.l) return 'lift';
  if (edge.e) return 'escalator';
  if (edge.r) return 'ramp';
  if (edge.x) return 'crossing';
  if (edge.i) return 'indoor';
  return 'walk';
}

/**
 * Merge edges into instructions a person can follow.
 *
 * Unmerged this is 130+ instructions for a 1 km walk, because CSDI edges average
 * ~7 m. Merging by category and by heading brings it to ~27.
 *
 * A bearing is only trusted once MIN_BEARING_M has accumulated: over a 2 m
 * segment the bearing is dominated by survey jitter, and an early version
 * produced 70 instructions for a 1 km walk full of phantom "turn around"s.
 */
export function mergeInstructions(graph, edgeIndices, language = 'en') {
  const runs = [];

  for (const edgeIndex of edgeIndices) {
    const edge = graph.edges[edgeIndex];
    const a = graph.nodes[edge.u];
    const b = graph.nodes[edge.v];
    const heading = bearing(a[0], a[1], b[0], b[1]);
    const category = edgeCategory(edge);

    if (runs.length > 0) {
      const last = runs[runs.length - 1];
      const sameKind = last.category === category;
      const longEnough = last.metres >= MIN_BEARING_M && edge.m >= MIN_BEARING_M;
      let turn = longEnough ? turnWord(last.heading, heading) : null;

      if (turn === 'Turn around' && last.metres < MIN_UTURN_M) turn = null;

      if (sameKind && turn === null) {
        last.metres += edge.m;
        last.heading = heading;
        last.edge = edge;
        last.endNode = edge.v;
        continue;
      }

      runs.push({
        category,
        metres: edge.m,
        heading,
        edge,
        turn,
        endNode: edge.v,
      });
      continue;
    }

    runs.push({
      category,
      metres: edge.m,
      heading,
      edge,
      turn: null,
      endNode: edge.v,
    });
  }

  return runs.map((run) => ({
    category: run.category,
    metres: Math.round(run.metres),
    instruction: describe(run, language),
    bearing: Math.round(run.heading),
    end: graph.nodes[run.endNode],
    isCrossing: run.category === 'crossing',
  }));
}

function describe(run, language) {
  const metres = Math.round(run.metres);
  const name = language === 'tc' || language === 'yue' ? run.edge.tc || run.edge.en : run.edge.en;
  const via = name ? ` along ${name}` : '';
  let body;

  switch (run.category) {
    case 'stairs':
      body = `There are stairs here, about ${plural(metres)}.`;
      break;
    case 'lift':
      body = name ? `Take the lift at ${name}.` : 'Take the lift.';
      break;
    case 'escalator':
      body = 'Take the escalator.';
      break;
    case 'ramp':
      body = `Go up the ramp for about ${plural(metres)}.`;
      break;
    case 'crossing': {
      const label = FEATURE_LABEL[run.edge.ft] || 'crossing';
      body = `Cross the road at the ${label}${name ? ` on ${name}` : ''}.`;
      break;
    }
    case 'indoor':
      body = `Continue inside for about ${plural(metres)}.`;
      break;
    default:
      body = `Continue${via} for about ${plural(metres)}.`;
  }

  if (run.turn) {
    return run.category === 'walk' && via
      ? `${run.turn}, then continue${via} for about ${plural(metres)}.`
      : `${run.turn}. ${body}`;
  }
  return body;
}

// --------------------------------------------------------------- hazards

/**
 * Surveyed tactile warning strips near a route.
 *
 * These are a proximity check, not a route weight: a warning strip is ~1.4 m of
 * lozenge-laid surfacing at a decision point, and only ~2.7% of network edges
 * pass near one. As evidence it is strong — a surveyed strip beats guessing from
 * a camera. What it does NOT do is detect an arbitrary obstacle: a barricade on
 * a footway with no strip is invisible to it.
 */
export function hazardsOnRoute(graph, edgeIndices, language = 'en') {
  const strips = hazardsFor(graph.name);
  if (!strips || strips.length === 0) return [];

  const found = [];
  const seen = [];

  for (const edgeIndex of edgeIndices) {
    const edge = graph.edges[edgeIndex];
    const a = graph.nodes[edge.u];
    const b = graph.nodes[edge.v];
    const lon = (a[0] + b[0]) / 2;
    const lat = (a[1] + b[1]) / 2;

    let nearest = Infinity;
    for (const strip of strips) {
      const d = pointSegmentMetres(lon, lat, strip[0], strip[1], strip[2], strip[3], graph.lat0);
      if (d < nearest) nearest = d;
    }
    if (nearest > HAZARD_PROXIMITY_M) continue;

    // One strip can abut several short consecutive edges: do not repeat.
    if (seen.some(([slon, slat]) => haversine(lon, lat, slon, slat) <= 8)) continue;
    seen.push([lon, lat]);

    found.push({
      distanceMeters: Math.round(nearest * 10) / 10,
      lon,
      lat,
      code: hazardCodeFor(edge),
      phrase: hazardPhraseFor(edge, language),
    });
  }

  return found;
}

function pointSegmentMetres(px, py, lon1, lat1, lon2, lat2, lat0) {
  const k = Math.cos(toRad(lat0)) * METRES_PER_DEG_LAT;
  const ax = lon1 * k;
  const ay = lat1 * METRES_PER_DEG_LAT;
  const bx = lon2 * k;
  const by = lat2 * METRES_PER_DEG_LAT;
  const qx = px * k;
  const qy = py * METRES_PER_DEG_LAT;

  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(qx - ax, qy - ay);
  let t = ((qx - ax) * dx + (qy - ay) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(qx - (ax + t * dx), qy - (ay + t * dy));
}

function hazardCodeFor(edge) {
  if (edge.s) return 'stairs-ahead';
  if (edge.e) return 'escalator-ahead';
  if (edge.l) return 'step-up-ahead';
  if (edge.x) return 'step-down-ahead';
  // The strip is surveyed, so something is here; we just cannot say what from the
  // strip alone. The conservative code is the honest one.
  return 'obstacle-ahead';
}

function hazardPhraseFor(edge, language) {
  const tc = language === 'tc' || language === 'yue';
  if (edge.s) return tc ? '前面係樓梯，有觸覺警告磚。' : 'Tactile warning strip at the stairs. Steps here.';
  if (edge.e) return tc ? '前面有自動扶梯。' : 'Tactile warning strip at the escalator.';
  if (edge.l) return tc ? '喺電梯旁邊有觸覺警告磚。' : 'Tactile warning strip by the lift.';
  if (edge.x) return tc ? '前面係過路處，有觸覺警告磚。' : 'Tactile warning strip at a crossing. Kerb ahead.';
  return tc
    ? '呢度有觸覺警告磚。停一停，小心檢查地面。'
    : 'Tactile warning strip here. Stop and check the surface before continuing.';
}

// --------------------------------------------------------------- public API

export class RoutingError extends Error {
  constructor(message, { code = 'routing', retryable = false } = {}) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Route between two coordinates, entirely on device.
 *
 * @param {{latitude:number, longitude:number}} origin
 * @param {{latitude:number, longitude:number}} destination
 * @param {{profileId?: string, language?: string}} options
 */
export function walkingRoute(origin, destination, options = {}) {
  const profileId = options.profileId || 'stepFree';
  const language = options.language || 'en';
  const profile = PROFILES[profileId];
  if (!profile) throw new RoutingError(`Unknown profile '${profileId}'.`);

  if (!origin || !destination) {
    throw new RoutingError('Both an origin and a destination are required.', {
      code: 'bad_input',
    });
  }

  const graph = graphFor(origin);
  if (!graph) {
    throw new RoutingError(
      `No offline map covers ${origin.latitude.toFixed(4)}, ${origin.longitude.toFixed(4)}. ` +
        `Bundled areas: ${NETWORK.map((d) => d.id).join(', ') || 'none'}.`,
      { code: 'outside_coverage' }
    );
  }
  if (!graph.contains(destination)) {
    throw new RoutingError('Origin and destination are in different offline map areas.', {
      code: 'cross_area',
    });
  }

  const start = graph.nearestNode(origin);
  const goal = graph.nearestNode(destination);

  // A fix that snaps improbably far is not a fix. Hong Kong's high-rises
  // routinely give 50-100 m of error, and routing from a bad snap would send the
  // user somewhere they are not.
  if (start.distance > MAX_SNAP_M) {
    throw new RoutingError(
      `Your location is ${Math.round(start.distance)} m from the nearest mapped path ` +
        `(limit ${MAX_SNAP_M} m). The GPS fix is probably poor.`,
      { code: 'poor_fix', retryable: true }
    );
  }

  const result = graph.route(start.index, goal.index, profile);
  if (!result) {
    /**
     * Distinguish "nowhere near each other" from "the exclusions cut the path".
     *
     * This matters because the two need different words. Measured in Cheung Sha
     * Wan: allowing stairs, 99.0% of the network is one component; excluding
     * stairs it shatters into 503 components with the largest holding 81.4%.
     * That is not a bug — much of Hong Kong's footbridge network is stairs-only,
     * so a step-free route genuinely does not exist to some places. Saying "no
     * route" when the truth is "no step-free route" would be misleading, and the
     * user needs to know which.
     */
    if (profile.excludeStairs) {
      const withoutExclusions = graph.route(start.index, goal.index, PROFILES.standard);
      if (withoutExclusions) {
        throw new RoutingError(
          'There is no step-free route between these points. A route exists if ' +
            'stairs are allowed, which means the only way involves steps. ' +
            'Consider routing to a nearby step-free entrance instead.',
          { code: 'no_step_free_route' }
        );
      }
    }
    throw new RoutingError(
      'These two points are in different parts of the surveyed network, so no ' +
        'route connects them. Try a destination nearer the start.',
      { code: 'disconnected' }
    );
  }

  const edges = result.edgeIndices.map((i) => graph.edges[i]);
  const totalMetres = edges.reduce((sum, edge) => sum + edge.m, 0);
  const steps = mergeInstructions(graph, result.edgeIndices, language);
  const hazards = hazardsOnRoute(graph, result.edgeIndices, language);

  const usedStairs = edges.some((edge) => edge.s);
  const usedBarriers = edges.some((edge) => edge.b);
  const indoorMetres = edges.filter((e) => e.i).reduce((s, e) => s + e.m, 0);
  const tactileMetres = edges.filter((e) => e.t).reduce((s, e) => s + e.m, 0);

  return {
    area: graph.name,
    profileId,
    steps,
    hazards,
    totalDistanceMeters: Math.round(totalMetres),
    totalDurationSeconds: Math.round(totalMetres / WALKING_SPEED_MPS),
    indoorMetres: Math.round(indoorMetres),
    tactileMetres: Math.round(tactileMetres),
    lifts: edges.filter((e) => e.l).length,
    /**
     * A claim, so it must be earned: true only when the profile excluded stairs
     * AND none were taken, and every step had a known stair status.
     */
    avoidsStairs: profile.excludeStairs && !usedStairs,
    usedBarriers,
    snapMeters: Math.round(start.distance),
    /** True when the route came from the surveyed network, not an estimate. */
    surveyed: true,
  };
}

export { GRAPH_MODULES };
