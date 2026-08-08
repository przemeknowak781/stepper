"""The CGAL alpha-wrapping backend (SPEC 7.1, milestone M4).

Most of these run only when ``meshfix/bin/aw3`` has been built
(``scripts/build_aw3.sh``). That is the point of the backend being optional —
meshfix installs and passes its suite with pip alone — so the tests that do not
need the binary check exactly that: that its absence is reported as a reason,
not as a crash.
"""

from __future__ import annotations

import logging

import pytest

from meshfix.backends import RunContext, get_backend
from meshfix.backends.alphawrap import find_binary
from meshfix.diagnose import analyze
from meshfix.io import load_mesh, save_mesh
from meshfix.metrics import compare
from tests.fixtures.generate import build

needs_binary = pytest.mark.skipif(find_binary() is None, reason="aw3 not built")


def test_absence_is_reported_as_a_reason_not_a_crash():
    backend = get_backend("alphawrap")
    ok, reason = backend.available()
    if find_binary() is None:
        assert ok is False
        assert "build_aw3" in reason      # tells the user what to do about it
    else:
        assert (ok, reason) == (True, "")


def test_parameters_scale_with_the_model_not_its_triangle_count():
    """Alpha is a length in model units, so a fixed value cannot be right.

    The same shape at two sizes must get proportional alphas — otherwise one of
    the two is either carved to pieces or wrapped as a featureless blob.
    """
    backend = get_backend("alphawrap")
    small = build("clean_cube")
    big = small.copy()
    big.apply_scale(10.0)

    a = backend.suggest_params(small, RunContext(bbox_diagonal=float(small.scale)))
    b = backend.suggest_params(big, RunContext(bbox_diagonal=float(big.scale)))
    assert b["alpha"] == pytest.approx(a["alpha"] * 10.0, rel=1e-6)
    assert b["offset"] == pytest.approx(a["offset"] * 10.0, rel=1e-6)


def test_explicit_parameters_win_over_the_suggestion():
    backend = get_backend("alphawrap")
    params = backend.suggest_params(
        build("clean_cube"), RunContext(bbox_diagonal=17.0, alpha=0.5, offset=0.01)
    )
    assert params == {"alpha": 0.5, "offset": 0.01}


@needs_binary
def test_wraps_a_broken_mesh_into_a_clean_solid(tmp_path):
    """The reason this backend leads the chain: it repairs *and* stays economical."""
    source = tmp_path / "in.stl"
    save_mesh(build("selfintersect_torus"), source)

    backend = get_backend("alphawrap")
    mesh = load_mesh(source)
    params = backend.suggest_params(mesh, RunContext(bbox_diagonal=float(mesh.scale)))
    result = backend.run(source, tmp_path / "out.stl", params, logging.getLogger("test"))

    assert result.success, result.message
    diagnosis = analyze(load_mesh(result.output_path))
    assert diagnosis.is_watertight
    assert diagnosis.is_winding_consistent
    assert diagnosis.n_nonmanifold_edges == 0
    assert diagnosis.n_components == 1
    assert diagnosis.n_degenerate_faces == 0
    # A wrap that is guaranteed intersection-free must read as one. It did not
    # until the coplanar tolerance was floored at the storage precision: the
    # STL round trip through float32 leaves faces ~1e-11 apart, which the
    # crossing-chord branch mistook for an overlap (NOTES.md §10).
    assert diagnosis.n_selfintersecting_faces == 0


@needs_binary
def test_an_absurd_alpha_still_succeeds_and_is_caught_by_validation(tmp_path):
    """The backend/validation split (SPEC 15), on the case that shows why it exists.

    An alpha far larger than the model does not fail — CGAL returns a coarse
    blob, an 8-face shape for a cube. It is watertight and manifold, so every
    topological criterion passes and the backend has nothing to report. What
    rules it out is fidelity: the blob is nowhere near the input. A backend that
    judged its own output would have called this a success.
    """
    cube = build("clean_cube")
    source = tmp_path / "in.stl"
    save_mesh(cube, source)

    backend = get_backend("alphawrap")
    result = backend.run(
        source, tmp_path / "out.stl", {"alpha": 1e3, "offset": 1e2}, logging.getLogger("test")
    )
    assert result.success, result.message

    produced = load_mesh(result.output_path)
    assert analyze(produced).is_watertight        # topologically impeccable...
    metrics = compare(cube, produced, seed=0)
    assert metrics["hausdorff_two_sided"] > cube.scale * 0.05   # ...and nothing like a cube
