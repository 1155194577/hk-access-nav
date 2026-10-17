#!/usr/bin/env python3
"""
build_crossings.py — derive crossing type per index edge from CSDI 3DPN.

Why a sidecar: `edges_enriched.csv` has `crossing_type` and `signal` columns, but
they are empty for all 1.4M rows — the OSM-side extraction produced nothing. The
app's offline router still speaks crossings because its graph is CSDI-derived,
where `feature_type` encodes the crossing kind directly:

    30 signalised   31 zebra   32 cautionary   33 other

So this matches CSDI crossing features onto the routing index by proximity and
writes one byte per edge. Same pattern as names.npz: a small sidecar beside the
big index, optional at load time, aligned by row order.

Output: backend/data/index/crossings.npz
    cross  uint8 per edge   0 none, 1 signalised, 2 zebra, 3 cautionary, 4 other
    meta   JSON (counts, gate, sha256 of the index)

Run from the data-pipeline tree:
    python3 <repo>/backend/build_crossings.py \
        --index <repo>/backend/data/index/nearby.npz \
        --out   <repo>/backend/data/index/crossings.npz
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np

M_PER_DEG_LAT = 111320.0
D_MAX = 3.0          # the marking sits ON the path; 6 m also labelled approaches
THETA_MAX = 45.0     # crossings are laid ACROSS the footway, so allow wide angles
#: A crossing edge is short. Long edges that merely touch a marking are approaches.
MAX_EDGE_M = 25.0
RHO_MIN = 0.0        # a crossing marking covers only part of the edge by design

#: CSDI feature_type -> our crossing code
CROSSING = {30: 1, 31: 2, 32: 3, 33: 4}
LABEL = {1: "signalised", 2: "zebra", 3: "cautionary", 4: "other"}


def seglen(a: np.ndarray) -> np.ndarray:
    return np.hypot(
        (a[:, 2] - a[:, 0]) * np.cos(np.radians((a[:, 1] + a[:, 3]) / 2)) * M_PER_DEG_LAT,
        (a[:, 3] - a[:, 1]) * M_PER_DEG_LAT,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--3dpn", dest="dpn", type=Path,
                    default=Path("data/cache/3dpn.npz"))
    a = ap.parse_args()

    z = np.load(a.index, allow_pickle=False)
    e = z["edges"]
    n = len(e)
    print(f"  index: {n:,} edges", flush=True)

    d = np.load(a.dpn, allow_pickle=False)
    cs = d["segs"].astype(np.float64)
    feats = d["feats"]
    fidx = d["feat_idx"]
    ft = feats["feature_type"][fidx]
    mask = np.isin(ft, list(CROSSING))
    cross_segs = cs[mask]
    print(f"  CSDI crossing segments: {len(cross_segs):,} of {len(cs):,}", flush=True)
    if len(cross_segs) == 0:
        raise SystemExit("no CSDI crossing features found")

    # match each index edge against crossing segments by proximity + tangency.
    # A crossing marking runs ACROSS the footway, so the bearing requirement must
    # be wide — we are asking "is this edge at a crossing", not "does it follow one".
    sys.path.insert(0, str(Path("tools").resolve()))
    import conflate as C  # noqa: E402

    ex1, ey1, ex2, ey2 = e["lon1"], e["lat1"], e["lon2"], e["lat2"]
    # conflate's matcher wants the guide side as `g`; we pass crossing segments.
    # theta_max is relaxed because the geometry is perpendicular by construction.
    cov_num, _, matches, matched_g, _ = C.match_edges_to_guide_path(
        ex1, ey1, ex2, ey2, cross_segs,
        d_max=D_MAX, theta_max=THETA_MAX, rho_min=RHO_MIN)

    # per edge, pick the most specific crossing type among accepted matches.
    # Precedence: signalised > zebra > cautionary > other — the one that changes
    # behaviour (a signal the user must wait for) wins over the generic.
    rank = {1: 4, 2: 3, 3: 2, 4: 1}
    cross = np.zeros(n, dtype=np.uint8)
    best = np.zeros(n, dtype=np.uint8)
    # recover feature type per crossing segment
    cross_ft = ft[mask]
    elen = seglen(np.column_stack([ex1, ey1, ex2, ey2]))
    for m in matches:
        if not m[6]:
            continue
        ei, gi = int(m[0]), int(m[1])
        if elen[ei] > MAX_EDGE_M:
            continue          # approach footway, not the crossing itself
        code = CROSSING.get(int(cross_ft[gi]), 0)
        if not code:
            continue
        if rank[code] > best[ei]:
            best[ei] = rank[code]
            cross[ei] = code

    counts = {LABEL[c]: int((cross == c).sum()) for c in LABEL}
    print(f"  labelled: {counts}  ({int((cross>0).sum()):,} edges, "
          f"{int((cross>0).sum())/n*100:.1f}%)", flush=True)

    a.out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        a.out,
        cross=cross,
        meta=np.array(json.dumps({
            "edges": n,
            "gate": {"d_max": D_MAX, "theta_max": THETA_MAX, "rho_min": RHO_MIN,
                     "max_edge_m": MAX_EDGE_M},
            "counts": counts,
            "index_sha256": hashlib.sha256(e.tobytes()).hexdigest()[:16],
        })),
    )
    print(f"wrote {a.out} ({a.out.stat().st_size/1024:.1f} KB)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
