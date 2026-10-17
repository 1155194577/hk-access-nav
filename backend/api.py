"""
Composition root for the HK Access Nav backend.

Serve with:

    python api.py                  # 0.0.0.0:8000
    PORT=8080 python api.py
    HOST=127.0.0.1 python api.py
    RELOAD=1 python api.py         # auto-reload while editing

or, equivalently:

    uvicorn api:app --host 0.0.0.0 --port 8000

This module is the HTTP layer and nothing else. Routing decisions live in
`routing.RoutingService`; vision lives in `vlm.py`. Two rules keep that split
honest:

* `api.py` translates payload shapes and status codes. It must not compute
  distances, bearings, or personas — that belongs to the service.
* Everything a client sees is produced by the service (`RouteResult.to_dict`),
  so there is one source of truth for the response body.

`routing.py` currently ships a **stub** service that returns straight-line
estimates. Replace the class, not this file, when the surveyed router lands.

Three traps worth knowing:

1. `.env` is loaded BEFORE importing vlm, because `vlm.py` reads
   `SILICONFLOW_API_KEY` at module import time, not per request. Changing `.env`
   needs a process restart.

2. `vlm.app` is mounted at `/` LAST. Its routes are already rooted at `/api/vlm`,
   so mounting it anywhere else would double the prefix. Parent routes are
   registered first so they win over the catch-all mount.

3. Mounted sub-apps do not run their own lifespan, and `vlm.py` closes its pooled
   httpx client in one — so `vlm.lifespan(vlm.app)` is driven explicitly.

Requires (there is no requirements.txt in this commit):

    fastapi  uvicorn[standard]  pydantic  httpx  python-dotenv  Pillow
"""

from contextlib import asynccontextmanager
import logging
import os

from dotenv import load_dotenv

# Must precede the imports below: vlm.py reads the environment at import time.
load_dotenv()

from fastapi import FastAPI, HTTPException, Query, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel, ConfigDict, Field  # noqa: E402

import vlm  # noqa: E402
from routing import RoutingError, RoutingService  # noqa: E402

log = logging.getLogger("hknav.api")

DEFAULT_PERSONA = os.getenv("HKNAV_DEFAULT_PERSONA", "unfamiliar").strip()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Build the routing service, keep it on app.state, tear it down on exit.

    The service is created here rather than at import time so a real router can
    load its index once, at startup, instead of on first request. `python api.py`
    and `uvicorn api:app` both go through this path.
    """
    service = RoutingService()
    service.startup()
    app.state.router = service

    async with vlm.lifespan(vlm.app):
        log.info("routing (%s) + vision ready", getattr(service, "NAME", "?"))
        yield

    service.shutdown()
    app.state.router = None
    log.info("shut down")


app = FastAPI(
    title="HK Access Nav — API",
    version="1.0",
    description=(
        "* `POST /api/navigate/route` — the mobile app's routing endpoint\n"
        "* `/api/navigate/{personas,health,nearby}` — routing detail\n"
        "* `/api/vlm`, `/api/vlm/health` — SiliconFlow vision proxy\n\n"
        "Routing is currently served by a **stub** that returns straight-line "
        "estimates. Every response says so in `disclaimer` and `router`."
    ),
    lifespan=lifespan,
)

# vlm.py installs CORS for its own routes. The parent needs its own for the
# /api/navigate routes. The native Expo client sends no Origin, so this matters
# for the web build only.
_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def _service(request: Request) -> RoutingService:
    service = getattr(request.app.state, "router", None)
    if service is None:  # lifespan did not run, e.g. a bare app.state reset
        raise HTTPException(503, "routing service is not ready")
    return service


# ---------------------------------------------------------------- request shapes
class _Point(BaseModel):
    """A coordinate in any of the shapes clients actually send.

    The Expo client tries `{lat,lng}` first and `{latitude,longitude}` second, so
    both are accepted here rather than forcing an app-side change.
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


class RouteRequest(BaseModel):
    """Accepts both payload shapes the mobile client attempts."""

    origin: _Point | None = None
    destination: _Point | None = None
    from_: _Point | None = Field(default=None, alias="from")
    to: _Point | None = None

    persona: str | None = None
    language: str | None = None

    model_config = ConfigDict(populate_by_name=True, extra="ignore")


# ---------------------------------------------------------------------- /health
@app.get("/health", tags=["ops"])
def health(request: Request) -> dict:
    """Aggregate liveness — point a container probe here."""
    service = getattr(request.app.state, "router", None)
    return {
        "status": "ok",
        "routing": service.health() if service is not None else {"ready": False},
        "vision": {"mounted": True},
    }


# --------------------------------------------------------------------- navigate
@app.post("/api/navigate/route", tags=["navigate"])
def navigate_route(req: RouteRequest, request: Request) -> dict:
    """Route in the shape the mobile app expects.

    `src/providers/route.js` reads `data.instructions` (a list of strings) and
    `data.distance_meters`. Everything else in the response is extra detail the
    native client uses.
    """
    origin = req.origin or req.from_
    dest = req.destination or req.to
    if origin is None or dest is None:
        raise HTTPException(422, "origin and destination are both required")

    o = origin.coords()
    d = dest.coords()
    if o is None or d is None:
        raise HTTPException(422, "each point needs lat/lng or latitude/longitude")

    language = (req.language or "yue").strip()

    try:
        result = _service(request).route(
            o,
            d,
            persona=req.persona or DEFAULT_PERSONA,
            language=language,
        )
    except RoutingError as exc:
        # The service owns the semantics; this only maps them onto HTTP.
        raise HTTPException(status_code=exc.status, detail={"code": exc.code, "message": str(exc)})

    return result.to_dict(language)


@app.get("/api/navigate/personas", tags=["navigate"])
def navigate_personas(request: Request) -> dict:
    return _service(request).personas()


@app.get("/api/navigate/health", tags=["navigate"])
def navigate_health(request: Request) -> dict:
    return _service(request).health()


@app.get("/api/navigate/nearby", tags=["navigate"])
def navigate_nearby(
    request: Request,
    lat: float = Query(..., ge=22.13, le=22.57, description="WGS84 latitude"),
    lon: float = Query(..., ge=113.83, le=114.51, description="WGS84 longitude"),
    radius: float = Query(25.0, gt=0, le=200, description="search radius, metres"),
    limit: int = Query(10, gt=0, le=50),
) -> dict:
    try:
        return _service(request).nearby(lat, lon, radius_m=radius, limit=limit)
    except RoutingError as exc:
        raise HTTPException(status_code=exc.status, detail={"code": exc.code, "message": str(exc)})


# ----------------------------------------------------------------------- root
@app.get("/", tags=["ops"])
def root() -> dict:
    """Service banner, and the app's cleartext-HTTP canary.

    This exists because of a real misdiagnosis: the app's diagnostics screen does
    a short `GET /` to prove that ATS is not blocking plain HTTP, and its shared
    status helper reports ANY 404 as "the model or path does not exist". Without
    a route here the server answered 404, so the canary failed and the message
    read as though the routing path were wrong — when routing was fine and the
    connection had demonstrably worked (a 404 is still an HTTP response).

    Note this must be registered BEFORE the `/` mount below, or `vlm.app`
    answers first and this never runs.
    """
    return {
        "service": "HK Access Nav API",
        "status": "ok",
        "routing": "/api/navigate/route",
        "vision": "/api/vlm",
        "health": "/health",
        "docs": "/docs",
    }


# --------------------------------------------------------------- sub-app mounts
# Last, and at "/" — vlm.py's routes are already rooted at /api/vlm.
app.mount("/", vlm.app)


# ------------------------------------------------------------------ entrypoint
# `python api.py` starts the server. No uvicorn command line needed.
#
# uvicorn gets the app OBJECT, not the "api:app" import string, so running this
# file as a script does not import api.py a second time under a different module
# name. The reloader is the one exception — it needs an import string — so
# RELOAD=1 switches to that mode.
if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    reload_enabled = os.getenv("RELOAD", "").strip().lower() in {"1", "true", "yes", "on"}

    # Bind 0.0.0.0 so a phone on the network can reach it. On an untrusted
    # network set HOST=127.0.0.1 — this endpoint is unauthenticated and spends
    # your SiliconFlow key.
    # flush=True so the banner is not buried behind uvicorn's stderr logs when
    # stdout is piped (systemd, docker logs, `| tee`).
    print(f"HK Access Nav API  ->  http://{host}:{port}", flush=True)
    print("  navigate : /api/navigate/route  (stub router: straight-line estimates)", flush=True)
    print("  vision   : /api/vlm  (docs at /api/vlm/docs)", flush=True)

    if reload_enabled:
        uvicorn.run("api:app", host=host, port=port, reload=True)
    else:
        uvicorn.run(app, host=host, port=port)
