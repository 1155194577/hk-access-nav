"""Is the CSDI 3D Pedestrian Network actually routable?

The entire routing architecture depends on one assumption nobody has verified:
that `csdi:PedestrianRoute` is a CONNECTED graph rather than a set of unlinked
fragments. If it is fragmented, no amount of accessibility metadata helps.

This fetches the network for a small area, builds a graph from shared
coordinates, and reports:
  * how many features arrived
  * how many distinct edges vs distinct vertices
  * how many connected components
  * the size of the largest component
  * whether two nearby points actually connect

If the largest component covers most edges, the dataset is routable. If the graph
shatters into hundreds of 1-2 edge islands, it is not, and that kills the plan
cheaply.

Run:  python csdi_connectivity.py [min_lat min_lon max_lat max_lon]
"""

import json
import sys
import urllib.parse
import urllib.request
from collections import defaultdict, deque

DATASET = "landsd_rcd_1637222018065_52265"
WFS = (
    f"https://portal.csdi.gov.hk/server/services/common/{DATASET}/MapServer/WFSServer"
)

# Default: Central / Admiralty, a dense area that should be well mapped.
DEFAULT_BBOX = (22.2770, 114.1560, 22.2880, 114.1700)


def fetch(bbox, page_size=1000, max_pages=12):
    features = []
    for page in range(max_pages):
        params = {
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": "csdi:PedestrianRoute",
            "outputFormat": "GeoJSON",
            "srsName": "EPSG:4326",
            "bbox": ",".join(str(v) for v in bbox),
            "count": str(page_size),
            "resultType": "results",
            "startIndex": str(page * page_size),
        }
        url = f"{WFS}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as response:
            payload = json.load(response)

        got = payload.get("features", [])
        features.extend(got)
        print(f"  page {page}: +{len(got)} (total {len(features)})")
        if len(got) < page_size:
            break
    return features


def key(lon, lat, dp=6):
    """Vertex identity. 6 dp is ~0.1 m, so shared endpoints match exactly."""
    return (round(lon, dp), round(lat, dp))


def build_graph(features):
    adjacency: dict[tuple, set] = defaultdict(set)
    edges = 0
    edge_types: dict[int, int] = defaultdict(int)

    for feature in features:
        props = feature.get("properties") or {}
        feature_type = props.get("FeatureType")
        edge_types[feature_type] += 1

        geom = feature.get("geometry") or {}
        gtype = geom.get("type")
        if gtype == "LineString":
            lines = [geom.get("coordinates") or []]
        elif gtype == "MultiLineString":
            lines = geom.get("coordinates") or []
        else:
            continue

        for line in lines:
            for (lon1, lat1), (lon2, lat2) in zip(line, line[1:]):
                a, b = key(lon1, lat1), key(lon2, lat2)
                if a == b:
                    continue
                adjacency[a].add(b)
                adjacency[b].add(a)
                edges += 1

    return adjacency, edges, edge_types


def components(adjacency):
    seen = set()
    sizes = []
    for start in adjacency:
        if start in seen:
            continue
        queue = deque([start])
        seen.add(start)
        size = 0
        while queue:
            node = queue.popleft()
            size += 1
            for nxt in adjacency[node]:
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)
        sizes.append(size)
    sizes.sort(reverse=True)
    return sizes


def main():
    bbox = tuple(float(v) for v in sys.argv[1:5]) if len(sys.argv) >= 5 else DEFAULT_BBOX
    print(f"bbox (min_lat,min_lon,max_lat,max_lon) = {bbox}\n")

    features = fetch(bbox)
    print(f"\nfeatures fetched: {len(features)}")
    if not features:
        print("NOTHING RETURNED - cannot assess")
        return

    adjacency, edges, edge_types = build_graph(features)
    vertices = len(adjacency)

    print(f"edges:    {edges}")
    print(f"vertices: {vertices}")

    if vertices == 0:
        print("no usable geometry")
        return

    sizes = components(adjacency)
    print(f"\nconnected components: {len(sizes)}")
    print(f"largest component:    {sizes[0]} vertices ({sizes[0]/vertices*100:.1f}% of vertices)")
    if len(sizes) > 1:
        print(f"next largest:         {sizes[1:6]}")

    isolated = sum(1 for node, nbrs in adjacency.items() if not nbrs)
    print(f"isolated vertices:    {isolated}")

    print(f"\nlargest component covers {sizes[0]/vertices*100:.0f}% of the network in this bbox")
    if sizes[0] / vertices > 0.5:
        print("VERDICT: routable - the network is substantially connected here")
    else:
        print("VERDICT: FRAGMENTED - most of the network is unlinked; routing would fail")

    print("\nfeatures by FeatureType code:")
    for code, count in sorted(edge_types.items(), key=lambda kv: -kv[1])[:12]:
        print(f"  {code}: {count}")


if __name__ == "__main__":
    main()
