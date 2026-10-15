"""Spatial summary of a TD Traffic Aids KML layer.

The guide-path layer is only ~10k coordinates for the whole territory, so the
question that decides whether it can drive routing is: WHERE is it, and is the
coverage dense enough to follow, or is it a sparse sprinkling?

Prints a bounding box, a coarse grid histogram, and one full sample feature so the
attribute schema is visible.

Run:  python summarise_td_kml.py <doc.kml>
"""

import sys
from collections import Counter, defaultdict
from pathlib import Path

from lxml import etree

KML = "http://www.opengis.net/kml/2.2"


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def main(path: Path) -> None:
    print(f"=== {path.name} ({path.stat().st_size / 1048576:.1f} MB) ===")

    min_lon = min_lat = float("inf")
    max_lon = max_lat = float("-inf")
    total = 0
    lengths_m: list[float] = []
    grid: Counter[tuple[int, int]] = Counter()
    sample_printed = False

    context = etree.iterparse(str(path), events=("end",), tag=f"{{{KML}}}Placemark")
    for _event, placemark in context:
        # One full feature, printed once, so the schema is visible.
        if not sample_printed:
            raw = etree.tostring(placemark, pretty_print=True, encoding="unicode")
            print("--- sample Placemark (truncated) ---")
            print(raw[:1200])
            sample_printed = True

        coords: list[tuple[float, float]] = []
        for child in placemark.iter():
            if local(child.tag) == "coordinates" and child.text:
                for chunk in child.text.split():
                    parts = chunk.split(",")
                    if len(parts) < 2:
                        continue
                    try:
                        lon, lat = float(parts[0]), float(parts[1])
                    except ValueError:
                        continue
                    coords.append((lon, lat))
                    total += 1
                    min_lon, max_lon = min(min_lon, lon), max(max_lon, lon)
                    min_lat, max_lat = min(min_lat, lat), max(max_lat, lat)
                    grid[(int(lon * 100), int(lat * 100))] += 1

        # Cheap path length: sum of segment lengths using an equirectangular
        # approximation, good to well under a metre over city-block distances.
        for (lo1, la1), (lo2, la2) in zip(coords, coords[1:]):
            dx = (lo2 - lo1) * 111320 * 0.9239  # cos(22.5 deg)
            dy = (la2 - la1) * 111320
            lengths_m.append((dx * dx + dy * dy) ** 0.5)

        placemark.clear()
        while placemark.getprevious() is not None:
            del placemark.getparent()[0]

    print("\n--- extent ---")
    print(f"  coordinates: {total}")
    print(f"  lon: {min_lon:.4f} .. {max_lon:.4f}   (span {(max_lon-min_lon)*94.7:.1f} km)")
    print(f"  lat: {min_lat:.4f} .. {max_lat:.4f}   (span {(max_lat-min_lat)*111.3:.1f} km)")

    if lengths_m:
        lengths_m.sort()
        total_m = sum(lengths_m)
        print("\n--- path segments ---")
        print(f"  segments: {len(lengths_m)}")
        print(f"  total length: {total_m/1000:.2f} km")
        print(f"  median segment: {lengths_m[len(lengths_m)//2]:.2f} m")
        print(f"  longest segment: {lengths_m[-1]:.1f} m")

    print(f"\n--- coverage (0.01 deg cells ~ 1.1 km) : {len(grid)} cells occupied ---")
    top = grid.most_common(12)
    for (glon, glat), n in top:
        print(f"  {glon/100:.2f},{glat/100:.2f}  {n} pts")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
