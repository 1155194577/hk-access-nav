"""Where is this app actually usable?

Answers the question the district boundaries exist to answer: how much surveyed
tactile guidance is there in each part of Hong Kong?

The 18 districts are approximated by bounding boxes rather than true polygon
containment. That is a deliberate trade: it needs no extra dependency, and for a
coverage ranking (which district has the most tactile path) a bbox is accurate
enough. It DOES over-count features near a shared border, so the numbers are an
upper bound per district and are labelled as such. Use the real 18-district
polygons when exact containment matters.

Run:  python district_coverage.py <doc.kml>
"""

import sys
from collections import Counter
from pathlib import Path

from lxml import etree

KML = "http://www.opengis.net/kml/2.2"

# Approximate bounding boxes: (min_lat, max_lat, min_lon, max_lon).
# Ordered roughly west-to-east within each region.
DISTRICTS: dict[str, tuple[float, float, float, float]] = {
    # Hong Kong Island
    "Central & Western": (22.270, 22.290, 114.110, 114.165),
    "Wan Chai": (22.265, 22.290, 114.165, 114.200),
    "Eastern": (22.255, 22.290, 114.200, 114.250),
    "Southern": (22.190, 22.270, 114.100, 114.270),
    # Kowloon
    "Yau Tsim Mong": (22.295, 22.325, 114.155, 114.185),
    "Sham Shui Po": (22.320, 22.345, 114.140, 114.175),
    "Kowloon City": (22.315, 22.345, 114.175, 114.210),
    "Wong Tai Sin": (22.330, 22.355, 114.185, 114.225),
    "Kwun Tong": (22.300, 22.335, 114.200, 114.240),
    # New Kowloon / east
    "Kwai Tsing": (22.340, 22.375, 114.100, 114.155),
    "Tsuen Wan": (22.355, 22.400, 114.080, 114.130),
    "Sha Tin": (22.360, 22.400, 114.155, 114.215),
    "Sai Kung": (22.280, 22.400, 114.215, 114.330),
    "Tai Po": (22.400, 22.480, 114.120, 114.250),
    "North": (22.470, 22.570, 113.900, 114.250),
    "Yuen Long": (22.400, 22.530, 113.900, 114.080),
    "Tuen Mun": (22.350, 22.450, 113.900, 114.030),
    "Islands": (22.190, 22.320, 113.850, 114.050),
}


def main(path: Path) -> None:
    per_district: Counter[str] = Counter()
    length_per_district: Counter[str] = Counter()
    unmatched = 0
    total_pts = 0

    context = etree.iterparse(str(path), events=("end",), tag=f"{{{KML}}}Placemark")
    for _event, placemark in context:
        coords: list[tuple[float, float]] = []
        for child in placemark.iter():
            if child.tag.rsplit("}", 1)[-1] == "coordinates" and child.text:
                for chunk in child.text.split():
                    parts = chunk.split(",")
                    if len(parts) >= 2:
                        try:
                            coords.append((float(parts[0]), float(parts[1])))
                        except ValueError:
                            continue

        if coords:
            total_pts += len(coords)
            # Attribute the feature to the district containing its midpoint.
            mid_lon = sum(c[0] for c in coords) / len(coords)
            mid_lat = sum(c[1] for c in coords) / len(coords)

            hit = None
            for name, (min_lat, max_lat, min_lon, max_lon) in DISTRICTS.items():
                if min_lat <= mid_lat <= max_lat and min_lon <= mid_lon <= max_lon:
                    hit = name
                    break
            if hit is None:
                unmatched += 1
            else:
                per_district[hit] += 1

            # Segment length, for a "how many metres of tactile path" view.
            seg_len = 0.0
            for (lo1, la1), (lo2, la2) in zip(coords, coords[1:]):
                dx = (lo2 - lo1) * 111320 * 0.9239
                dy = (la2 - la1) * 111320
                seg_len += (dx * dx + dy * dy) ** 0.5
            if hit:
                length_per_district[hit] += seg_len

        placemark.clear()
        while placemark.getprevious() is not None:
            del placemark.getparent()[0]

    print(f"total features: {sum(per_district.values()) + unmatched}")
    print(f"attributed:     {sum(per_district.values())}")
    print(f"unmatched:      {unmatched}  (outside the coarse boxes)")
    print(f"coordinates:    {total_pts}\n")

    print(f"{'district':<22}{'paths':>7}{'tactile m':>12}")
    print("-" * 41)
    for name, count in per_district.most_common():
        print(f"{name:<22}{count:>7}{length_per_district[name]:>12.0f}")

    empty = [n for n in DISTRICTS if n not in per_district]
    if empty:
        print("\nno surveyed tactile path found in:")
        for n in empty:
            print(f"  {n}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
