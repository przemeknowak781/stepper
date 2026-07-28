"""Local HTTP service, so Stepper can use meshfix as a repair backend (SPEC 16).

Built on :mod:`http.server` from the standard library: the API is three
endpoints, and a web framework would add a dependency that SPEC 12 does not
list for the sake of routing.

Security posture — this opens a port on the user's machine, so:

* The socket binds to **127.0.0.1 only**, never ``0.0.0.0``. The service is
  not reachable from the network.
* Cross-origin requests are checked against an explicit allowlist. A page from
  an origin that is not on it gets no CORS headers, and the browser blocks it.
* ``POST /api/repair`` requires ``Content-Type: application/octet-stream``,
  which forces a CORS preflight. A hostile page therefore cannot make the
  request fire at all without first passing the origin check.

Mixed content, the one deployment wrinkle: a page served over **https** may
call ``http://localhost`` only because localhost counts as a potentially
trustworthy origin. Chromium honours this; Firefox and Safari have historically
blocked it. Serving the Stepper build from this same service (``--serve-app``)
sidesteps the whole question by making the app and the API one origin.
"""

from __future__ import annotations

import base64
import json
import logging
import mimetypes
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import __version__
from .backends import KNOWN_BACKENDS, RunContext, get_backend
from .diagnose import SHELL_SCORE_THRESHOLD, analyze
from .io import load_mesh, save_mesh, sha256_file
from .metrics import compare
from .orchestrate import build_chain, run_chain
from .postprocess import thicken_shell
from .report import Report
from .validate import validate

log = logging.getLogger("meshfix.serve")

DEFAULT_PORT = 8787
MAX_UPLOAD_BYTES = 256 * 1024 * 1024

DEFAULT_ALLOWED_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    f"http://localhost:{DEFAULT_PORT}",
    f"http://127.0.0.1:{DEFAULT_PORT}",
    "https://przemeknowak781.github.io",
)


class _Handler(BaseHTTPRequestHandler):
    server_version = f"meshfix/{__version__}"
    allowed_origins: tuple[str, ...] = DEFAULT_ALLOWED_ORIGINS
    app_dir: Path | None = None

    # -- plumbing ---------------------------------------------------------
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        log.info("%s - %s", self.address_string(), fmt % args)

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        return origin is None or origin in self.allowed_origins

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin and origin in self.allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    # -- routes -----------------------------------------------------------
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        route = urlparse(self.path).path
        if route == "/api/health":
            available = {}
            for name in KNOWN_BACKENDS:
                try:
                    ok, reason = get_backend(name).available()
                except KeyError:
                    ok, reason = False, "not implemented"
                available[name] = {"available": ok, "reason": reason}
            self._json(
                {
                    "service": "meshfix",
                    "version": __version__,
                    "backends": available,
                    "max_upload_bytes": MAX_UPLOAD_BYTES,
                }
            )
            return
        self._serve_app(route)

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path not in ("/api/repair", "/api/diagnose"):
            self._json({"error": "not found"}, 404)
            return
        if not self._origin_ok():
            self._json({"error": "origin not allowed"}, 403)
            return
        if self.headers.get("Content-Type", "") != "application/octet-stream":
            # Enforcing this content type is what forces a CORS preflight.
            self._json({"error": "expected Content-Type: application/octet-stream"}, 415)
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self._json({"error": f"body must be 1..{MAX_UPLOAD_BYTES} bytes"}, 413)
            return
        payload = self.rfile.read(length)

        params = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
        diagnose_only = urlparse(self.path).path == "/api/diagnose"
        try:
            self._json(_process(payload, params, diagnose_only=diagnose_only))
        except Exception as exc:  # noqa: BLE001 - surfaced to the caller, never swallowed
            log.exception("repair failed")
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def _serve_app(self, route: str) -> None:
        """Optionally serve the Stepper build, so app and API share an origin."""
        if self.app_dir is None:
            self._json({"error": "not found"}, 404)
            return
        relative = route.lstrip("/") or "index.html"
        target = (self.app_dir / relative).resolve()
        if not str(target).startswith(str(self.app_dir.resolve())):
            self._json({"error": "forbidden"}, 403)
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            target = self.app_dir / "index.html"  # SPA fallback
        if not target.is_file():
            self._json({"error": "not found"}, 404)
            return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _process(payload: bytes, params: dict, *, diagnose_only: bool) -> dict:
    """Run diagnosis (and optionally repair) over an uploaded mesh."""
    seed = int(params.get("seed", 0))
    expected_components = int(params.get("expected_components", 1))
    strict = params.get("strict") == "true"
    min_wall = float(params["min_wall"]) if params.get("min_wall") else None
    shell_thickness = (
        float(params["shell_thickness"]) if params.get("shell_thickness") else None
    )

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        source_path = workdir / "input.stl"
        source_path.write_bytes(payload)
        mesh = load_mesh(source_path)
        diagnosis = analyze(mesh)

        max_deviation = float(
            params.get("max_deviation") or 0.005 * diagnosis.bbox_diagonal
        )
        report = Report(
            input_path="upload.stl",
            input_sha256=sha256_file(source_path),
            input_diagnosis=diagnosis,
            dry_run=diagnose_only,
        )

        input_validation = validate(
            diagnosis,
            expected_components=expected_components,
            min_wall=min_wall,
            shell_thickness=shell_thickness,
            check_shell=True,
            strict=strict,
        )
        if diagnose_only:
            report.validation = input_validation
            report.accepted = input_validation.accepted
            return {"report": report.to_dict(), "stl_base64": None}

        a10 = input_validation.criteria["A10"]
        if a10.active and a10.passed is False:
            report.validation = input_validation
            report.accepted = False
            return {"report": report.to_dict(), "stl_base64": None, "refused": a10.reason}

        if shell_thickness is not None and diagnosis.shell_score >= SHELL_SCORE_THRESHOLD:
            mesh = thicken_shell(mesh, shell_thickness)
            report.warnings.append(f"shell_thickened (thickness={shell_thickness})")
            save_mesh(mesh, source_path)

        ctx = RunContext(
            seed=seed,
            max_deviation=max_deviation,
            bbox_diagonal=diagnosis.bbox_diagonal,
            voxel_resolution=int(params.get("voxel_resolution", 256)),
            voxel_size=float(params["voxel_size"]) if params.get("voxel_size") else None,
            seal=int(params.get("seal", 1)),
        )
        chain = build_chain(diagnosis.verdict, params.get("backend", "auto"), None)
        outcome = run_chain(
            source=mesh, source_path=source_path, chain=chain, workdir=workdir, ctx=ctx,
            expected_components=expected_components, max_deviation=max_deviation,
            min_wall=min_wall, strict=strict, seed=seed,
        )
        report.warnings.extend(outcome.warnings)
        report.backend_attempts = [a.to_dict() for a in outcome.attempts]

        if outcome.best is None:
            report.validation = input_validation
            report.accepted = False
            return {"report": report.to_dict(), "stl_base64": None}

        data = Path(outcome.best.output_path).read_bytes()
        report.backend_selected = outcome.best.name
        report.output_path = "output.stl"
        report.output_diagnosis = outcome.best.diagnosis
        report.validation = outcome.best.validation
        report.metrics = outcome.best.metrics
        report.accepted = outcome.best.passed
        return {
            "report": report.to_dict(),
            "stl_base64": base64.b64encode(data).decode(),
        }


def make_server(
    port: int = DEFAULT_PORT,
    *,
    allowed_origins: tuple[str, ...] = DEFAULT_ALLOWED_ORIGINS,
    app_dir: Path | None = None,
) -> ThreadingHTTPServer:
    handler = type(
        "BoundHandler",
        (_Handler,),
        {"allowed_origins": tuple(allowed_origins), "app_dir": app_dir},
    )
    # Loopback only: this must never be reachable from the network.
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def serve(
    port: int = DEFAULT_PORT,
    *,
    allowed_origins: tuple[str, ...] = DEFAULT_ALLOWED_ORIGINS,
    app_dir: Path | None = None,
) -> None:
    httpd = make_server(port, allowed_origins=allowed_origins, app_dir=app_dir)
    log.warning("meshfix listening on http://127.0.0.1:%d (loopback only)", port)
    if app_dir:
        log.warning("serving Stepper build from %s at the same origin", app_dir)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()


def serve_in_thread(
    port: int = DEFAULT_PORT, **kwargs
) -> tuple[ThreadingHTTPServer, threading.Thread]:
    """Start the server on a background thread; used by the tests."""
    httpd = make_server(port, **kwargs)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, thread
