"""Inspect the Transport Department tactile KML layers.

Answers three questions that decide how this data can be used:
  1. Are the coordinates really WGS84 (so no HK1980 Grid reprojection is needed)?
  2. How many features, and of what geometry type?
  3. What attributes travel with each feature?

Run:  python inspect_td_kml.py <doc.kml> [<doc.kml> ...]
"""

import sys
from collections import Counter
from pathlib import Path

from lxml import etree

KML = "http://www.opengis.net/kml/2.2"


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def inspect(path: Path) -> None:
    print(f"\n=== {path.name}  ({path.stat().st_size / 1048576:.1f} MB) ===")

    counts: Counter[str] = Counter()
    placemarks = 0
    coord_samples: list[tuple[float, float]] = []
    total_coords = 0
    attribute_names: Counter[str] = Counter()
    name_samples: list[str] = []

    context = etree.iterparse(str(path), events=("end",), tag=f"{{{KML}}}Placemark")
    for _event, element in context:
        placemarks += 1

        for child in element.iter():
            tag = local(child.tag)
            counts[tag] += 1

            if tag == "coordinates" and child.text:
                for chunk in child.text.split():
                    parts = chunk.split(",")
                    if len(parts) >= 2:
                        try:
                            lon, lat = float(parts[0]), float(parts[1])
                        except ValueError:
                            continue
                        total_coords += 1
                        if len(coord_samples) < 5:
                            coord_samples.append((lon, lat))

            if tag == "Data":
                key = child.get("name")
                if key:
                    attribute_names[key] += 1

            if tag == "name" and child.text and len(name_samples) < 5:
                name_samples.append(child.text.strip()[:60])

        # Free memory as we go: the stripe layer is ~90 MB.
        element.clear()
        while element.getprevious() is not None:
            del element.getparent()[0]

    print(f"  Placemarks:      {placemarks}")
    print(f"  total coords:    {total_coords}")
    print(f"  geometry tags:   ", {k: v for k, v in counts.items() if k in
          ("Point", "LineString", "Polygon", "LinearRing", "MultiGeometry", "outerBoundaryIs")})
    print(f"  sample coords:   {coord_samples}")

    if coord_samples:
        lons = [c[0] for c in coord_samples]
        lats = [c[1] for c in coord_samples]
        print(f"  lon range:       {min(lons):.4f} .. {max(lons):.4f}")
        print(f"  lat range:       {min(lats):.4f} .. {max(lats):.4f}")
        looks_wgs84 = 113 < min(lons) < 115 and 22 < min(lats) < 23
        print(f"  looks like WGS84 Hong Kong: {looks_wgs84}")

    print(f"  attributes:      {dict(attribute_names.most_common(12))}")
    print(f"  name samples:    {name_samples}")


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        inspect(Path(arg))
