#!/usr/bin/env python3
"""
make_tactile_map.py — one self-contained Leaflet map of Hong Kong's tactile paving.

Draws the two TD tactile layers that actually constitute tactile paving:

    DTAD_TG_PATH_LINE   guide path   — directional bar tiles forming a route
    DTAD_TW_STRIP_LINE  warning strip — the dot/tile band at crossings and edges
    DTAD_DROP_KERB_LINE dropped kerbs — not tactile paving, but the same family
                                        and useful context, so it is a toggle

Geometry is re-chained per feature (the pipeline splits features into 2-point
segments; 210,473 segments would be 210,473 Leaflet objects) and delta-encoded as
integers in units of 1e-6 degrees, which shrinks the payload several-fold:

    [lon0, lat0, dlon1, dlat1, dlon2, dlat2, ...]

Run from the data-pipeline tree (it imports the pipeline's conflate module):

    cd <pipeline>
    python3 <repo>/backend/make_tactile_map.py --out <repo>/docs/tactile-map.html
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import numpy as np

M_PER_DEG_LAT = 111320.0
SCALE = 1_000_000          # 1e-6 deg ≈ 0.11 m

#: layer key -> (TD layer, label, colour, default-on)
LAYERS = [
    ("guide", "DTAD_TG_PATH_LINE", "Tactile guide path", "#1565c0", True),
    ("warn", "DTAD_TW_STRIP_LINE", "Tactile warning strip", "#ef6c00", True),
    ("kerb", "DTAD_DROP_KERB_LINE", "Dropped kerb", "#2e7d32", False),
]


def chains(segs: np.ndarray, fids) -> list[list[tuple[int, int]]]:
    """Re-chain per-feature segments into polylines of integer coordinates."""
    by: dict[str, list[np.ndarray]] = {}
    for seg, fid in zip(segs, fids):
        by.setdefault(str(fid), []).append(seg)

    out: list[list[tuple[int, int]]] = []
    for fid, parts in by.items():
        parts.sort(key=lambda s: (s[0], s[1]))
        pts: list[tuple[int, int]] = []
        for s in parts:
            a = (int(round(s[0] * SCALE)), int(round(s[1] * SCALE)))
            b = (int(round(s[2] * SCALE)), int(round(s[3] * SCALE)))
            if not pts:
                pts.extend([a, b])
            elif pts[-1] == a:
                pts.append(b)
            elif pts[-1] == b:
                pts.append(a)
            elif pts[0] == b:
                pts.insert(0, a)
            elif pts[0] == a:
                pts.insert(0, b)
            else:
                out.append(pts)
                pts = [a, b]
        if len(pts) >= 2:
            out.append(pts)
    return out


def encode(polys: list[list[tuple[int, int]]]) -> tuple[list[list[int]], int]:
    flat: list[list[int]] = []
    npts = 0
    for p in polys:
        x0, y0 = p[0]
        row = [x0, y0]
        px, py = x0, y0
        for x, y in p[1:]:
            row.append(x - px)
            row.append(y - py)
            px, py = x, y
        flat.append(row)
        npts += len(p)
    return flat, npts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="docs/tactile-map.html", type=Path)
    a = ap.parse_args()

    sys.path.insert(0, str(Path("tools").resolve()))
    import conflate as C  # noqa: E402

    payload: dict[str, dict] = {}
    print("building layers ...", flush=True)
    for key, layer, label, colour, on in LAYERS:
        segs, fids = C.to_segments(C.wfs_layer(layer))
        L = np.hypot(
            (segs[:, 2] - segs[:, 0]) * np.cos(np.radians((segs[:, 1] + segs[:, 3]) / 2)) * M_PER_DEG_LAT,
            (segs[:, 3] - segs[:, 1]) * M_PER_DEG_LAT,
        )
        polys = chains(segs, fids)
        flat, npts = encode(polys)
        payload[key] = {
            "label": label, "colour": colour, "on": on,
            "lines": flat, "features": len(polys), "points": npts,
            "km": round(float(L.sum()) / 1000, 2),
        }
        print(f"  {label:24} {len(polys):>7,} lines  {npts:>8,} pts  {L.sum()/1000:>8.2f} km",
              flush=True)

    data = json.dumps(payload, separators=(",", ":"))
    print(f"  payload: {len(data)/1024/1024:.2f} MB", flush=True)

    html = TEMPLATE.replace("__DATA__", data)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(html, encoding="utf-8")
    print(f"wrote {a.out} ({a.out.stat().st_size/1024/1024:.2f} MB)", flush=True)
    return 0


TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Hong Kong tactile paving</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body, #map { margin: 0; height: 100%; width: 100%; }
  body { font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; }
  .panel {
    background: rgba(255,255,255,.96); border-radius: 8px; padding: 10px 12px;
    box-shadow: 0 1px 6px rgba(0,0,0,.3); max-width: 260px;
  }
  .panel h1 { font-size: 14px; margin: 0 0 6px; }
  .panel p { margin: 0 0 6px; color: #444; }
  .swatch { display:inline-block; width: 22px; height: 4px; border-radius: 2px;
            margin-right: 6px; vertical-align: middle; }
  .row { margin: 3px 0; }
  .num { color: #666; font-variant-numeric: tabular-nums; }
  #legend { position: absolute; top: 10px; right: 10px; z-index: 1000; }
  .leaflet-control-attribution { font-size: 10px; }
</style>
</head>
<body>
<div id="map"></div>
<div id="legend" class="panel">
  <h1>Hong Kong tactile paving</h1>
  <div id="rows"></div>
  <p style="margin-top:8px" class="num" id="totals"></p>
  <p id="status" class="num" style="margin:2px 0 6px">loading…</p>
  <p style="font-size:11px;color:#777;margin:0">
    Transport Department survey, via CSDI.<br />
    Map tiles &copy; OpenStreetMap contributors.
  </p>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  // If the CDN is unreachable the map stays blank and looks like broken data.
  if (typeof L === 'undefined') {
    document.getElementById('map').innerHTML =
      '<div style="padding:24px;font:15px system-ui">' +
      '<b>Leaflet failed to load.</b><br>This page needs internet access for the ' +
      'Leaflet library from unpkg.com and for the OSM map tiles.</div>';
  }
</script>
<script>
const DATA = __DATA__;
const SCALE = 1e6;

const map = L.map('map', { preferCanvas: true, zoomControl: true })
             .setView([22.36, 114.14], 11);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

// One shared canvas for every layer. Creating L.canvas() per polyline makes a new
// canvas element each time — with ~100k polylines that is ~100k canvases and
// nothing ever paints. This single renderer is the whole point.
const canvasRenderer = L.canvas({ padding: 0.5 });

const rows = document.getElementById('rows');
const status = document.getElementById('status');
const groups = {};

function fail(msg) {
  status.textContent = msg;
  status.style.color = '#b00020';
  status.style.fontWeight = '600';
}
window.addEventListener('error', e => fail('Error: ' + e.message));

try {
  for (const [key, d] of Object.entries(DATA)) {
    // decode delta-encoded integer polylines back into [lat, lng] pairs
    const lines = [];
    for (const row of d.lines) {
      const pts = [];
      let x = row[0], y = row[1];
      pts.push([y / SCALE, x / SCALE]);
      for (let i = 2; i < row.length; i += 2) {
        x += row[i]; y += row[i + 1];
        pts.push([y / SCALE, x / SCALE]);
      }
      lines.push(pts);
    }
    d._lines = lines.length;

    // A multi-part polyline: ONE Leaflet object per layer, not one per line.
    const layer = L.polyline(lines, {
      color: d.colour,
      weight: key === 'kerb' ? 2 : (key === 'warn' ? 2 : 3),
      opacity: 0.9,
      interactive: false,
      smoothFactor: 1.2,
      renderer: canvasRenderer
    });
    groups[key] = layer;

    const sw = document.createElement('div');
    sw.className = 'row';
    sw.innerHTML = `<span class="swatch" style="background:${d.colour}"></span>` +
                   `<b>${d.label}</b><br><span class="num">` +
                   `${d.features.toLocaleString()} lines · ${d.km.toFixed(1)} km</span>`;
    rows.appendChild(sw);
  }

  const overlays = {};
  for (const [key, d] of Object.entries(DATA)) overlays[d.label] = groups[key];
  for (const [key, d] of Object.entries(DATA)) if (d.on) groups[key].addTo(map);
  L.control.layers(null, overlays, { collapsed: false }).addTo(map);

  const totalKm = Object.values(DATA).reduce((s, d) => s + d.km, 0);
  const totalPts = Object.values(DATA).reduce((s, d) => s + d.points, 0);
  document.getElementById('totals').textContent =
    `${totalKm.toFixed(1)} km surveyed · ${totalPts.toLocaleString()} points`;
  status.textContent = 'Drawn: ' +
    Object.values(DATA).filter(d => d.on).map(d => d.label).join(', ');
  status.style.color = '#2e7d32';
} catch (err) {
  fail('Could not draw: ' + (err && err.message ? err.message : err));
}

// Draw the canvas layers once the tiles have settled, so first paint is not blocked.
map.whenReady(() => setTimeout(() => map.invalidateSize(), 50));
</script>
</body>
</html>
"""


if __name__ == "__main__":
    raise SystemExit(main())
