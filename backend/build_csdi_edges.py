#!/usr/bin/env python3
"""
build_csdi_edges.py — add CSDI 3DPN pedestrian edges where OSM has none.

Run from the data-pipeline tree (it imports the pipeline's conflate module):

    cd <pipeline>
    python3 <repo>/backend/build_csdi_edges.py

Augment the pedestrian graph with CSDI 3DPN where OSM has no edge.

Measured motivation: of the 17.39 km of TD guide path that the OSM graph cannot
match within 6 m, 9.62 km (55.3%) has a CSDI 3DPN segment within 6 m. This tool
adds exactly those CSDI segments — the ones that carry unmatched guide path and
are not already near an OSM edge — so the next conflate pass can match it.

Deliberately NARROW:

  * only CSDI segments within 6 m of guide path that OSM failed to match
  * only segments that are themselves >6 m from any OSM edge
  * nodes snap to an OSM node within 10 m, otherwise get a synthetic id above
    the OSM id range, so no existing id is ever reused

Writes NEW files, never in place:
    data/csv/edges_enriched_augmented.csv
    data/cache/edge_node_coords_augmented.npz
    data/csv/csdi_added.csv   (audit)
"""
import sys
sys.path.insert(0, "tools")
from collections import defaultdict
import json

import numpy as np
import pandas as pd
import conflate as C

ROOT = C.ROOT
CSV_DIR = ROOT / "data" / "csv"
CACHE = ROOT / "data" / "cache"
RAW = ROOT / "data" / "raw"
M = C.M_PER_DEG_LAT

D_MAX = 6.0          # same gate as conflate
SNAP_M = 10.0        # CSDI node -> OSM node merge radius
SYNTH_BASE = 20_000_000_000

# CSDI feature_type -> the graph's existing path_class vocabulary
FT_CLASS = {
    1: "footway", 2: "footbridge", 4: "subway", 5: "footway", 6: "footway",
    7: "footway", 8: "corridor", 9: "travelator", 10: "corridor", 11: "ramp",
    12: "steps", 13: "steps", 14: "footway", 23: "path", 24: "path",
    25: "path", 26: "path", 30: "footway", 31: "footway", 32: "footway",
    33: "footway",
}


def seglen(a):
    return np.hypot((a[:, 2] - a[:, 0]) * np.cos(np.radians((a[:, 1] + a[:, 3]) / 2)) * M,
                    (a[:, 3] - a[:, 1]) * M)


class NodeGrid:
    """Nearest-node lookup on a ~25 m grid."""

    def __init__(self, ids, lons, lats):
        self.ids, self.lons, self.lats = ids, lons, lats
        self.cells = defaultdict(list)
        self.cell = 0.00025
        for i in range(len(ids)):
            self.cells[(int(lons[i] // self.cell), int(lats[i] // self.cell))].append(i)

    def nearest(self, lon, lat, max_m):
        cx, cy = int(lon // self.cell), int(lat // self.cell)
        best, best_d = None, max_m
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in self.cells.get((cx + dx, cy + dy), ()):
                    d = np.hypot((self.lons[i] - lon) * np.cos(np.radians(lat)) * M,
                                 (self.lats[i] - lat) * M)
                    if d < best_d:
                        best_d, best = d, i
        return best, best_d


def main() -> int:
    print("loading OSM edges ...", flush=True)
    edges = pd.read_csv(CSV_DIR / "edges.csv",
                        dtype={"from_node": "int64", "to_node": "int64",
                               "way_id": "int64", "edge_id": "int64"})
    needed = set(edges.from_node.tolist()) | set(edges.to_node.tolist())
    coords = C.node_coords_for(RAW / "hong-kong-latest.osm.pbf", needed,
                               CACHE / "edge_node_coords.npz")
    _, _, _, e_ax, e_ay, e_bx, e_by = C.build_edge_segments(edges, coords)
    print(f"  {len(e_ax):,} undirected OSM edges", flush=True)

    print("loading TD guide path ...", flush=True)
    g, _ = C.to_segments(C.wfs_layer("DTAD_TG_PATH_LINE"))

    print("which guide path does OSM already match? ...", flush=True)
    _, _, _, matched_osm, _ = C.match_edges_to_guide_path(
        e_ax, e_ay, e_bx, e_by, g, d_max=D_MAX, theta_max=25.0, rho_min=0.30)
    unmatched = g[~matched_osm]
    print(f"  unmatched guide path: {len(unmatched):,} segs, "
          f"{seglen(unmatched).sum()/1000:.2f} km", flush=True)

    print("loading CSDI 3DPN ...", flush=True)
    z = np.load(CACHE / "3dpn.npz", allow_pickle=False)
    cs, feats = z["segs"].astype(np.float64), z["feats"]
    print(f"  {len(cs):,} CSDI sub-segments", flush=True)

    print("CSDI segments carrying unmatched guide path ...", flush=True)
    _, _, matches, _, _ = C.match_edges_to_guide_path(
        cs[:, 0], cs[:, 1], cs[:, 2], cs[:, 3], unmatched,
        d_max=D_MAX, theta_max=25.0, rho_min=0.30)
    # matches are (edge_idx, guide_idx, d_perp, theta, rho, ov, accepted, reason):
    # element 0 is the CSDI segment, element 1 is the guide segment. Collecting
    # m[1] here silently picked guide indices and selected arbitrary CSDI rows.
    keep = sorted({m[0] for m in matches if m[6]})
    print(f"  {len(keep):,} CSDI segments carry guide path OSM cannot match", flush=True)

    print("dropping those already near an OSM edge ...", flush=True)
    sub = cs[keep]
    _, _, _, has_osm, _ = C.match_edges_to_guide_path(
        e_ax, e_ay, e_bx, e_by, sub, d_max=D_MAX, theta_max=25.0, rho_min=0.30)
    add_idx = np.array(keep, dtype=np.int64)[~has_osm]
    added = cs[add_idx]
    print(f"  {len(added):,} CSDI segments are genuinely new "
          f"({seglen(added).sum()/1000:.2f} km)", flush=True)
    if len(added) == 0:
        print("  nothing to add"); return 0

    # tactile state for the new edges, from the full guide path
    print("computing tau for the new edges ...", flush=True)
    cov_num, _, _, _, _ = C.match_edges_to_guide_path(
        added[:, 0], added[:, 1], added[:, 2], added[:, 3], g,
        d_max=D_MAX, theta_max=25.0, rho_min=0.30)
    L = seglen(added)
    with np.errstate(divide="ignore", invalid="ignore"):
        cov = np.clip(np.where(L > 0, cov_num / L, 0.0), 0.0, 1.0)
    tau = np.where(cov >= 0.80, "present", np.where(cov > 0.15, "partial", "unknown"))
    print(f"  tau present {int((tau=='present').sum()):,} | "
          f"partial {int((tau=='partial').sum()):,}", flush=True)

    # ---- nodes: dedupe endpoints, snap to OSM, else synthetic
    print("building nodes ...", flush=True)
    zc = np.load(CACHE / "edge_node_coords.npz")
    grid = NodeGrid(zc["ids"], zc["lons"], zc["lats"])
    keymap, node_id, new_ids, new_lons, new_lats = {}, {}, [], [], []
    next_synth = SYNTH_BASE

    def node_for(lon, lat):
        nonlocal next_synth
        k = (round(lon, 6), round(lat, 6))
        if k in keymap:
            return keymap[k]
        i, _ = grid.nearest(lon, lat, SNAP_M)
        if i is not None:
            nid = int(zc["ids"][i])
        else:
            nid = next_synth
            next_synth += 1
            new_ids.append(nid); new_lons.append(lon); new_lats.append(lat)
        keymap[k] = nid
        return nid

    rows = []
    max_eid = int(pd.read_csv(CSV_DIR / "edges_enriched.csv",
                              usecols=["edge_id"])["edge_id"].max())
    fi = z["feat_idx"][add_idx]
    for j in range(len(added)):
        lon1, lat1, lon2, lat2 = added[j]
        u = node_for(lon1, lat1)
        v = node_for(lon2, lat2)
        if u == v:
            continue
        f = feats[fi[j]]
        ft = int(f["feature_type"])
        rows.append({
            "edge_id": max_eid + 1 + j,
            "from_node": u, "to_node": v,
            "way_id": -1, "reverse_of": -1, "direction": 1,
            "length_m": round(float(L[j]), 2),
            "path_class": FT_CLASS.get(ft, "footway"),
            "osm_tactile": "", "tau": str(tau[j]), "cov": round(float(cov[j]), 4),
            "w": 0, "kerb": "", "dropped_kerb": "", "crossing_type": "",
            "signal": "", "gradient": float(f["gradient"]) if np.isfinite(f["gradient"]) else -1.0,
            "obstacle": "", "cover": "", "indoor": 1 if int(f["location"]) == 2 else 0,
            "p": "", "conf": "", "agree": "", "src": "csdi",
            "wheelchair_barrier": 1 if int(f["wheelchair_barrier"]) == 1 else 0,
            "has_lift": 1 if ft == 10 else 0,
            "has_ramp": 1 if ft == 11 else 0,
            "has_escalator": 1 if ft == 8 else 0,
            "has_stairlift": 1 if ft == 13 else 0,
            "enabler": "", "csdi_type": ft, "csdi_source": int(f["data_source"]),
            "join_offset_m": "",
        })
    print(f"  {len(rows):,} edges written, {len(new_ids):,} synthetic nodes", flush=True)

    add_df = pd.DataFrame(rows)
    add_df.to_csv(CSV_DIR / "csdi_added.csv", index=False)

    print("merging into a new edges_enriched.csv ...", flush=True)
    base = pd.read_csv(CSV_DIR / "edges_enriched.csv", low_memory=False)
    merged = pd.concat([base, add_df], ignore_index=True)
    merged.to_csv(CSV_DIR / "edges_enriched_augmented.csv", index=False)
    print(f"  {len(base):,} + {len(add_df):,} = {len(merged):,} rows", flush=True)

    np.savez_compressed(
        CACHE / "edge_node_coords_augmented.npz",
        ids=np.concatenate([zc["ids"], np.array(new_ids, dtype=np.int64)]),
        lons=np.concatenate([zc["lons"], np.array(new_lons, dtype=np.float64)]),
        lats=np.concatenate([zc["lats"], np.array(new_lats, dtype=np.float64)]),
    )
    print(f"  node coords: {len(zc['ids']):,} + {len(new_ids):,}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
