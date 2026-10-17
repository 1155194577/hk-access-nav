# data/index — what these binaries are, and how to rebuild them

Two committed artefacts. Both are **generated**; do not hand-edit.

| File | Size | Contents |
|---|---:|---|
| `nearby.npz` | 20 MB | 707,478 edges / 680,573 nodes / 265,477 decision points. The routing graph. |
| `names.npz` | 120 KB | `name_idx` (int32 per edge, −1 = unnamed) + 3,015 interned `en`/`tc` pairs |

`routing.py` loads only `nearby.npz`. `names.npz` is optional — without it,
instructions fall back to distances instead of street names.

## nearby.npz

Built by the data pipeline's Stage 2 → Stage 3 → index steps:

```
./build.sh conflate --d-max 6.0     # TD tactile guide paths -> tau/cov
./build.sh enrich                   # CSDI infrastructure -> lifts/ramps/gradient/barriers
./build.sh index                    # edges_enriched.csv -> nearby.npz
```

then copied here from `<pipeline>/data/index/nearby.npz`.

### Why `--d-max 6.0` and not the pipeline default of 4.0

The conflation gate matches a TD guide-path segment to a pedestrian edge when
the perpendicular offset is under `d_max`, the bearing is within 25°, and the
overlap is at least 30%. Raising `d_max` matches more guide path, and the risk is
matching the guide path on the **opposite side of a road** — which would tell a
blind user there are tactile tiles where there are none.

Measured sweep (same matcher, same inputs):

| `d_max` | guide path matched | `tau=present` | p95 offset | matches **>6 m** |
|---|---|---|---|---|
| 2.0 | 44.7% | 1,032 | 1.86 m | 0 |
| 4.0 *(default)* | 62.2% | 1,649 | 3.68 m | 0 |
| **6.0** | **67.3%** | **1,949** | 5.33 m | **0** |
| 8.0 | 69.3% | 2,187 | 7.15 m | 483 |
| 10.0 | 70.7% | 2,427 | 8.97 m | 945 |
| 12.0 | 72.1% | 2,608 | 10.82 m | 1,378 |

The `>6 m` column is the one that matters: **nothing is accepted beyond 6 m until
`d_max` is raised past 6 m**, so 6.0 is the last setting that adds coverage
without admitting cross-road matches. Recall also flattens there (62.2 → 67.3 →
69.3), so the gain is real but bounded.

Result: `tau=present` 1,649 → **1,949** globally (+18%); in the Cheung Sha Wan
box 99 → **118 edges (2.03% → 2.42%)**. OSM/TD conflicts unchanged at 28, i.e. no
new disagreements with independently mapped `tactile_paving` tags.

### The ceiling is the source data, not the gate

Even at 12 m, only 72% of the guide path matches, and **32.7% of it has no
pedestrian edge within 6 m at all** — those are places where TD publishes a guide
path and OSM has no footway within 6 m (streets mapped only as roads, or indoor
paths). Loosening the gate further cannot fix that; it needs better edges.

Tactile remains sparse by nature: ~0.3% of edges territory-wide, ~2.4% in Cheung
Sha Wan. That is why `TACTILE_REWARD` in `routing.py` (a 5% cost discount) is
measured to change no routes — there is no tactile corridor dense enough to
compete with the shortest path. Do not claim "tactile prioritised routing" on the
strength of that weight. See the sweep above for what the data actually supports.

## names.npz

Built by `backend/build_names.py` from the OSM extract plus the pipeline's
`edges_enriched.csv`:

```
python3 build_names.py \
    --pbf  <pipeline>/data/raw/hong-kong-latest.osm.pbf \
    --csv  <pipeline>/data/csv/edges_enriched.csv \
    --index data/index/nearby.npz \
    --out   data/index/names.npz
```

`name_idx` is aligned to the **row order of `nearby.npz`**, so it must be rebuilt
whenever the index is. The cheap guard is the length check in `GraphRouter`; the
correct check is that the `edge_id` array is unchanged. After the `d_max` rebuild
it was verified byte-identical, so this sidecar did not need regenerating.

Coverage: 22.4% of edges (most Hong Kong footways are unnamed in OSM).

## CSDI augmentation (graph completeness)

32.7% of the TD guide path had no OSM pedestrian edge within 6 m. Measured cause:

| Of the 17.39 km unmatched guide path | |
|---|---|
| has a **CSDI 3DPN** segment within 6 m | **9.62 km (55.3%)** |
| nothing from either source | 7.77 km (44.7%) |

So most of the gap was OSM missing pedestrian geometry that CSDI already has.
`backend/build_csdi_edges.py` adds **only** the CSDI segments that carry unmatched
guide path and are themselves >6 m from any OSM edge — not the whole CSDI network:

```
1,862 CSDI segments identified -> 1,064 edges added, 1,036 synthetic nodes
```

| | before | after |
|---|---|---|
| edges | 707,478 | **708,542** |
| `tau=present` | 1,949 (0.28%) | **2,635 (0.37%)** — +35% |
| Cheung Sha Wan present | 118 (2.42%) | **141 (2.87%)** |
| components | 4,909 | 5,081 |
| largest component | 402,839 | 403,146 (unchanged 56.9%) |

**45% of the added edges joined the main component** (475 of 1,064); the other 55%
formed small islands because their nodes could not be stitched to the OSM graph
within the 10 m snap radius. Of the +686 `tau=present` edges, **292 are in the
main component** and can therefore appear in a route. Treat +35% as the data gain
and **+15% as the routing gain**.

The remaining 44.7% of unmatched guide path has no geometry in either source — it
needs better data, not a better algorithm.

Stitching the islands is the obvious next improvement: the `map` prototype has a
`bridge_gaps.py` that is not part of this pipeline.
