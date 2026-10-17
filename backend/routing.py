"""
Routing service.

Two implementations behind one interface, chosen at startup:

* `GraphRouter`  — real pedestrian routing over the surveyed network in
                   `data/index/nearby.npz`. Dijkstra on the OSM-derived graph,
                   weighted by tactile/kerb/gradient attributes.
* straight line  — fallback when the index is absent. A bearing and a distance
                   that says out loud it does not follow footpaths.

`api.py` instantiates `RoutingService` and never needs to know which is active.

WHAT THE INDEX CONTAINS
-----------------------
707,478 edges / 680,573 nodes / 265,477 decision points. Per edge:
connectivity (`from_node`, `to_node`), geometry (`lon1,lat1,lon2,lat2`),
`pclass` (footway, footbridge, steps, ramp, subway, …), `tau` (tactile paving:
unknown/absent/partial/present), `wheelchair_barrier`, `gradient`, `indoor`,
`has_lift/ramp/escalator/stairlift`, `cov`, `enabler`.

It does NOT contain street names, so instructions are geometric — "turn left
after 20 m", not "turn left onto Cheung Sha Wan Road". It also has no edge
length; length is computed from the coordinates (~13 m average, well under GPS
error).

SAFETY RULES CARRIED OVER FROM THE MOBILE ROUTER
------------------------------------------------
* BOTH ends must snap within MAX_SNAP_M. Gating only the origin produces routes
  that silently stop short of the destination — the worst failure mode for a
  blind pedestrian, because it announces arrival somewhere else.
* "No route" and "no step-free route" are different answers, worded differently.
* Tactile coverage is sparse (99.6% of edges are `tau=unknown`), so a route with
  no tactile data says so rather than being described as tactile-friendly.
"""

from __future__ import annotations

from array import array
from dataclasses import dataclass, field, asdict
import heapq
import json
import math
from pathlib import Path
from typing import Any

import numpy as np


def _i32(values: np.ndarray) -> array:
    """Compact int32 array. `array` indexes about as fast as a list but costs
    4 bytes per slot instead of ~32 for a Python int, which matters at 1.4M arcs."""
    out = array("i")
    out.frombytes(np.ascontiguousarray(values, dtype=np.int32).tobytes())
    return out


def _f32(values: np.ndarray) -> array:
    out = array("f")
    out.frombytes(np.ascontiguousarray(values, dtype=np.float32).tobytes())
    return out

ROOT = Path(__file__).resolve().parent
INDEX_PATH = ROOT / "data" / "index" / "nearby.npz"

EARTH_RADIUS_M = 6371008.8
WALKING_SPEED_MPS = 1.2

HK_LAT = (22.13, 22.57)
HK_LON = (113.83, 114.51)

#: A fix further than this from the mapped network is not a usable fix.
MAX_SNAP_M = 60.0

# --- cost model: metres of "equivalent walking" added per feature -----------
#: Stairs are impassable for some users, not merely slow.
STAIR_COST_M = 90.0
BARRIER_COST_M = 120.0
#: Slope multiplies cost; a 10% grade costs 12% more at this setting.
GRADIENT_PENALTY = 12.0
#: A confirmed tactile guide path is slightly preferred.
TACTILE_REWARD = 0.95
#: Sentinel used by the pipeline for "gradient unknown".
GRADIENT_UNKNOWN = -1.0

PERSONAS: dict[str, dict[str, Any]] = {
    "unfamiliar": {"exclude": None, "risk": 0.5, "description": "Highest reliance on the guide path"},
    "familiar": {"exclude": None, "risk": 0.1, "description": "Knows the route; minimises effort"},
    "low_vision": {"exclude": None, "risk": 0.3, "description": "Uses residual vision"},
    "deafblind": {"exclude": None, "risk": 0.7, "description": "Cannot use audible signals"},
    "step_averse": {"exclude": "steps", "risk": 0.3, "description": "No staircases"},
    "verified_only": {"exclude": None, "risk": 0.2, "description": "Only inspected segments"},
}

DISCLAIMER = {
    "yue": "呢個係直線方向，唔會跟行人路。",
    "en": "This is a direct line and does not follow footpaths.",
}
_INTRO = {
    "yue": "未能提供行人路路線，以下只係直線方向，唔會跟行人路。",
    "en": "No footpath route available. This is a direct line and does not follow footpaths.",
}
_BEARING = {
    "yue": "向{compass}方向行{distance}。",
    "en": "Head {compass} for {distance}.",
}
_DEPART = {
    "yue": "向{compass}方向行{distance}。",
    "en": "Head {compass} for {distance}.",
}
_TURN = {
    "left": {"yue": "轉左，跟住行{distance}。", "en": "Turn left, then continue {distance}."},
    "right": {"yue": "轉右，跟住行{distance}。", "en": "Turn right, then continue {distance}."},
    "slight_left": {"yue": "微微轉左，跟住行{distance}。", "en": "Bear left, then continue {distance}."},
    "slight_right": {"yue": "微微轉右，跟住行{distance}。", "en": "Bear right, then continue {distance}."},
    "uturn": {"yue": "掉頭，跟住行{distance}。", "en": "Turn around, then continue {distance}."},
}
_TURN_NOW = {
    "left": {"yue": "轉左。", "en": "Turn left."},
    "right": {"yue": "轉右。", "en": "Turn right."},
    "slight_left": {"yue": "微微轉左。", "en": "Bear left."},
    "slight_right": {"yue": "微微轉右。", "en": "Bear right."},
    "uturn": {"yue": "掉頭。", "en": "Turn around."},
}
# --- street-name variants ---------------------------------------------------
# The index carries no street names; build_names.py derives them into names.npz.
# Coverage is partial (most footways are unnamed in OSM), so instructions MIX the
# two forms: a name where one exists, a distance where none does.
_DEPART_ON = {
    "yue": "由{street}開始行，向{compass}方向行{distance}。",
    "en": "Start on {street}, heading {compass} for {distance}.",
}
_TURN_ONTO = {
    "left": {"yue": "轉左入{street}，跟住行{distance}。", "en": "Turn left onto {street}, then continue {distance}."},
    "right": {"yue": "轉右入{street}，跟住行{distance}。", "en": "Turn right onto {street}, then continue {distance}."},
    "slight_left": {"yue": "微微轉左入{street}，跟住行{distance}。", "en": "Bear left onto {street}, then continue {distance}."},
    "slight_right": {"yue": "微微轉右入{street}，跟住行{distance}。", "en": "Bear right onto {street}, then continue {distance}."},
    "uturn": {"yue": "掉頭入{street}，跟住行{distance}。", "en": "Turn around onto {street}, then continue {distance}."},
}
_TURN_ONTO_NOW = {
    "left": {"yue": "轉左入{street}。", "en": "Turn left onto {street}."},
    "right": {"yue": "轉右入{street}。", "en": "Turn right onto {street}."},
    "slight_left": {"yue": "微微轉左入{street}。", "en": "Bear left onto {street}."},
    "slight_right": {"yue": "微微轉右入{street}。", "en": "Bear right onto {street}."},
    "uturn": {"yue": "掉頭入{street}。", "en": "Turn around onto {street}."},
}
_ARRIVE = {"yue": "已經到達。", "en": "You have arrived."}
_STAIRS_WARN = {"yue": "注意：呢條路線有樓梯。", "en": "Note: this route includes stairs."}
_NO_TACTILE = {
    "yue": "呢條路線冇觸覺引路徑資料。",
    "en": "This route has no tactile guide-path data.",
}


class RoutingError(Exception):
    """A request that cannot be answered. `code` is stable for clients."""

    def __init__(self, message: str, code: str = "routing_error", status: int = 422):
        super().__init__(message)
        self.code = code
        self.status = status


# ---------------------------------------------------------------------- geometry

def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def _hav_vec(lat1, lon1, lat2, lon2):
    """Vectorised haversine — used to snap against 680k nodes at once."""
    p1 = np.radians(lat1)
    p2 = np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(np.asarray(lon2) - np.asarray(lon1))
    h = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * np.arcsin(np.minimum(1.0, np.sqrt(h)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _inside_hong_kong(latitude: float, longitude: float) -> bool:
    return HK_LAT[0] <= latitude <= HK_LAT[1] and HK_LON[0] <= longitude <= HK_LON[1]


def _format_distance(metres: float, language: str) -> str:
    if metres < 1000:
        return f"{int(round(metres))} 米" if language == "yue" else f"{int(round(metres))} metres"
    return f"{metres / 1000:.1f} 公里" if language == "yue" else f"{metres / 1000:.1f} km"


#: 8-point compass. A degree bearing is unusable when you cannot see: nobody can
#: "walk 107 degrees", and the user has no way to check they are doing it. The app
#: already speaks compass points and clock faces (src/core/geo.js); the server
#: should not be the one place that speaks protractor.
_COMPASS = [
    {"yue": "北", "en": "north"},
    {"yue": "東北", "en": "north-east"},
    {"yue": "東", "en": "east"},
    {"yue": "東南", "en": "south-east"},
    {"yue": "南", "en": "south"},
    {"yue": "西南", "en": "south-west"},
    {"yue": "西", "en": "west"},
    {"yue": "西北", "en": "north-west"},
]


def _compass_word(bearing: float, lang: str) -> str:
    """Nearest of the 8 compass points. 45-degree sectors."""
    idx = int(round(bearing / 45.0)) % 8
    return _COMPASS[idx].get(lang, _COMPASS[idx]["en"])


def _turn_word(delta: float) -> str | None:
    """Classify a bearing change; thresholds match the mobile router."""
    a = abs(delta)
    if a > 150:
        return "uturn"
    if a > 45:
        return "left" if delta > 0 else "right"
    if a > 20:
        return "slight_left" if delta > 0 else "slight_right"
    return None


# ------------------------------------------------------------------------ result

@dataclass
class RouteResult:
    """A routing answer in both the mobile and the native shape."""

    origin: tuple[float, float]
    destination: tuple[float, float]
    steps: list[dict[str, Any]]
    distance_m: float
    duration_s: float
    speaker: str = "straight-line"
    persona: str = "unfamiliar"
    accessibility_optimised: bool = False
    notes: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def instructions(self) -> list[str]:
        """The flat list `src/providers/route.js` reads."""
        return [s["say"] for s in self.steps if s.get("say")]

    def to_dict(self, language: str = "yue") -> dict[str, Any]:
        payload = asdict(self)
        payload.pop("extra", None)
        payload["route_id"] = f"{self.speaker}-{int(self.distance_m)}"
        payload["router"] = self.speaker
        payload["instructions"] = self.instructions
        payload["distance_meters"] = self.distance_m
        payload["disclaimer"] = self.extra.get(
            "disclaimer", DISCLAIMER.get(language, DISCLAIMER["en"]))
        payload["accessibility"] = self.extra.get("accessibility", {
            "surveyed": False,
            "note": "no surveyed network behind this response",
        })
        return payload


# ------------------------------------------------------------------ graph router

class GraphRouter:
    """Dijkstra over the surveyed pedestrian network in nearby.npz.

    The CSR arrays are converted to Python lists at startup. Element-wise numpy
    indexing costs ~1 µs per access, and the inner loop does several per edge;
    list indexing is roughly 10x faster. The trade is ~130 MB of RSS, measured.
    """

    def __init__(self, path: Path):
        z = np.load(path, allow_pickle=False)
        e = z["edges"]
        meta = json.loads(str(z["meta"][0]))
        self.meta = meta
        classes = meta["classes"]
        steps_class = classes.index("steps") if "steps" in classes else -1

        self.n_edges = len(e)

        # Nodes are implied by the edges, so derive the node table.
        node_ids = np.concatenate([e["from_node"], e["to_node"]])
        lons = np.concatenate([e["lon1"], e["lon2"]])
        lats = np.concatenate([e["lat1"], e["lat2"]])
        uniq, first = np.unique(node_ids, return_index=True)
        self.n_nodes = len(uniq)
        self.node_lat = lats[first].astype(np.float64).tolist()
        self.node_lon = lons[first].astype(np.float64).tolist()
        u = np.searchsorted(uniq, e["from_node"])
        v = np.searchsorted(uniq, e["to_node"])

        # Geometry + cost.
        self.edge_len = _hav_vec(e["lat1"], e["lon1"], e["lat2"], e["lon2"])
        # Unknown gradient is stored as -1; only positive slopes should penalise.
        grad = e["gradient"].astype(np.float64)
        grad = np.where(grad == GRADIENT_UNKNOWN, 0.0, np.clip(grad, 0.0, None))
        cost = self.edge_len * (1.0 + grad * GRADIENT_PENALTY)
        self.is_steps = e["pclass"] == steps_class
        cost = cost + np.where(self.is_steps, STAIR_COST_M, 0.0)
        cost = cost + np.where(e["wheelchair_barrier"] != 0, BARRIER_COST_M, 0.0)
        cost = np.where(e["tau"] == 3, cost * TACTILE_REWARD, cost)

        self.tau = e["tau"]
        self.indoor = e["indoor"] != 0
        self.has_lift = e["has_lift"] != 0

        # CSR over BIDIRECTIONAL arcs. The index stores only direction==1 edges —
        # one direction per segment (verified: 0 of 200k sampled edges have a
        # reverse twin). A one-way adjacency would make upstream travel
        # impossible and silently return "disconnected" for perfectly valid
        # pairs, which is exactly what the first version of this router did.
        # A footway is walkable either way, and the features are symmetric.
        src = np.concatenate([u, v])
        dst = np.concatenate([v, u])
        row = np.concatenate([np.arange(self.n_edges), np.arange(self.n_edges)])
        arc_cost = np.concatenate([cost, cost])

        order = np.argsort(src, kind="stable")
        self.csr_v = _i32(dst[order])
        self.csr_edge = _i32(row[order])
        self.cost = _f32(np.maximum(arc_cost[order], 0.01))
        self.offsets = _i32(np.searchsorted(src[order], np.arange(self.n_nodes + 1)))
        # One byte per edge, read in the hot loop.
        self._steps_bytes = bytearray(self.is_steps.astype(np.uint8).tobytes())

        # ~0.4 s at startup; saves every "disconnected" false negative.
        self._label_components()

        # Street names live in a sidecar, not in the index: nearby.npz has none,
        # and the CSV that could supply them is 250 MB. Optional by design — a
        # missing or stale sidecar degrades to distance-only instructions rather
        # than stopping the service.
        self.name_idx = None
        self.names_en: list[str] = []
        self.names_tc: list[str] = []
        names_path = Path(path).with_name("names.npz")
        if names_path.exists():
            try:
                nz = np.load(names_path, allow_pickle=False)
                idx = nz["name_idx"]
                if len(idx) == self.n_edges:
                    self.name_idx = idx
                    self.names_en = nz["en"].tolist()
                    self.names_tc = nz["tc"].tolist()
            except Exception:                          # noqa: BLE001
                self.name_idx = None

    # ------------------------------------------------------------------ snapping
    def nearest_node(self, latitude: float, longitude: float) -> tuple[int, float]:
        """Nearest mapped node and its distance, vectorised over all 680k nodes."""
        d = _hav_vec(np.float64(latitude), np.float64(longitude),
                     np.asarray(self.node_lat), np.asarray(self.node_lon))
        i = int(np.argmin(d))
        return i, float(d[i])

    # --------------------------------------------------------------- components
    def _label_components(self) -> None:
        """Label connected components, largest first.

        The surveyed network is genuinely fragmented: 4,909 components, the
        largest holding 59.2% of nodes (this matches the pipeline manifest). Whole
        blocks of the city sit on islands — Fortune Estate, for one, is on a
        component of 10 nodes. Plain nearest-node snapping lands on those islands
        and every route from them fails as "disconnected", which looks like a
        router bug but is a property of the survey.
        """
        n = self.n_nodes
        labels = np.full(n, -1, dtype=np.int32)
        sizes: list[int] = []
        off, v = self.offsets, self.csr_v
        for start in range(n):
            if labels[start] != -1:
                continue
            cid = len(sizes)
            count = 0
            labels[start] = cid
            stack = [start]
            while stack:
                u = stack.pop()
                count += 1
                for k in range(off[u], off[u + 1]):
                    w = v[k]
                    if labels[w] == -1:
                        labels[w] = cid
                        stack.append(w)
            sizes.append(count)
        self.comp_label = labels
        self.comp_sizes = sizes
        self.main_comp = int(np.argmax(sizes)) if sizes else -1

    def snap(self, latitude: float, longitude: float) -> tuple[int, float, bool]:
        """Nearest node, preferring one on the routable main component.

        Returns (node, distance, relocated). `relocated` is True when the closest
        node overall was on an isolated fragment and we moved to the main network
        instead. Callers must surface `relocated` and the distance: routing from a
        point 54 m away is only acceptable if the user is told.
        """
        d = _hav_vec(np.float64(latitude), np.float64(longitude),
                     np.asarray(self.node_lat), np.asarray(self.node_lon))
        i = int(np.argmin(d))
        if self.comp_label[i] == self.main_comp:
            return i, float(d[i]), False

        masked = np.where(self.comp_label == self.main_comp, d, np.inf)
        j = int(np.argmin(masked))
        if masked[j] <= MAX_SNAP_M:
            return j, float(masked[j]), True
        return i, float(d[i]), False

    # ------------------------------------------------------------------- search
    def _dijkstra(self, src: int, dst: int, exclude_steps: bool):
        """Cost-minimising path over bidirectional arcs.

        Returns (node_path, edge_path, cost) or None.

        `dist`/`prev` are plain lists: 680k slots of Python floats/ints is
        ~30 MB and avoids a numpy round-trip on every relaxation.
        """
        inf = float("inf")
        n = self.n_nodes
        dist = [inf] * n
        prev_node = [-1] * n
        prev_edge = [-1] * n
        dist[src] = 0.0
        heap = [(0.0, src)]

        off = self.offsets
        v = self.csr_v
        edge = self.csr_edge
        cost = self.cost
        steps_bytes = self._steps_bytes

        while heap:
            d, node = heapq.heappop(heap)
            if d > dist[node]:
                continue
            if node == dst:
                break
            for k in range(off[node], off[node + 1]):
                ei = edge[k]
                if exclude_steps and steps_bytes[ei]:
                    continue
                nxt = v[k]
                nd = d + cost[k]
                if nd < dist[nxt]:
                    dist[nxt] = nd
                    prev_node[nxt] = node
                    prev_edge[nxt] = ei
                    heapq.heappush(heap, (nd, nxt))

        if dist[dst] == inf:
            return None

        node_path = [dst]
        edge_path = []
        cur = dst
        while cur != src:
            ei = prev_edge[cur]
            if ei < 0:
                return None
            edge_path.append(ei)
            cur = prev_node[cur]
            node_path.append(cur)
        node_path.reverse()
        edge_path.reverse()
        return node_path, edge_path, dist[dst]

    # -------------------------------------------------------------------- route
    def route(self, origin, destination, persona: str, language: str) -> RouteResult:
        lang = language if language in DISCLAIMER else "en"
        spec = PERSONAS[persona]
        exclude_steps = spec["exclude"] == "steps"

        src, src_d, src_moved = self.snap(origin[0], origin[1])
        dst, dst_d, dst_moved = self.snap(destination[0], destination[1])

        # Gate BOTH ends: an ungated destination returns a route that stops short
        # of where the user asked to go, and still looks successful.
        if src_d > MAX_SNAP_M:
            raise RoutingError(
                f"origin is {src_d:.0f} m from the mapped network "
                f"(limit {MAX_SNAP_M:.0f} m) — the GPS fix is probably poor",
                code="poor_fix", status=422)
        if dst_d > MAX_SNAP_M:
            raise RoutingError(
                f"destination is {dst_d:.0f} m from the mapped network "
                f"(limit {MAX_SNAP_M:.0f} m) — a route would stop short of it",
                code="destination_off_network", status=422)

        found = self._dijkstra(src, dst, exclude_steps)
        if found is None and exclude_steps and self._dijkstra(src, dst, False) is not None:
            raise RoutingError(
                "no step-free route exists; the only connection involves stairs",
                code="no_step_free_route", status=404)
        if found is None:
            raise RoutingError(
                "origin and destination are not connected in the surveyed network",
                code="disconnected", status=404)

        node_path, edge_path, _ = found
        path = np.asarray(edge_path)
        dist_m = float(self.edge_len[path].sum())
        used_stairs = bool(self.is_steps[path].any())
        tactile_m = float(self.edge_len[path][self.tau[path] == 3].sum())
        indoor_m = float(self.edge_len[path][self.indoor[path]].sum())
        lifts = int(self.has_lift[path].sum())

        steps = self._instructions(node_path, edge_path, dist_m, lang, used_stairs, tactile_m)

        notes = []
        if used_stairs:
            notes.append("route includes stairs")
        if tactile_m == 0:
            notes.append("no tactile guide path on this route")
        if src_moved:
            notes.append(f"origin moved {src_d:.0f} m to the nearest connected path")
        if dst_moved:
            notes.append(f"destination moved {dst_d:.0f} m to the nearest connected path")

        return RouteResult(
            origin=origin,
            destination=destination,
            steps=steps,
            distance_m=round(dist_m, 1),
            duration_s=round(dist_m / WALKING_SPEED_MPS, 1),
            speaker="surveyed",
            persona=persona,
            accessibility_optimised=spec["exclude"] is not None,
            notes=notes,
            extra={"accessibility": {
                "surveyed": True,
                "tactile_metres": round(tactile_m, 1),
                "indoor_metres": round(indoor_m, 1),
                "lifts": lifts,
                "used_stairs": used_stairs,
                "edges": len(edge_path),
                "origin_snap_m": round(src_d, 1),
                "destination_snap_m": round(dst_d, 1),
                "origin_relocated": src_moved,
                "destination_relocated": dst_moved,
            }},
        )

    # ------------------------------------------------------------------- names
    def edge_name(self, edge_i: int, lang: str) -> str | None:
        """Street name for one edge, or None. Falls back to the other language."""
        if self.name_idx is None:
            return None
        k = int(self.name_idx[edge_i])
        if k < 0:
            return None
        primary = self.names_tc if lang == "yue" else self.names_en
        secondary = self.names_en if lang == "yue" else self.names_tc
        if k < len(primary) and primary[k]:
            return primary[k]
        if k < len(secondary) and secondary[k]:
            return secondary[k]
        return None

    def _dominant_name(self, edge_path, lo: int, hi: int, lang: str) -> str | None:
        """Most common name across one segment's edges.

        Not the first edge: segments usually begin on an unnamed connector (a
        crossing, a kerb ramp), so keying off the first edge would leave most
        segments anonymous even when the street they run along is named.
        """
        counts: dict[str, int] = {}
        for ei in edge_path[lo:hi]:
            nm = self.edge_name(ei, lang)
            if nm:
                counts[nm] = counts.get(nm, 0) + 1
        if not counts:
            return None
        return max(counts.items(), key=lambda kv: kv[1])[0]

    # ------------------------------------------------------------- instructions
    def _instructions(self, node_path, edge_path, total_m, lang, used_stairs, tactile_m):
        """Turn-by-turn, mixing street names with distances.

        Three rules, each learned from a specific failure:

        1. Distances are SEGMENT lengths — how far to go before the *next*
           change — not the distance remaining. Saying "turn right, then
           continue 198 m" on a 236 m route reads as if 198 m were the next leg.

        2. A street name is announced only when it CHANGES. Repeating "onto
           Nathan Road" at every bend of the same road is noise.

        3. The name comes from the dominant edge of the segment, not the first:
           segments usually start on an unnamed crossing or kerb ramp.

        Where an edge has no name — 78% of the network, because most Hong Kong
        footways are unnamed in OSM — the instruction falls back to a distance.
        """
        pts = [(self.node_lat[n], self.node_lon[n]) for n in node_path]
        bearings = [bearing_deg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
                    for i in range(len(pts) - 1)]

        # cumulative distance at every edge boundary
        cum = [0.0]
        for ei in edge_path:
            cum.append(cum[-1] + float(self.edge_len[ei]))

        # turns as (at_m, word, edge_index) so segments can be sliced per name
        raw: list[tuple[float, str, int]] = []
        for i in range(1, len(bearings)):
            delta = ((bearings[i] - bearings[i - 1] + 540.0) % 360.0) - 180.0
            word = _turn_word(delta)
            if word is None:
                continue
            if raw and raw[-1][1] == word:
                continue                       # still the same bend
            raw.append((cum[i], word, i))

        # A 3 m "bear right" is the graph's segment granularity, not an
        # instruction a person can act on.
        turns: list[tuple[float, str, int]] = []
        for idx, (at_m, word, ei) in enumerate(raw):
            nxt = raw[idx + 1][0] if idx + 1 < len(raw) else total_m
            if (nxt - at_m) < 5.0 and word.startswith("slight"):
                continue
            turns.append((at_m, word, ei))

        steps: list[dict[str, Any]] = []

        # ---- departure
        first_end = turns[0][2] if turns else len(edge_path)
        first_name = self._dominant_name(edge_path, 0, first_end, lang)
        first_seg = turns[0][0] if turns else total_m
        if first_name:
            say = _DEPART_ON[lang].format(
                street=first_name,
                compass=_compass_word(bearings[0], lang),
                distance=_format_distance(first_seg, lang))
        else:
            say = _DEPART[lang].format(
                compass=_compass_word(bearings[0], lang),
                distance=_format_distance(first_seg, lang))
        steps.append({"at_m": 0.0, "type": "depart", "say": say,
                      "street": first_name, "named": bool(first_name),
                      # keep the raw bearing for clients that know the user's
                      # heading and can turn it into a clock face ("2 o'clock"),
                      # which is more precise than a compass point
                      "bearing": int(round(bearings[0])),
                      "compass": _compass_word(bearings[0], lang)})

        # ---- turns
        last_name = first_name
        for idx, (at_m, word, ei) in enumerate(turns):
            nxt = turns[idx + 1][0] if idx + 1 < len(turns) else total_m
            seg_end = turns[idx + 1][2] if idx + 1 < len(turns) else len(edge_path)
            segment = max(nxt - at_m, 0.0)

            nm = self._dominant_name(edge_path, ei, seg_end, lang)
            changed = nm if (nm and nm != last_name) else None

            if changed:
                tmpl = (_TURN_ONTO[word][lang] if segment >= 10.0
                        else _TURN_ONTO_NOW[word][lang])
                say = tmpl.format(street=changed,
                                  distance=_format_distance(segment, lang))
            else:
                say = (_TURN[word][lang].format(distance=_format_distance(segment, lang))
                       if segment >= 10.0 else _TURN_NOW[word][lang])

            steps.append({"at_m": round(at_m, 1), "type": word, "say": say,
                          "street": nm, "named": bool(nm)})
            if nm:
                last_name = nm

        if used_stairs:
            steps.append({"at_m": 0.0, "type": "warning", "say": _STAIRS_WARN[lang]})
        if tactile_m == 0:
            steps.append({"at_m": 0.0, "type": "warning", "say": _NO_TACTILE[lang]})
        steps.append({"at_m": round(total_m, 1), "type": "arrive", "say": _ARRIVE[lang]})
        return steps


# ---------------------------------------------------------------------- service

class RoutingService:
    """Facade over the surveyed router, with a straight-line fallback."""

    def __init__(self, index_path: Path | None = None):
        self.index_path = Path(index_path) if index_path else INDEX_PATH
        self.graph: GraphRouter | None = None
        self.load_error: str | None = None

    # ---------------------------------------------------------------- lifecycle
    def startup(self) -> None:
        if not self.index_path.exists():
            self.load_error = f"index not found at {self.index_path}"
            return
        try:
            self.graph = GraphRouter(self.index_path)
        except Exception as exc:                        # noqa: BLE001
            self.load_error = f"{type(exc).__name__}: {exc}"
            self.graph = None

    def shutdown(self) -> None:
        self.graph = None

    @property
    def NAME(self) -> str:                              # noqa: N802 - contract name
        return "surveyed" if self.graph is not None else "straight-line"

    # ------------------------------------------------------------------- routes
    def route(self, origin, destination, persona: str = "unfamiliar",
              language: str = "yue") -> RouteResult:
        if persona not in PERSONAS:
            raise RoutingError(f"unknown persona; valid: {sorted(PERSONAS)}",
                               code="bad_persona")
        for label, (la, lo) in (("origin", origin), ("destination", destination)):
            if not _inside_hong_kong(la, lo):
                raise RoutingError(f"{label} {la:.4f},{lo:.4f} is outside Hong Kong",
                                   code="outside_coverage")

        if self.graph is not None:
            return self.graph.route(origin, destination, persona, language)
        return self._straight_line(origin, destination, persona, language)

    def _straight_line(self, origin, destination, persona, language) -> RouteResult:
        lang = language if language in DISCLAIMER else "en"
        metres = haversine_m(origin[0], origin[1], destination[0], destination[1])
        if metres < 1.0:
            raise RoutingError("origin and destination are the same point",
                               code="same_point")
        bearing = bearing_deg(origin[0], origin[1], destination[0], destination[1])
        steps = [
            {"at_m": 0.0, "type": "warning", "say": _INTRO[lang]},
            {"at_m": 0.0, "type": "depart", "say": _BEARING[lang].format(
                compass=_compass_word(bearing, lang),
                distance=_format_distance(metres, lang))},
            {"at_m": round(metres, 1), "type": "arrive", "say": _ARRIVE[lang]},
        ]
        return RouteResult(
            origin=origin, destination=destination, steps=steps,
            distance_m=round(metres, 1),
            duration_s=round(metres / WALKING_SPEED_MPS, 1),
            speaker="straight-line", persona=persona,
            notes=["straight-line estimate; not a surveyed footpath route"],
            extra={"disclaimer": DISCLAIMER[lang]},
        )

    # ------------------------------------------------------------------- nearby
    def nearby(self, latitude: float, longitude: float, radius_m: float = 25.0,
               limit: int = 10) -> dict[str, Any]:
        if not _inside_hong_kong(latitude, longitude):
            raise RoutingError(f"{latitude:.4f},{longitude:.4f} is outside Hong Kong",
                               code="outside_coverage")
        if self.graph is None:
            return {
                "query": {"lat": latitude, "lon": longitude, "radius_m": radius_m},
                "position_quality": {"quality": "unknown", "edges_within_10m": 0,
                                     "caveat": "no surveyed index loaded"},
                "edges": [], "router": self.NAME, "limit": limit,
            }
        g = self.graph
        d = _hav_vec(np.float64(latitude), np.float64(longitude),
                     np.asarray(g.node_lat), np.asarray(g.node_lon))
        order = np.argsort(d)[:limit]
        edges = [{"node": int(n), "offset_m": round(float(d[n]), 2)}
                 for n in order if float(d[n]) <= radius_m]
        return {
            "query": {"lat": latitude, "lon": longitude, "radius_m": radius_m},
            "position_quality": {
                "quality": "weak" if (not edges or edges[0]["offset_m"] > 10) else "ok",
                "nearest_node_offset_m": edges[0]["offset_m"] if edges else None,
                "edges_within_10m": sum(1 for e in edges if e["offset_m"] <= 10),
                "caveat": "nodes only; edge-level candidates need the feature table",
            },
            "edges": edges, "router": self.NAME, "limit": limit,
        }

    def personas(self) -> dict[str, Any]:
        return {"personas": PERSONAS, "router": self.NAME}

    def health(self) -> dict[str, Any]:
        if self.graph is None:
            return {"status": "degraded", "router": self.NAME, "surveyed": False,
                    "reason": self.load_error,
                    "note": "falling back to straight-line estimates"}
        return {"status": "ok", "router": self.NAME, "surveyed": True,
                "edges": int(self.graph.n_edges), "nodes": int(self.graph.n_nodes),
                "accessibility_optimised": True}
