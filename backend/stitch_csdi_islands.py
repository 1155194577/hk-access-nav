#!/usr/bin/env python3
"""
stitch_csdi_islands.py — merge CSDI-added islands into the routable network.

55% of the CSDI edges added by build_csdi_edges.py landed in components of their
own, because their nodes did not snap to an OSM node within 10 m. This bridges
those gaps with short virtual edges, following the algorithm in the `map`
prototype's bridge_gaps.py:

  * union-find over the whole graph to label components
  * grid search over nodes, cell = the gap radius
  * bridge a pair ONLY when the two nodes are in different components, are
    within `--gap` metres, and are not already connected
  * union as you go, so a pair is never bridged twice
  * tag every added edge `src = gap_bridge` so it is auditable and removable

DELIBERATELY SCOPED TO CSDI ISLANDS

A global pass would also bridge OSM's own 4,909 components, and many of those gaps
are real: two footway ends on opposite sides of a road with no crossing at that
point. Bridging them would let the router walk a blind pedestrian across a road
where no crossing exists. So this only bridges pairs where **at least one node
belongs to a CSDI-added edge** — it stitches the new data in, and leaves OSM's
existing fragmentation to the pipeline that owns it.

Even so, a bridge is an inferred connection, not a surveyed one. They are tagged,
their length distribution is reported, and none of them claim tactile paving.

Usage:
    python3 stitch_csdi_islands.py \
        --edges data/csv/edges_enriched.csv \
        --coords data/cache/edge_node_coords.npz \
        --out data/csv/edges_enriched_stitched.csv \
        --gap 8.0
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import math
from pathlib import Path

import numpy as np
import pandas as pd

M_PER_DEG_LAT = 111320.0


class UnionFind:
    def __init__(self) -> None:
        self.parent: dict[int, int] = {}
        self.rank: dict[int, int] = {}

    def find(self, x: int) -> int:
        self.parent.setdefault(x, x)
        self.rank.setdefault(x, 0)
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a: int, b: int) -> bool:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return False
        self.rank.setdefault(ra, 0)
        self.rank.setdefault(rb, 0)
        if self.rank[ra] < self.rank[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        if self.rank[ra] == self.rank[rb]:
            self.rank[ra] += 1
        return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--edges", default="data/csv/edges_enriched.csv", type=Path)
    ap.add_argument("--coords", default="data/cache/edge_node_coords.npz", type=Path)
    ap.add_argument("--out", default="data/csv/edges_enriched_stitched.csv", type=Path)
    ap.add_argument("--gap", type=float, default=8.0, help="max bridge length, metres")
    ap.add_argument("--max-bridges", type=int, default=6000)
    a = ap.parse_args()

    print("loading edges ...", flush=True)
    e = pd.read_csv(a.edges, low_memory=False)
    print(f"  {len(e):,} edges", flush=True)
    z = np.load(a.coords)
    ids = z["ids"]; lons = z["lons"]; lats = z["lats"]
    coord = {int(i): (float(lo), float(la)) for i, lo, la in zip(ids, lons, lats)}
    print(f"  {len(coord):,} node coordinates", flush=True)

    is_csdi = (e["src"].astype(str) == "csdi").to_numpy()
    print(f"  {int(is_csdi.sum()):,} CSDI-added edges", flush=True)

    print("labelling components ...", flush=True)
    uf = UnionFind()
    for u, v in zip(e["from_node"].to_numpy(), e["to_node"].to_numpy()):
        uf.union(int(u), int(v))
    roots = {n: uf.find(n) for n in list(uf.parent)}
    size = defaultdict(int)
    for n in roots:
        size[roots[n]] += 1
    main_root = max(size, key=size.get)
    print(f"  {len(size):,} components; largest {size[main_root]:,} nodes", flush=True)
    csdi_nodes = set()
    for u, v in zip(e["from_node"][is_csdi], e["to_node"][is_csdi]):
        csdi_nodes.add(int(u)); csdi_nodes.add(int(v))
    islands = {n for n in csdi_nodes if uf.find(n) != main_root}
    print(f"  {len(csdi_nodes):,} CSDI nodes, {len(islands):,} outside the main component",
          flush=True)

    print(f"searching gaps <= {a.gap} m ...", flush=True)
    cell_lat = a.gap / M_PER_DEG_LAT
    subject = [n for n in islands if n in coord]
    grid = defaultdict(list)
    # index the WHOLE graph, so an island can reach either the main component or
    # another island that is already connected to it
    for n, (lo, la) in coord.items():
        grid[(int(la / cell_lat), int(lo / (cell_lat / math.cos(math.radians(la)))))].append(n)

    existing = set(zip(e["from_node"].tolist(), e["to_node"].tolist()))
    bridges = []
    for n in subject:
        if len(bridges) >= a.max_bridges:
            break
        lo, la = coord[n]
        cl = cell_lat / math.cos(math.radians(la))
        gx, gy = int(la / cell_lat), int(lo / cl)
        rn = uf.find(n)
        best = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for m in grid.get((gx + dx, gy + dy), ()):
                    if m == n:
                        continue
                    if uf.find(m) == rn:
                        continue                       # already same component
                    if (n, m) in existing or (m, n) in existing:
                        continue
                    lo2, la2 = coord[m]
                    d = math.hypot((lo2 - lo) * math.cos(math.radians(la)) * M_PER_DEG_LAT,
                                   (la2 - la) * M_PER_DEG_LAT)
                    if 0.5 <= d <= a.gap and (best is None or d < best[0]):
                        best = (d, m)
        if best:
            d, m = best
            uf.union(n, m)
            existing.add((n, m)); existing.add((m, n))
            bridges.append((n, m, d))
    print(f"  {len(bridges):,} bridges found", flush=True)
    if not bridges:
        print("  nothing to stitch"); return 0

    lens = np.array([b[2] for b in bridges])
    print(f"  bridge length: median {np.median(lens):.1f} m, p95 {np.percentile(lens,95):.1f} m, "
          f"max {lens.max():.1f} m", flush=True)

    next_id = int(e["edge_id"].max()) + 1
    rows = []
    for n, m, d in bridges:
        rows.append({
            "edge_id": next_id, "from_node": n, "to_node": m,
            "way_id": -1, "reverse_of": -1, "direction": 1,
            "length_m": round(d, 2), "path_class": "footway",
            "osm_tactile": "", "tau": "unknown", "cov": 0.0,
            "w": 0, "kerb": "", "dropped_kerb": "", "crossing_type": "",
            "signal": "", "gradient": -1.0, "obstacle": "", "cover": "",
            "indoor": 0, "p": "", "conf": "", "agree": "", "src": "gap_bridge",
            "wheelchair_barrier": 0, "has_lift": 0, "has_ramp": 0,
            "has_escalator": 0, "has_stairlift": 0, "enabler": "",
            "csdi_type": "", "csdi_source": "", "join_offset_m": "",
        })
        next_id += 1
    out = pd.concat([e, pd.DataFrame(rows)], ignore_index=True)
    out.to_csv(a.out, index=False)
    print(f"wrote {a.out} ({len(e):,} + {len(rows):,} = {len(out):,} rows)", flush=True)

    # report the effect, measured on the stitched frame itself
    uf2 = UnionFind()
    for u, v in zip(out["from_node"].to_numpy(), out["to_node"].to_numpy()):
        uf2.union(int(u), int(v))
    size2 = defaultdict(int)
    for n in list(uf2.parent):
        size2[uf2.find(n)] += 1
    main2 = max(size2, key=size2.get)
    extra = (out["src"].astype(str) == "csdi") | (out["src"].astype(str) == "gap_bridge")
    in_main = sum(1 for u in out["from_node"][extra]
                  if uf2.find(int(u)) == main2)
    csdi_only = (out["src"].astype(str) == "csdi")
    csdi_in_main = sum(1 for u in out["from_node"][csdi_only]
                       if uf2.find(int(u)) == main2)
    print(f"  components {len(size):,} -> {len(size2):,}; "
          f"largest {size[main_root]:,} -> {size2[main2]:,} nodes", flush=True)
    print(f"  CSDI edges in main component: "
          f"{sum(is_csdi)} -> {csdi_in_main}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
