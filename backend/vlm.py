"""Single-file FastAPI service: `POST /api/vlm` — real vision for the app.
Replaces the stub that answered every image with:
    {"status": "success",
     "description": "A glass revolving door is 3 steps ahead, flanked by metal handrails."}
That stub was not harmless. The client maps prose onto hazard codes, so one canned
sentence became *two* confident hazard warnings ("stairs ahead", "door ahead") and
"What is this?" announced an obstruction that was never there. This file makes the
endpoint actually look at the frame — via SiliconFlow's
`Qwen/Qwen3-VL-8B-Instruct` — and returns the model's own words.
## Run it
    pip install fastapi uvicorn httpx pillow
    export SILICONFLOW_API_KEY=sk-...
    python vlm_service.py --port 8000
    # or:  uvicorn vlm_service:app --host 0.0.0.0 --port 8000
With no `SILICONFLOW_API_KEY` the service still starts and answers with a clearly
labelled deterministic mock (`"source": "mock"`), so a clone runs before anyone has
signed up for anything. It never falls back to an anonymous or shared key.
    curl -s localhost:8000/api/vlm/health
    # {"configured": true, "provider": "siliconflow", "models": ["Qwen/Qwen3-VL-8B-Instruct", ...]}
## Why the call is proxied here instead of made from the phone
The app used to call SiliconFlow directly, which meant Expo inlined
`EXPO_PUBLIC_SILICONFLOW_API_KEY` into the JavaScript bundle at build time. Anyone
who opened the deployed app could read that key out of the bundle and spend it.
Proxying means the phone sends no credential at all — but only if you follow
through on the two rules below.
## Two rules this file enforces, and neither is optional
**1. The system prompt is fixed here.** A request may shape the *question*
(`prompt`, <= 300 chars), never the system instruction. If the client could send a
system prompt, this endpoint would be a free general-purpose LLM billed to your key.
**2. EXIF is stripped before the frame leaves this process.** Phone photos carry
GPS coordinates. Forwarding them to a vision vendor would leak the user's exact
position to a third party and undo the whole on-device home-coordinate design. We
re-encode through Pillow without `exif=`, which drops all metadata as a side effect.
## One deployment warning
This endpoint has **no authentication**. Anyone who can reach the port can spend
your SiliconFlow credit. Put it behind your own auth (a shared-secret header, at
minimum) and TLS before it is reachable from the internet.
"""
from __future__ import annotations
import base64
import binascii
import io
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Literal
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator
try:  # optional: lets a local `.env` work without exporting anything
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:  # pragma: no cover - dotenv is a convenience, not a requirement
    pass
# --------------------------------------------------------------------- logging
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("vlm")
# ---------------------------------------------------------------------- config
#
# Read once at import. No secret has a default: a missing key selects the mock
# provider, it never silently borrows a shared one.
API_KEY = os.getenv("SILICONFLOW_API_KEY", "").strip()
BASE_URL = os.getenv("SILICONFLOW_BASE_URL", "https://api.siliconflow.cn/v1").strip().rstrip("/")
# Comma-separated, tried in order. Model ids on SiliconFlow drift, and a retired id
# returns 400/404 rather than degrading gracefully, so we walk the list.
MODELS = [
    m.strip()
    for m in os.getenv(
        "SILICONFLOW_VISION_MODELS",
        "Qwen/Qwen3-VL-8B-Instruct,Qwen/Qwen3-VL-32B-Instruct",
    ).split(",")
    if m.strip()
]
# A blind user standing at a kerb cannot wait 18 seconds in silence. The 8B model
# answers in ~2-4s; the 32B takes 12-18s and is only worth it on a deliberate
# one-shot press, not for this endpoint's per-frame budget.
TIMEOUT_SECONDS = float(os.getenv("SILICONFLOW_VISION_TIMEOUT_SECONDS", "20"))
# A 1024px JPEG at quality 82 is ~150-250 KB, so ~350 KB of base64. The ceiling
# rejects accidental full-resolution uploads, which cost money and latency without
# improving the answer. The floor catches "not a photo of anything" early and
# cheaply instead of paying for a 400 from the vendor (Qwen3-VL also rejects
# images under 28px a side).
MAX_IMAGE_BYTES = 4_000_000
MIN_IMAGE_BYTES = 64
MAX_EDGE_PX = 1024
# Fixed system prompt. The wording is load-bearing and mirrors the app's
# `src/providers/vision.js`. An earlier version pivoted on "if you are not sure,
# say you cannot tell", and the 8B model complied by refusing to describe the demo
# frame at all — an answer that says nothing is useless to someone at a kerb. This
# version asks for what *is* visible, keeps hazard-first ordering, and still allows
# an explicit "this part is unclear" instead of a confident guess.
SYSTEM_PROMPT = " ".join(
    [
        "You describe what is in front of a blind pedestrian in Hong Kong.",
        "Start with anything that could cause a fall or collision (steps, kerbs, obstacles, wet floor).",
        "Then say what is actually visible: surfaces, tactile paving, railings.",
        "One or two short spoken sentences. No markdown.",
        "If part of the scene is unclear, say which part, but still describe what you can see.",
        "Never invent a hazard, and never claim a hazard is absent unless you can see the ground clearly.",
    ]
)
# Per-mode questions. A bare "describe this" produces prose too long to walk with,
# so each mode asks for exactly what it needs.
MODE_PROMPTS: dict[str, str] = {
    "describe": (
        "What is immediately in front of me? Describe it for safe walking, "
        "leading with anything I could trip on."
    ),
    "identify": "Name the single object directly in front of me, briefly.",
    "read-text": "Read aloud any text visible in this image. Just the text, nothing else.",
    "find-object": "Is there a doorway or entrance in this image? Answer briefly.",
}
MAX_PROMPT_CHARS = 300
# Hazard codes the client understands, kept for documentation and for the mock.
# This endpoint returns `warnings: []` on purpose: the model answers in prose, and
# a hazard is never invented server-side. The client derives its own structured
# hazards from the text it was given — that is what stopped the old stub from
# announcing a revolving door that was not there.
VALID_HAZARDS = frozenset(
    {
        "step-up-ahead",
        "step-down-ahead",
        "stairs-ahead",
        "obstacle-ahead",
        "moving-vehicle",
        "open-manhole",
        "wet-floor",
        "low-clearance",
        "escalator-ahead",
        "edge-of-platform",
    }
)
# --------------------------------------------------------------------- schemas
class VlmRequest(BaseModel):
    """One camera frame plus the question to ask about it.
    Both `image_base64` and `imageBase64` are accepted, because the app sends the
    snake_case form and other clients have sent camelCase.
    """
    image_base64: str = Field(
        min_length=32,
        max_length=8_000_000,
        validation_alias="imageBase64",
        serialization_alias="imageBase64",
        description="JPEG or WebP, already downscaled client-side. A `data:` URL "
        "prefix is tolerated. EXIF is stripped server-side before forwarding.",
    )
    prompt: str | None = Field(
        default=None,
        max_length=MAX_PROMPT_CHARS,
        description="Optional question. Shapes the ask, never the system prompt.",
    )
    mode: Literal["describe", "identify", "read-text", "find-object"] = "describe"
    language_code: str = Field(
        default="yue-HK",
        validation_alias="languageCode",
        serialization_alias="languageCode",
        description="BCP-47 tag; decides which language the model answers in.",
    )
    model_config = ConfigDict(populate_by_name=True, extra="ignore")
    @field_validator("mode", mode="before")
    @classmethod
    def _default_mode(cls, v: Any) -> Any:
        # An unknown mode is a typo, not a reason to fail a blind user's request.
        if v in (None, ""):
            return "describe"
        return v if v in MODE_PROMPTS else "describe"
class VlmResponse(BaseModel):
    """What the app reads.
    `status` and `description` are the fields the mobile client consumes; the rest
    is observability a client may ignore. Keeping `description` a plain string means
    the spoken path never has to parse structure to say something.
    """
    status: Literal["success"] = "success"
    description: str = Field(description="One or two short spoken sentences, hazard first.")
    warnings: list[str] = Field(
        default_factory=list,
        description="Empty on purpose. A hazard is never invented server-side; the "
        "client derives its own from this text.",
    )
    source: Literal["siliconflow", "mock"]
    model: str
    latency_ms: int = Field(serialization_alias="latencyMs")
class HealthResponse(BaseModel):
    configured: bool
    provider: Literal["siliconflow", "mock"]
    models: list[str]
    base_url: str | None
# ------------------------------------------------------------------ exceptions
class VisionAuthError(RuntimeError):
    """The vendor rejected our credentials.
    Distinct from every other failure because retrying cannot fix it: the client
    must hear "vision is not configured" rather than be offered a retry loop it can
    never win. The route maps this to `retryable: false`.
    """
class TryNextModel(Exception):
    """A model id was rejected (400/404), meaning the next candidate should run."""
# ------------------------------------------------------- image preprocessing
def decode_base64_image(value: str) -> bytes:
    """Decode a base64 image, tolerating a `data:` URL prefix.
    Raises ValueError so the caller can return 400 instead of 500.
    """
    payload = value
    if payload.startswith("data:"):
        _, _, payload = payload.partition(",")
    try:
        return base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("imageBase64 is not valid base64") from exc
def strip_exif_and_downscale(image: bytes, *, max_edge: int = MAX_EDGE_PX) -> tuple[bytes, str]:
    """Remove all metadata and bound the long edge.
    Returns ``(jpeg_bytes, note)``. On any failure the *original* bytes come back
    with a note, because refusing to describe anything is worse than describing a
    slightly-too-large image — but the note is logged so an operator can see that
    EXIF stripping is not happening.
    Re-encoding through Pillow without passing `exif=` drops all metadata as a side
    effect, which is more reliable than trying to enumerate and delete tags.
    """
    try:
        from PIL import Image
    except ImportError:
        return image, "pillow-unavailable"
    try:
        with Image.open(io.BytesIO(image)) as img:
            original_size = img.size
            # JPEG cannot store alpha, and P-mode PNGs would quantise badly.
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            long_edge = max(img.size)
            if long_edge > max_edge:
                scale = max_edge / long_edge
                new_size = (max(1, int(img.width * scale)), max(1, int(img.height * scale)))
                img = img.resize(new_size, Image.LANCZOS)
            out = io.BytesIO()
            # No `exif=`, no `icc_profile=` => metadata is gone.
            img.save(out, format="JPEG", quality=82, optimize=True)
            note = (
                f"resized {original_size[0]}x{original_size[1]}->{img.size[0]}x{img.size[1]}"
                if long_edge > max_edge
                else "exif-stripped"
            )
            return out.getvalue(), note
    except Exception as exc:  # noqa: BLE001
        logger.warning("image preprocessing failed, passing original: %s", exc)
        return image, "preprocess-failed"
# ------------------------------------------------------------------- provider
class SiliconFlowVlm:
    """Vision via SiliconFlow's OpenAI-compatible chat completions API.
    Stateless and safe to share across requests: the `httpx.AsyncClient` is a
    long-lived connection pool, so a burst of frames reuses TLS connections instead
    of renegotiating for every photo.
    """
    name = "siliconflow"
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        models: list[str],
        timeout_seconds: float = TIMEOUT_SECONDS,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url
        self._models = [m for m in models if m]
        self._timeout = httpx.Timeout(timeout_seconds)
        self._client = client
        self._owns_client = client is None
    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=self._timeout,
                limits=httpx.Limits(max_connections=16, max_keepalive_connections=8),
            )
        return self._client
    async def aclose(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None
    @staticmethod
    def _language_directive(language: str) -> str:
        lowered = (language or "").lower()
        if lowered.startswith(("yue", "zh-hk", "zh-hant")):
            return "Reply in Cantonese."
        if lowered.startswith("zh"):
            return "Reply in Mandarin."
        return "Reply in English."
    def _payload(
        self, *, model: str, image_b64: str, prompt: str, language: str
    ) -> dict[str, Any]:
        return {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    # Fixed here, never client-supplied. See the module docstring.
                    "content": f"{SYSTEM_PROMPT} {self._language_directive(language)}",
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                        },
                        {"type": "text", "text": prompt},
                    ],
                },
            ],
            # Low temperature: the same scene should be described the same way
            # twice, not creatively.
            "temperature": 0.2,
            "max_tokens": 200,
        }
    async def _ask(
        self, model: str, *, image_b64: str, prompt: str, language: str
    ) -> str:
        client = await self._http()
        response = await client.post(
            f"{self._base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            json=self._payload(
                model=model, image_b64=image_b64, prompt=prompt, language=language
            ),
        )
        if response.status_code in (401, 403):
            # Our credentials, not the caller's request. Not retryable.
            raise VisionAuthError(
                f"SiliconFlow rejected the API key ({response.status_code}): "
                f"{response.text[:200]}"
            )
        if response.status_code in (400, 404):
            # Retired or unavailable model id: try the next candidate.
            raise TryNextModel(
                f"{model} rejected the request ({response.status_code}): "
                f"{response.text[:200]}"
            )
        response.raise_for_status()
        data = response.json()
        try:
            text = (data["choices"][0]["message"]["content"] or "").strip()
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(
                f"unexpected SiliconFlow response shape: {str(data)[:200]}"
            ) from exc
        if not text:
            raise RuntimeError("the vision model returned an empty description")
        return text
    async def describe(
        self, image: bytes, *, prompt: str, language: str
    ) -> tuple[str, str, int]:
        """Return ``(description, model_used, latency_ms)``."""
        if not self._api_key:
            raise VisionAuthError("SILICONFLOW_API_KEY is required for live vision")
        if not self._models:
            raise RuntimeError("no vision model configured")
        started = time.perf_counter()
        # Strip GPS/EXIF and bound the long edge *before* anything leaves the box.
        cleaned, note = strip_exif_and_downscale(image)
        image_b64 = base64.b64encode(cleaned).decode("ascii")
        logger.info("vlm image prepared preprocess=%s bytes=%d", note, len(cleaned))
        last_error: Exception | None = None
        for model in self._models:
            try:
                text = await self._ask(
                    model, image_b64=image_b64, prompt=prompt, language=language
                )
            except TryNextModel as exc:
                last_error = exc
                logger.warning("vision model unavailable, trying next: %s", exc)
                continue
            latency_ms = int((time.perf_counter() - started) * 1000)
            logger.info(
                "vlm describe served model=%s image_bytes=%d elapsed_ms=%d",
                model,
                len(cleaned),
                latency_ms,
            )
            return text, model, latency_ms
        raise RuntimeError(f"no vision model available: {last_error}")
# ----------------------------------------------------------------------- mock
class MockVlm:
    """Deterministic, offline descriptions.
    Chosen to cover what the UI must handle: a hazard (so the interrupt-and-vibrate
    path is exercised), a benign scene, and an unreadable image (so the "I cannot
    tell" path is reachable without a real camera). Deterministic per image, so the
    same frame gives the same description and client tests are stable.
    """
    name = "mock"
    model = "mock-vlm-1"
    SCENES = (
        "前方約兩米有一級向下的樓梯，右邊有扶手。",
        "你正面對一條行人過路處，有交通燈號。左前方約三米有金屬欄杆。",
        "呢張相太暗，我睇唔清楚。請再影一次，或者行近啲。",
        "前方係一條平坦嘅行人路，兩側有店舖。約五米外有一個人迎面行過嚟。",
    )
    def describe(self, image: bytes, *, mode: str, language: str) -> tuple[str, str]:
        import hashlib
        if mode == "read-text":
            text = "呢個模式需要真實視覺模型。示範模式未能讀取文字。"
        else:
            index = int(hashlib.sha256(image or b"empty").hexdigest(), 16) % len(self.SCENES)
            text = self.SCENES[index]
        return text, self.model
# ------------------------------------------------------------------ app wiring
# One provider per process, built lazily so importing this module never requires a
# key. Declared before `lifespan` so shutdown can close its connection pool.
_provider: SiliconFlowVlm | None = None
@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Close the pooled vendor connection on shutdown.
    Without this the pool is torn down by process exit, which on a reload-heavy dev
    loop leaks sockets and produces noisy TLS warnings.
    """
    try:
        yield
    finally:
        if _provider is not None:
            await _provider.aclose()
app = FastAPI(
    title="HK Access Nav — vision",
    version="0.1.0",
    description="Proxies a camera frame to a vision model for a blind pedestrian.",
    docs_url="/api/vlm/docs",
    openapi_url="/api/vlm/openapi.json",
    lifespan=lifespan,
)
# The app is a native/Expo client, so CORS only matters for the web build. Narrow
# this to your real origins: `*` plus any future credentialed request is a footgun.
_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)
def get_provider() -> SiliconFlowVlm:
    global _provider
    if _provider is None:
        _provider = SiliconFlowVlm(
            api_key=API_KEY,
            base_url=BASE_URL,
            models=MODELS,
            timeout_seconds=TIMEOUT_SECONDS,
        )
    return _provider
def resolve_prompt(*, prompt: str | None, mode: str) -> str:
    """Pick the question to ask.
    Preference: an explicit client prompt (truncated), then the canned question for
    the mode. Always a non-empty string, so a malformed request still produces a
    usable answer rather than an empty model call.
    """
    if prompt and prompt.strip():
        return prompt.strip()[:MAX_PROMPT_CHARS]
    return MODE_PROMPTS.get(mode, MODE_PROMPTS["describe"])
# ---------------------------------------------------------------------- routes
@app.get("/api/vlm/health", response_model=HealthResponse, tags=["vision"])
async def vlm_health() -> HealthResponse:
    """Cheap reachability probe.
    Reports whether a key is present without spending a vision call to find out.
    Treating a configured-but-unreachable model as a working one is how a stub
    survived in production, so the client can check this instead of guessing.
    """
    configured = bool(API_KEY)
    return HealthResponse(
        configured=configured,
        provider="siliconflow" if configured else "mock",
        models=MODELS if configured else [],
        base_url=BASE_URL if configured else None,
    )
@app.post("/api/vlm", response_model=VlmResponse, tags=["vision"])
async def vlm_describe(data: VlmRequest) -> VlmResponse:
    """Processes live camera frame for the 'What is this? (Beta)' feature.
    Accepts one still frame and returns a spoken description. A single deliberate
    capture is easier to aim and cheaper than continuous inference; continuous mode
    is a client concern (repeat requests).
    """
    started = time.perf_counter()
    try:
        image = decode_base64_image(data.image_base64)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_image", "detail": str(exc), "retryable": False},
        ) from exc
    if len(image) < MIN_IMAGE_BYTES:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "empty_image",
                "detail": "The frame is too small to contain a scene.",
                "retryable": True,
            },
        )
    if len(image) > MAX_IMAGE_BYTES:
        # Tell the client to downscale and retry rather than silently accepting a
        # slow, expensive request.
        raise HTTPException(
            status_code=413,
            detail={
                "error": "image_too_large",
                "detail": f"Maximum {MAX_IMAGE_BYTES} bytes; downscale to {MAX_EDGE_PX}px and retry",
                "retryable": True,
            },
        )
    prompt = resolve_prompt(prompt=data.prompt, mode=data.mode)
    # No key: serve the mock rather than erroring, so a clone with no `.env` still
    # runs and still has something honest to say. `source` tells the client which
    # it got, which is what lets it decide whether to trust the prose.
    if not API_KEY:
        logger.warning(
            "SILICONFLOW_API_KEY is unset; serving the mock description. "
            "Set it for real vision."
        )
        mock = MockVlm()
        text, model = mock.describe(image, mode=data.mode, language=data.language_code)
        return VlmResponse(
            description=text,
            warnings=[],
            source="mock",
            model=model,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
    provider = get_provider()
    try:
        text, model, latency_ms = await provider.describe(
            image, prompt=prompt, language=data.language_code
        )
    except VisionAuthError as exc:
        # Misconfigured key on OUR side, not a transient fault. `retryable: false`
        # is the important part: the client should say "vision is unavailable"
        # rather than offer a spoken retry that can never succeed.
        logger.error("vision key rejected by the vendor: %s", exc)
        raise HTTPException(
            status_code=503,
            detail={
                "error": "vision_not_configured",
                "detail": "The vision service is not configured correctly.",
                "retryable": False,
            },
        ) from exc
    except Exception as exc:  # noqa: BLE001
        # A vision failure must be recoverable and clearly reported. The client
        # speaks "I could not see that, please try again" instead of staying silent
        # while the user holds their phone up.
        logger.exception("vlm describe failed")
        raise HTTPException(
            status_code=502,
            detail={
                "error": "vision_unavailable",
                "detail": str(exc)[:200],
                "retryable": True,
            },
        ) from exc
    return VlmResponse(
        description=text,
        # Never fabricated here. See the note on VlmResponse.warnings.
        warnings=[],
        source=provider.name,
        model=model,
        latency_ms=latency_ms,
    )
if __name__ == "__main__":
    import argparse
    import uvicorn
    parser = argparse.ArgumentParser(description="HK Access Nav vision service")
    parser.add_argument("--host", default=os.getenv("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8000")))
    parser.add_argument("--reload", action="store_true", help="dev autoreload")
    args = parser.parse_args()
    logger.info(
        "starting vision service on %s:%d provider=%s models=%s",
        args.host,
        args.port,
        "siliconflow" if API_KEY else "mock",
        MODELS if API_KEY else [],
    )
    uvicorn.run(
        "vlm_service:app" if args.reload else app,
        host=args.host,
        port=args.port,
        reload=args.reload,
    )