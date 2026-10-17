"""
Routing service (STUB).

This module defines the routing contract and a dummy implementation of it. It
exists so `/api/navigate/*` is real, exercised, and shape-stable while the
surveyed router is still being built. `api.py` instantiates `RoutingService` and
owns the HTTP layer; all routing decisions live here.

WHAT THIS DOES NOT DO
---------------------
It does not route along footpaths. It returns a straight line — the same
fallback the mobile app uses when its on-device graph has no coverage. That is a
deliberate, safety-driven choice rather than laziness:

    A straight-line estimate that announces itself is useful.
    A fabricated footpath route that looks authoritative is dangerous,
    because the person relying on it cannot verify it.

So every response carries `disclaimer` and `router: "dummy"`, and the first
instruction says out loud that it is a direct line. Do not remove those when
wiring up a UI.

REPLACING THIS
--------------
Implement the same five methods on a class and swap the instantiation in
`api.py`. Nothing in the HTTP layer needs to change:

    route(origin, destination, persona, language) -> RouteResult
    nearby(latitude, longitude, radius_m, limit)  -> dict
    personas()                                    -> dict
    health()                                      -> dict
    NAME                                           str

The real implementation will also want a `startup()`/`shutdown()` pair (loading
a multi-megabyte index takes ~0.6 s) driven from `api.py`'s lifespan.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
import math
from typing import Any

# --------------------------------------------------------------------- constants

EARTH_RADIUS_M = 6371008.8

#: Calm walking pace, matching the mobile app's on-device router.
WALKING_SPEED_MPS = 1.2

#: Hong Kong bounding box — anything outside is a client bug, not a route.
HK_LAT = (22.13, 22.57)
HK_LON = (113.83, 114.51)

#: Personas kept identical to the surveyed router so clients need no change.
#: `exclude` names what a persona refuses; the stub honours it only by saying so
#: in the response, since a straight line has no edges to exclude.
PERSONAS: dict[str, dict[str, Any]] = {
    "unfamiliar": {"exclude": None, "risk": 0.5, "description": "Highest reliance on the guide path"},
    "familiar": {"exclude": None, "risk": 0.1, "description": "Knows the route; minimises effort"},
    "low_vision": {"exclude": None, "risk": 0.3, "description": "Uses residual vision"},
    "deafblind": {"exclude": None, "risk": 0.7, "description": "Cannot use audible signals"},
    "step_averse": {"exclude": "steps", "risk": 0.3, "description": "No staircases"},
    "verified_only": {"exclude": None, "risk": 0.2, "description": "Only inspected segments"},
}

DISCLAIMER = {
    "yue": "呢個係直線方向，唔會跟行人路。",
    "en": "This is a direct line and does not follow footpaths.",
}

_INTRO = {
    "yue": "未能提供行人路路線，以下只係直線方向，唔會跟行人路。",
    "en": "No footpath route available. This is a direct line and does not follow footpaths.",
}

_BEARING = {
    "yue": "向{bearing}度方向行{distance}。",
    "en": "Head {bearing} degrees for {distance}.",
}


class RoutingError(Exception):
    """A routing request that cannot be answered. `code` is stable for clients."""

    def __init__(self, message: str, code: str = "routing_error", status: int = 422):
        super().__init__(message)
        self.code = code
        self.status = status


# ---------------------------------------------------------------------- geometry

def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial bearing, clockwise from north, in degrees [0, 360)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _inside_hong_kong(latitude: float, longitude: float) -> bool:
    return (
        HK_LAT[0] <= latitude <= HK_LAT[1]
        and HK_LON[0] <= longitude <= HK_LON[1]
    )


def _format_distance(metres: float, language: str) -> str:
    if metres < 1000:
        text = f"{int(round(metres))} 米" if language == "yue" else f"{int(round(metres))} metres"
    else:
        text = f"{metres / 1000:.1f} 公里" if language == "yue" else f"{metres / 1000:.1f} km"
    return text


# ------------------------------------------------------------------------ result

@dataclass
class RouteResult:
    """A routing answer, in both the mobile and the native shape.

    `api.py` serves this verbatim apart from adding `instructions`, which is
    derived from `steps` so there is exactly one source of truth.
    """

    origin: tuple[float, float]
    destination: tuple[float, float]
    steps: list[dict[str, Any]]
    distance_m: float
    duration_s: float
    speaker: str = "dummy"
    persona: str = "unfamiliar"
    accessibility_optimised: bool = False
    notes: list[str] = field(default_factory=list)

    @property
    def instructions(self) -> list[str]:
        """The flat list `src/providers/route.js` reads."""
        return [s["say"] for s in self.steps if s.get("say")]

    def to_dict(self, language: str = "yue") -> dict[str, Any]:
        payload = asdict(self)
        payload["route_id"] = f"dummy-{int(self.distance_m)}"
        payload["router"] = self.speaker
        payload["instructions"] = self.instructions
        payload["distance_meters"] = self.distance_m
        payload["disclaimer"] = DISCLAIMER.get(language, DISCLAIMER["en"])
        payload["accessibility"] = {
            "decision_points_total": 0,
            "accessibility_assured_ratio": 0.0,
            "surveyed": False,
            "note": "stub router: no surveyed network behind this response",
        }
        return payload


# ----------------------------------------------------------------------- service

class RoutingService:
    """Dummy implementation of the routing contract.

    Deliberately dependency-free (no numpy, no pandas, no index) so the API runs
    on a small VM. The real router will need a prebuilt index and ~400 MB; this
    needs nothing.
    """

    NAME = "dummy"

    # ---------------------------------------------------------------- lifecycle
    def startup(self) -> None:
        """Called from api.py's lifespan. A real router loads its index here."""

    def shutdown(self) -> None:
        """Called from api.py's lifespan."""

    # ------------------------------------------------------------------- routes
    def route(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
        persona: str = "unfamiliar",
        language: str = "yue",
    ) -> RouteResult:
        """Straight-line estimate from `origin` to `destination`.

        Raises RoutingError for bad input so the HTTP layer can map it to a
        status without inspecting messages.
        """
        if persona not in PERSONAS:
            raise RoutingError(
                f"unknown persona; valid: {sorted(PERSONAS)}", code="bad_persona"
            )

        (from_lat, from_lon) = origin
        (to_lat, to_lon) = destination

        for label, (la, lo) in (("origin", origin), ("destination", destination)):
            if not _inside_hong_kong(la, lo):
                raise RoutingError(
                    f"{label} {la:.4f},{lo:.4f} is outside Hong Kong",
                    code="outside_coverage",
                )

        metres = haversine_m(from_lat, from_lon, to_lat, to_lon)
        if metres < 1.0:
            raise RoutingError(
                "origin and destination are the same point", code="same_point"
            )

        bearing = bearing_deg(from_lat, from_lon, to_lat, to_lon)
        lang = language if language in DISCLAIMER else "en"
        spec = PERSONAS[persona]

        steps = [
            {"at_m": 0.0, "type": "warning", "say": _INTRO[lang]},
            {
                "at_m": 0.0,
                "type": "depart",
                "say": _BEARING[lang].format(
                    bearing=int(round(bearing)),
                    distance=_format_distance(metres, lang),
                ),
            },
            {
                "at_m": metres,
                "type": "arrive",
                "say": "已經到達。" if lang == "yue" else "You have arrived.",
            },
        ]

        notes = ["straight-line estimate; not a surveyed footpath route"]
        if spec["exclude"]:
            notes.append(
                f"persona '{persona}' asked to exclude {spec['exclude']!r}, "
                "but a straight line has no segments to exclude"
            )

        return RouteResult(
            origin=(from_lat, from_lon),
            destination=(to_lat, to_lon),
            steps=steps,
            distance_m=round(metres, 1),
            duration_s=round(metres / WALKING_SPEED_MPS, 1),
            speaker=self.NAME,
            persona=persona,
            accessibility_optimised=False,
            notes=notes,
        )

    # ------------------------------------------------------------------- nearby
    def nearby(
        self,
        latitude: float,
        longitude: float,
        radius_m: float = 25.0,
        limit: int = 10,
    ) -> dict[str, Any]:
        """Accessibility features near a point.

        The stub has no feature table, so it returns an empty candidate list with
        an explicit reason. Returning invented candidates would be worse than
        returning none: callers rank them and would believe the ranking.
        """
        if not _inside_hong_kong(latitude, longitude):
            raise RoutingError(
                f"{latitude:.4f},{longitude:.4f} is outside Hong Kong",
                code="outside_coverage",
            )
        return {
            "query": {"lat": latitude, "lon": longitude, "radius_m": radius_m},
            "position_quality": {
                "quality": "unknown",
                "nearest_edge_offset_m": None,
                "edges_within_10m": 0,
                "snap_is_ambiguous": None,
                "caveat": "stub router: no surveyed edge table is loaded",
            },
            "edges": [],
            "router": self.NAME,
            "limit": limit,
        }

    # ----------------------------------------------------------------- metadata
    def personas(self) -> dict[str, Any]:
        return {"personas": PERSONAS, "router": self.NAME}

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "router": self.NAME,
            "stub": True,
            "surveyed": False,
            "accessibility_optimised": False,
            "note": "straight-line estimates only; replace with the surveyed router",
        }
