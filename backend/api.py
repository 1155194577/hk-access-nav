"""
Composition root for the HK Access Nav backend.

Serve with:

    uvicorn api:app --host 0.0.0.0 --port 8000

Currently this serves one service:

    vlm.py   SiliconFlow vision proxy  (defines its own FastAPI `app`)

and optionally a second, if `routing.py` is present beside this file:

    routing.py   tactile-aware pedestrian routing  (own FastAPI `app`)

`vlm.py` builds its own `FastAPI` instance and keeps state on it, so it is mounted
as a sub-app rather than merged. Three consequences drive the code below, and
each one is a trap if you change it:

1. `.env` MUST be loaded *before* importing the service. `vlm.py` reads
   `SILICONFLOW_API_KEY` at module import time (line 67). Change `.env` and you
   must restart the process, not just reload a module.

2. Mounted sub-apps' lifespans DO NOT run. Starlette only runs the root app's
   lifespan, and `vlm.py` holds a pooled httpx client that it closes in its own
   lifespan. So that lifespan is driven explicitly against `vlm.app` here.

3. Route order matters. Any parent routes (`/health`, and the routing adapter)
   are registered before the mounts, and `vlm.app` is mounted at `/` LAST
   because its paths are already rooted at `/api/vlm`.

Requires (there is no requirements.txt in this commit):

    fastapi  uvicorn[standard]  pydantic  httpx  python-dotenv  Pillow

Pillow is needed by vlm.py for EXIF stripping and downscaling. numpy/pandas are
NOT needed unless routing.py is added.
"""

from contextlib import asynccontextmanager
import logging
import os

from dotenv import load_dotenv

# Must precede the imports below: vlm.py reads the environment at import time.
load_dotenv()

from fastapi import APIRouter, FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel, ConfigDict, Field, ValidationError  # noqa: E402

import vlm  # noqa: E402

try:  # optional -- see the module docstring
    import routing  # noqa: E402
except ModuleNotFoundError:  # routing.py not in this deployment
    routing = None

log = logging.getLogger("hknav.api")

DEFAULT_PERSONA = os.getenv("HKNAV_DEFAULT_PERSONA", "unfamiliar").strip()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Drive each sub-app's lifespan against its own app object.

    Mounted apps never get their own lifespan, and `vlm.py` closes its pooled
    httpx provider in its lifespan — so it has to run. routing.py additionally
    stores `idx` / `router` on `routing.app.state` and its endpoints read that
    exact object, so passing the parent app here would leave every route 500.
    """
    if routing is None:
        async with vlm.lifespan(vlm.app):
            log.info("vision ready (routing: absent)")
            yield
    else:
        async with routing.lifespan(routing.app):
            async with vlm.lifespan(vlm.app):
                log.info("routing + vision ready")
                yield
    log.info("shut down")


app = FastAPI(
    title="HK Access Nav — API",
    version="1.0",
    description=(
        "Vision-only deployment.\n\n"
        "* `/api/vlm`, `/api/vlm/health` — SiliconFlow vision proxy\n\n"
        "Mount `routing.py` beside this file to also get `/api/navigate/*`, "
        "including a mobile-compatible `POST /api/navigate/route`."
    ),
    lifespan=lifespan,
)

# vlm.py installs CORS for its own routes. The parent needs its own only for
# routes registered here, and for the routing mount if it is present. The native
# Expo client sends no Origin, so this is a web-build concern.
_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------- /health
@app.get("/health", tags=["ops"])
def health() -> dict:
    """Aggregate liveness — the endpoint to point a container probe at.

    `/api/vlm/health` still gives the per-service detail (provider, models,
    whether a key is configured).
    """
    status: dict = {"status": "ok", "vision": {"mounted": True}}
    if routing is None:
        status["routing"] = {"present": False}
    else:
        idx = getattr(routing.app.state, "idx", None)
        router = getattr(routing.app.state, "router", None)
        status["routing"] = {
            "present": True,
            "ready": idx is not None,
            "edges": len(idx.e) if idx is not None else 0,
            "router": type(router).__name__ if router is not None else None,
        }
    return status


# --------------------------------------------------- mobile-compatible adapter
# Only meaningful with routing.py; registered before the mount so it wins over
# routing's native handler for this exact path.
if routing is not None:

    class _Point(BaseModel):
        """A coordinate in any of the shapes clients actually send.

        The Expo client tries `{lat,lng}` first and `{latitude,longitude}`
        second, so both are accepted rather than forcing an app-side change.
        """

        lat: float | None = None
        lng: float | None = None
        latitude: float | None = None
        longitude: float | None = None

        model_config = ConfigDict(extra="ignore")

        def coords(self) -> tuple[float, float] | None:
            la = self.lat if self.lat is not None else self.latitude
            lo = self.lng if self.lng is not None else self.longitude
            if la is None or lo is None:
                return None
            return float(la), float(lo)

    class MobileRouteRequest(BaseModel):
        origin: _Point | None = None
        destination: _Point | None = None
        from_: _Point | None = Field(default=None, alias="from")
        to: _Point | None = None
        persona: str | None = None
        language: str | None = None

        model_config = ConfigDict(populate_by_name=True, extra="ignore")

    navigate = APIRouter(tags=["navigate"])

    @navigate.post("/api/navigate/route")
    def mobile_route(req: MobileRouteRequest) -> dict:
        """Route in the shape the mobile app expects.

        `src/providers/route.js` reads `data.instructions` (a list of strings)
        and `data.distance_meters`. The native guidance document uses
        `events[].say` and `distance_m` instead, so this translates rather than
        duplicating logic — every native field is still returned alongside.
        """
        origin = req.origin or req.from_
        dest = req.destination or req.to
        if origin is None or dest is None:
            raise HTTPException(422, "origin and destination are both required")
        o = origin.coords()
        d = dest.coords()
        if o is None or d is None:
            raise HTTPException(422, "each point needs lat/lng or latitude/longitude")

        (from_lat, from_lon) = o
        (to_lat, to_lon) = d

        try:
            native_req = routing.RouteRequest(
                from_lat=from_lat,
                from_lon=from_lon,
                to_lat=to_lat,
                to_lon=to_lon,
                persona=req.persona or DEFAULT_PERSONA,
            )
        except ValidationError as exc:
            # RouteRequest bounds-checks against Hong Kong; surface as 422 rather
            # than letting pydantic's error become a 500.
            detail = exc.errors()[0]
            raise HTTPException(422, f"point outside the covered area: {detail['msg']}")

        plan = routing.route(native_req)  # HTTPException for no-route / bad persona
        events = plan.get("events") or []
        instructions = [e["say"] for e in events if e.get("say")]

        return {
            # --- what the mobile app consumes ---
            "instructions": instructions,
            "distance_meters": plan.get("distance_m"),
            # --- native guidance document, unchanged ---
            "distance_m": plan.get("distance_m"),
            "duration_s": plan.get("duration_s"),
            "route_id": plan.get("route_id"),
            "persona": plan.get("persona"),
            "router": plan.get("router"),
            "accessibility_optimised": plan.get("accessibility_optimised"),
            "revision": plan.get("revision"),
            "polyline": plan.get("polyline"),
            "events": events,
            "accessibility": plan.get("accessibility"),
            "source": "hk-nav-server",
        }

    app.include_router(navigate)


# --------------------------------------------------------------- sub-app mounts
# Order matters: routing (if present) first, the catch-all vision mount last.
if routing is not None:
    app.mount("/api/navigate", routing.app)
app.mount("/", vlm.app)
