"""Does the TD tactile layer actually line up with the CSDI network?

This is the join that decides whether "prioritise tactile pavement" can work.

CSDI carries the accessibility infrastructure (lifts, ramps, wheelchair access)
but has NO tactile field. TD carries surveyed tactile geometry but is not a
routable graph. So routing needs CSDI edges LABELLED with TD tactile proximity.

If the two datasets describe the same physical paths, a spatial join works and
tactile preference becomes real routing. If they are offset or describe different
things, the join is meaningless and the feature has to be dropped.

Method: take TD tactile vertices, and measure the distance to the nearest CSDI
edge endpoint. Report the distribution. Then do it the other way round.

Run:  python tactile_join_test.py <doc.kml>
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
WFS = f"https://portal.csdi.gov.hk/server/services/common/{DATASET}/MapServer/WFSServer"

CENTRAL = (22.2790, 114.1560, 22.2860, 114.1660)


def metres(lon1, lat1, lon2, lat2):
    dx = (lon2 - lon1) * 111320 * math.cos(math.radians((lat1 + lat2) / 2))
    dy = (lat2 - lat1) * 111320
    return math.hypot(dx, dy)


def load_td_vertices(path: Path, bbox):
    min_lat, min_lon, max_lat, max_lon = bbox
    pts = []
    context = etree.iterparse(str(path), events=("end",), tag=f"{{{KML}}}Placemark")
    for _e, pm in context:
        for child in pm.iter():
            if child.tag.rsplit("}", 1)[-1] == "coordinates" and child.text:
                for chunk in child.text.split():
                    parts = chunk.split(",")
                    if len(parts) >= 2:
                        try:
                            lon, lat = float(parts[0]), float(parts[1])
                        except ValueError:
                            continue
                        if min_lat <= lat <= max_lat and min_lon <= lon <= max_lon:
                            pts.append((lon, lat))
        pm.clear()
        while pm.getprevious() is not None:
            del pm.getparent()[0]
    return pts


def load_csdi_vertices(bbox, page_size=1000, max_pages=12):
    min_lat, min_lon, max_lat, max_lon = bbox
    verts = []
    edges = 0
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
            lines = [g.get("coordinates")] if gt == "LineString" else (g.get("coordinates") or [])
            if gt not in ("LineString", "MultiLineString"):
                continue
            for line in lines:
                for c in line:
                    verts.append((c[0], c[1]))
                edges += max(0, len(line) - 1)
        if len(feats) < page_size:
            break
    return verts, edges


def coverage(source_pts, target_pts, thresholds=(1, 3, 5, 10, 20)):
    """How many source points have a target point within each threshold."""
    counts = {t: 0 for t in thresholds}
    if not target_pts:
        return counts, []
    # Bucket targets into a grid so this is not O(n*m).
    CELL = 0.0005  # ~55 m
    grid = {}
    for lon, lat in target_pts:
        grid.setdefault((int(lon / CELL), int(lat / CELL)), []).append((lon, lat))

    for lon, lat in source_pts:
        cx, cy = int(lon / CELL), int(lat / CELL)
        best = float("inf")
        span = max(1, int(max(thresholds) / 55) + 1)
        for gx in range(cx - span, cx + span + 1):
            for gy in range(cy - span, cy + span + 1):
                for tlon, tlat in grid.get((gx, gy), ()):  # noqa: E501
                    d = metres(lon, lat, tlon, tlat)
                    if d < best:
                        best = d
        for t in thresholds:
            if best <= t:
                counts[t] += 1
    return counts, []


def main():
    td_path = Path(sys.argv[1])
    bbox = CENTRAL

    print("Loading TD tactile vertices...")
    td = load_td_vertices(td_path, bbox)
    print(f"  TD tactile vertices in bbox: {len(td)}")

    print("Loading CSDI network...")
    csdi, edges = load_csdi_vertices(bbox)
    print(f"  CSDI vertices: {len(csdi)}  edges: {edges}")

    if not td or not csdi:
        print("\ninsufficient data in this bbox to test the join")
        return

    print("\n--- TD tactile vertices -> nearest CSDI vertex ---")
    counts, _ = coverage(td, csdi)
    for t, n in counts.items():
        print(f"  within {t:>3} m: {n:>5} / {len(td)}  ({n/len(td)*100:5.1f}%)")

    print("\n--- CSDI vertices -> nearest TD tactile vertex ---")
    # Sample CSDI to keep the runtime sane; it is much denser.
    sample = csdi[:: max(1, len(csdi) // 3000)]
    counts2, _ = coverage(sample, td)
    for t, n in counts2.items():
        print(f"  within {t:>3} m: {n:>5} / {len(sample)}  ({n/len(sample)*100:5.1f}%)")

    print("\nInterpretation:")
    within5 = counts[5] / len(td)
    if within5 > 0.7:
        print("  TD tactile paths sit ON the CSDI network -> the join is meaningful,")
        print("  and tactile preference can be an edge weight.")
    elif within5 > 0.3:
        print("  partial alignment - the join works for a subset; expect gaps.")
    else:
        print("  WEAK alignment - the two datasets describe different geometry.")
        print("  Tactile preference would need interpolation, not a join.")


if __name__ == "__main__":
    main()
