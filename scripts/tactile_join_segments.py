"""Tactile join, take 2 - point-to-SEGMENT, not vertex-to-vertex.

Take 1 measured vertex-to-vertex distance and reported "weak alignment". That was
a bad measurement, not a bad dataset:

  * TD tactile paths run along the CENTRELINE of a footway.
  * CSDI vertices sit at junctions, crossings and shape points.

So two datasets describing the identical physical walkway can have vertices
metres apart. The question that actually matters for routing is:

    "Is this CSDI EDGE close to any TD tactile LINE?"

An edge lying on a tactile path should be preferred, regardless of whether the
endpoints happen to coincide.

This computes point-to-segment distance from each CSDI edge midpoint to the
nearest TD tactile segment.

Run:  python tactile_join_segments.py <doc.kml>
"""

import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from lxml import etree

KML = "http://www.opengis.net/kml/2.2"
DATASET = "landsd_rcd_1637222018065_52265"
WFS = f"https://portal.csdii.gov.hk"  # placeholder, replaced below
WFS = f"https://portal.csdi.gov.hk/server/services/common/{DATASET}/MapServer/WFSServer"

CENTRAL = (22.2790, 114.1560, 22.2860, 114.1660)
METRES_PER_DEG_LAT = 111320


def local_xy(lon, lat, lat0):
    """Project to metres relative to a reference latitude (flat-earth, fine at city scale)."""
    return (lon * METRES_PER_DEG_LAT * math.cos(math.radians(lat0)), lat * METRES_PER_DEG_LAT)


def point_segment_distance(px, py, ax, ay, bx, by):
    """Shortest distance from P to segment AB, in the same units as the inputs."""
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def load_td_segments(path: Path, bbox):
    min_lat, min_lon, max_lat, max_lon = bbox
    segs = []
    context = etree.iterparse(str(path), events=("end",), tag=f"{{{KML}}}Placemark")
    for _e, pm in context:
        for child in pm.iter():
            if child.tag.rsplit("}", 1)[-1] == "coordinates" and child.text:
                pts = []
                for chunk in child.text.split():
                    parts = chunk.split(",")
                    if len(parts) >= 2:
                        try:
                            pts.append((float(parts[0]), float(parts[1])))
                        except ValueError:
                            continue
                for (lo1, la1), (lo2, la2) in zip(pts, pts[1:]):
                    mid = ((lo1 + lo2) / 2, (la1 + la2) / 2)
                    if min_lat <= mid[1] <= max_lat and min_lon <= mid[0] <= max_lon:
                        segs.append(((lo1, la1), (lo2, la2)))
        pm.clear()
        while pm.getprevious() is not None:
            del pm.getparent()[0]
    return segs


def load_csdi_edges(bbox, page_size=1000, max_pages=12):
    min_lat, min_lon, max_lat, max_lon = bbox
    edges = []
    for page in range(max_pages):
        params = {
            "service": "WFS", "version": "2.0.0", "request": "GetFeature",
            "typeNames": "csdi:PedestrianRoute", "outputFormat": "GeoJSON",
            "srsName": "EPSG:4326",
            "bbox": f"{min_lat},{min_lon},{max_lat},{max_lon}",
            "count": str(page_size), "resultType": "results",
            "startIndex": str(page * page_size),
        }
        url = f"{WFS}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            payload = json.load(r)
        feats = payload.get("features", [])
        for f in feats:
            g = f.get("geometry") or {}
            gt = g.get("type")
            if gt == "LineString":
                lines = [g.get("coordinates") or []]
            elif gt == "MultiLineString":
                lines = g.get("coordinates") or []
            else:
                continue
            for line in lines:
                for a, b in zip(line, line[1:]):
                    edges.append(((a[0], a[1]), (b[0], b[1])))
        if len(feats) < page_size:
            break
    return edges


def main():
    td_path = Path(sys.argv[1])
    bbox = CENTRAL

    print("Loading TD tactile segments...")
    td = load_td_segments(td_path, bbox)
    print(f"  TD segments: {len(td)}")

    print("Loading CSDI edges...")
    csdi = load_csdi_edges(bbox)
    print(f"  CSDI edges: {len(csdi)}")

    if not td or not csdi:
        print("\ninsufficient data")
        return

    lat0 = (bbox[0] + bbox[2]) / 2
    td_xy = [(*local_xy(a[0], a[1], lat0), *local_xy(b[0], b[1], lat0)) for a, b in td]

    # Grid index over TD segment bounding boxes.
    CELL = 50.0  # metres
    grid = {}
    for idx, (ax, ay, bx, by) in enumerate(td_xy):
        x0, x1 = sorted((ax, bx))
        y0, y1 = sorted((ay, by))
        for gx in range(int(x0 // CELL), int(x1 // CELL) + 1):
            for gy in range(int(y0 // CELL), int(y1 // CELL) + 1):
                grid.setdefault((gx, gy), []).append(idx)

    thresholds = (1, 2, 3, 5, 10, 20)
    counts = {t: 0 for t in thresholds}
    dists = []

    for a, b in csdi:
        mx = (a[0] + b[0]) / 2
        my = (a[1] + b[1]) / 2
        px, py = local_xy(mx, my, lat0)

        cand = grid.get((int(px // CELL), int(py // CELL)), [])
        best = float("inf")
        # Expand the search if the cell was empty.
        if not cand:
            for gx in range(int(px // CELL) - 1, int(px // CELL) + 2):
                for gy in range(int(py // CELL) - 1, int(py // CELL) + 2):
                    cand = cand + grid.get((gx, gy), [])
        for idx in cand:
            ax, ay, bx, by = td_xy[idx]
            d = point_segment_distance(px, py, ax, ay, bx, by)
            if d < best:
                best = d
        if best < float("inf"):
            dists.append(best)
            for t in thresholds:
                if best <= t:
                    counts[t] += 1

    print(f"\n--- each CSDI edge -> nearest TD tactile LINE ---")
    n = len(dists)
    for t in thresholds:
        print(f"  within {t:>3} m: {counts[t]:>5} / {n}  ({counts[t]/n*100:5.1f}%)")

    if dists:
        dists.sort()
        print(f"\n  median:  {dists[len(dists)//2]:.1f} m")
        print(f"  p25/p75: {dists[len(dists)//4]:.1f} / {dists[3*len(dists)//4]:.1f} m")

    within3 = counts[3] / n
    print("\nInterpretation:")
    if within3 > 0.5:
        print("  STRONG: most CSDI edges hug a TD tactile line -> tactile can be an edge weight.")
    elif within3 > 0.15:
        print("  USABLE: a meaningful minority are tactile -> weight those, do not require them.")
    else:
        print("  SPARSE: tactile covers little of the network, which matches TD being")
        print("  only 56 km territory-wide. Use it as a PREFERENCE term, never a constraint.")


if __name__ == "__main__":
    main()
