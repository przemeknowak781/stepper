"""Local service tests (SPEC 16)."""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request

import pytest

from meshfix.backends.alphawrap import find_binary
from meshfix.io import save_mesh
from meshfix.serve import serve_in_thread
from tests.fixtures.generate import build

pytestmark = pytest.mark.filterwarnings("ignore::RuntimeWarning")
PORT = 8799
ORIGIN = "http://localhost:5173"


@pytest.fixture(scope="module")
def service():
    httpd, _ = serve_in_thread(PORT)
    yield f"http://127.0.0.1:{PORT}"
    httpd.shutdown()


def _post(base, route, payload, origin=ORIGIN, content_type="application/octet-stream"):
    request = urllib.request.Request(
        f"{base}{route}", data=payload, method="POST",
        headers={"Content-Type": content_type, **({"Origin": origin} if origin else {})},
    )
    return urllib.request.urlopen(request, timeout=120)


def _stl_bytes(name, tmp_path):
    path = tmp_path / f"{name}.stl"
    save_mesh(build(name), path)
    return path.read_bytes()


def test_health_lists_backends(service):
    data = json.loads(urllib.request.urlopen(f"{service}/api/health", timeout=10).read())
    assert data["service"] == "meshfix"
    assert data["backends"]["voxel"]["available"] is True
    # alphawrap depends on a binary that may or may not have been built. Either
    # way the service reports the truth, with a reason when it is missing —
    # rather than omitting the backend and leaving the client to guess.
    alphawrap = data["backends"]["alphawrap"]
    assert alphawrap["available"] is (find_binary() is not None)
    if not alphawrap["available"]:
        assert "build_aw3" in alphawrap["reason"]


def test_repair_returns_a_watertight_solid(service, tmp_path):
    payload = _stl_bytes("ai_like_blob", tmp_path)
    response = _post(service, "/api/repair?voxel_resolution=64", payload)
    body = json.loads(response.read())
    assert body["report"]["accepted"] is True
    assert body["report"]["output"]["diagnosis"]["is_watertight"] is True
    assert base64.b64decode(body["stl_base64"])[:4] is not None


def test_diagnose_does_not_return_a_mesh(service, tmp_path):
    body = json.loads(_post(service, "/api/diagnose", _stl_bytes("open_cube", tmp_path)).read())
    assert body["stl_base64"] is None
    assert body["report"]["input"]["diagnosis"]["is_watertight"] is False


def test_open_shell_is_refused_not_silently_thickened(service, tmp_path):
    body = json.loads(_post(service, "/api/repair", _stl_bytes("open_shell", tmp_path)).read())
    assert body["stl_base64"] is None
    assert "shell" in body["refused"]
    assert body["report"]["accepted"] is False


def test_shell_thickness_unblocks_it(service, tmp_path):
    body = json.loads(
        _post(service, "/api/repair?shell_thickness=1.0&voxel_resolution=64",
              _stl_bytes("open_shell", tmp_path)).read()
    )
    assert body["stl_base64"] is not None
    assert any("shell_thickened" in w for w in body["report"]["warnings"])


def test_disallowed_origin_is_rejected(service, tmp_path):
    with pytest.raises(urllib.error.HTTPError) as exc:
        _post(service, "/api/repair", _stl_bytes("clean_cube", tmp_path),
              origin="https://evil.example")
    assert exc.value.code == 403


def test_wrong_content_type_is_rejected(service, tmp_path):
    """The octet-stream requirement is what forces a CORS preflight."""
    with pytest.raises(urllib.error.HTTPError) as exc:
        _post(service, "/api/repair", _stl_bytes("clean_cube", tmp_path),
              content_type="text/plain")
    assert exc.value.code == 415
