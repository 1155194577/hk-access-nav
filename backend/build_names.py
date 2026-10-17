#!/usr/bin/env python3
"""
build_names.py — build the street-name sidecar for the routing index.

    python3 build_names.py \
        --pbf  ../../hackathon/data/raw/hong-kong-latest.osm.pbf \
        --csv  ../../hackathon/data/csv/edges_enriched.csv \
        --index data/index/nearby.npz \
        --out  data/index/names.npz

WHY THIS EXISTS
---------------
`nearby.npz` carries no street names, and neither does `edges_enriched.csv`. The
CSV does carry `way_id` (the OSM way), and the OSM extract has that way's tags, so
the name is recoverable — this script performs that join once and stores the
result as a small sidecar.

Coverage is genuinely partial: most Hong Kong footways, crossings and footbridges
have no `name` in OSM. Measured on the current extract, about 22% of edges
resolve to a named way. Instructions therefore mix street names with distances —
"turn right onto 長沙灣道" where a name exists, "turn right after 12 m" where it
does not. That is a property of the source data, not of this script.

OUTPUT FORMAT (data/index/names.npz)
    name_idx  int32[n_edges]   index into `en`/`tc`, -1 where the edge is unnamed
    en        unicode[n]       English names, interned
    tc        unicode[n]       Chinese names, interned
    meta      unicode[1]       JSON: counts and the source hashes

A sidecar rather than a rewrite of nearby.npz, so the 19 MB index stays byte
identical to the pipeline's output and this can be regenerated independently.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
try:
    import pbf_scan
except ModuleNotFoundError:                      # pragma: no cover
    # Fall back to the pipeline's tools/ directory, wherever it lives.
    sys.path.insert(0, str(Path.home() / "Desktop" / "hackathon" / "tools"))
    import pbf_scan

import numpy as np

NAME_KEYS_EN = ("name:en",)
NAME_KEYS_ZH = ("name:zh", "name:zh-Hant", "name:zh-Hans", "name:yue", "name:zh-yue")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def way_names(pbf: Path) -> dict[int, tuple[str, str]]:
    """way_id -> (en, tc). Falls back to `name` when a language tag is absent."""
    out: dict[int, tuple[str, str]] = {}
    blocks = 0
    for btype, raw in pbf_scan.iter_blocks(pbf):
        if btype != "OSMData":
            continue
        blocks += 1
        st = None
        groups = []
        for field, _, val, _ in pbf_scan.iter_fields(raw):
            if field == 1:
                st = pbf_scan.parse_stringtable(val)
            elif field == 2:
                groups.append(val)
        if st is None:
            continue
        for g in groups:
            for f2, _, val2, _ in pbf_scan.iter_fields(g):
                if f2 != 3:                      # 3 == Way
                    continue
                wid, keys, vals = None, [], []
                for f3, _, v3, _ in pbf_scan.iter_fields(val2):
                    if f3 == 1:
                        wid = v3
                    elif f3 == 2:
                        keys = pbf_scan.packed_varints(v3)
                    elif f3 == 3:
                        vals = pbf_scan.packed_varints(v3)
                if wid is None or not keys:
                    continue
                tags = {st[k]: st[v] for k, v in zip(keys, vals)
                        if k < len(st) and v < len(st)}
                base = tags.get("name")
                en = next((tags[k] for k in NAME_KEYS_EN if k in tags), None)
                zh = next((tags[k] for k in NAME_KEYS_ZH if k in tags), None)
                if not (base or en or zh):
                    continue
                # OSM's `name` in HK is often "English 中文" joined; keep the
                # language tags when present and only use `name` as the fallback.
                out[wid] = (en or base or "", zh or base or "")
    log(f"  pbf: {blocks} data block(s), {len(out):,} named ways")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the street-name sidecar")
    ap.add_argument("--pbf", required=True, type=Path)
    ap.add_argument("--csv", required=True, type=Path)
    ap.add_argument("--index", default=Path("data/index/nearby.npz"), type=Path)
    ap.add_argument("--out", default=Path("data/index/names.npz"), type=Path)
    args = ap.parse_args()

    for p in (args.pbf, args.csv, args.index):
        if not p.exists():
            log(f"error: not found: {p}")
            return 1

    t0 = time.time()
    log("reading index edge ids")
    z = np.load(args.index, allow_pickle=False)
    edge_ids = z["edges"]["edge_id"].astype(np.int64)
    n = len(edge_ids)
    log(f"  {n:,} edges")

    wanted = set(edge_ids.tolist())
    log("reading edge_id -> way_id from the CSV")
    edge_to_way: dict[int, int] = {}
    rows = 0
    with open(args.csv, newline="") as fh:
        for row in csv.DictReader(fh):
            rows += 1
            try:
                eid = int(row["edge_id"])
                if eid in wanted:
                    edge_to_way[eid] = int(row["way_id"])
            except (KeyError, ValueError, TypeError):
                continue
    log(f"  {rows:,} CSV rows -> {len(edge_to_way):,} matched to the index")

    log("reading way names from the OSM extract")
    ways = way_names(args.pbf)

    # intern the names
    names: dict[tuple[str, str], int] = {}
    ens: list[str] = []
    tcs: list[str] = []
    name_idx = np.full(n, -1, dtype=np.int32)
    for i, eid in enumerate(edge_ids.tolist()):
        wid = edge_to_way.get(eid)
        if wid is None:
            continue
        pair = ways.get(wid)
        if pair is None:
            continue
        en, tc = pair
        if not en and not tc:
            continue
        key = (en, tc)
        idx = names.get(key)
        if idx is None:
            idx = len(ens)
            names[key] = idx
            ens.append(en)
            tcs.append(tc)
        name_idx[i] = idx

    named = int((name_idx >= 0).sum())
    log(f"  {named:,} of {n:,} edges named ({named / n * 100:.1f}%)")
    log(f"  {len(ens):,} unique names")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.out,
        name_idx=name_idx,
        en=np.array(ens, dtype=object).astype("U"),
        tc=np.array(tcs, dtype=object).astype("U"),
        meta=np.array([json.dumps({
            "edges": n,
            "named": named,
            "unique_names": len(ens),
            "index_sha256": sha256(args.index),
            "pbf_sha256": sha256(args.pbf),
            "csv_sha256": sha256(args.csv),
        })]),
    )
    size = args.out.stat().st_size
    log(f"wrote {args.out} ({size / 1e6:.2f} MB) in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
