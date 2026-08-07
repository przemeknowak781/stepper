"""Shell thickening, and the dependency guard that should have caught it.

SciPy and NetworkX were dropped to halve the Pyodide payload (NOTES.md §8), but
nothing in the suite *enforced* the drop — so ``thicken_shell`` kept calling
``trimesh.repair.fix_normals`` and ``mesh.vertex_normals``, both of which route
through trimesh's graph layer and refuse to run without one of them. The
failure only surfaced when a real open-shell model reached ``--shell-thickness``
and died with ``ModuleNotFoundError: No module named 'networkx'``.
"""

from __future__ import annotations

import builtins
import contextlib
import sys

import numpy as np
import pytest
import trimesh

from meshfix.postprocess import orient_consistently, thicken_shell, vertex_normals
from tests.fixtures.generate import build


@contextlib.contextmanager
def no_optional_graph_engines():
    """Make ``import scipy`` / ``import networkx`` fail for the duration."""
    banned = ("scipy", "networkx")
    saved = {k: v for k, v in sys.modules.items() if k.split(".")[0] in banned}
    for name in saved:
        del sys.modules[name]

    real_import = builtins.__import__

    def guarded(name, *args, **kwargs):
        if name.split(".")[0] in banned:
            raise ModuleNotFoundError(f"No module named {name.split('.')[0]!r}")
        return real_import(name, *args, **kwargs)

    builtins.__import__ = guarded
    try:
        yield
    finally:
        builtins.__import__ = real_import
        sys.modules.update(saved)


def test_thickening_needs_neither_scipy_nor_networkx():
    shell = build("open_cube")
    with no_optional_graph_engines():
        solid = thicken_shell(shell, 0.1)
    assert solid.is_watertight


def test_vertex_normals_do_not_depend_on_how_a_face_was_cut_up():
    """Angle weighting, not area weighting.

    A cube's corners are shared by different numbers of triangles depending on
    how each face was split, so area weighting drags a corner normal towards
    the busier side — (-0.82, -0.41, -0.41) instead of the (-0.58, -0.58,
    -0.58) every corner should get. Since these normals are the direction a
    shell is offset along, a skewed corner normal is a skewed wall.
    """
    cube = trimesh.creation.box()
    normals = vertex_normals(
        np.asarray(cube.vertices, dtype=np.float64),
        np.asarray(cube.faces, dtype=np.int64),
    )
    assert np.allclose(np.abs(normals), 1 / np.sqrt(3))

    sphere = trimesh.creation.icosphere(subdivisions=2)
    ours = vertex_normals(
        np.asarray(sphere.vertices, dtype=np.float64),
        np.asarray(sphere.faces, dtype=np.int64),
    )
    assert np.allclose(ours, np.asarray(sphere.vertex_normals), atol=1e-6)


def test_thickened_shell_encloses_area_times_thickness():
    shell = build("open_cube")
    thickness = 0.05
    solid = thicken_shell(shell, thickness)
    assert solid.is_watertight
    # Winding, and the raw divergence integral rather than `solid.volume`.
    # trimesh normalises the sign, which hid a rim band wound inward: the band
    # cancelled instead of adding, and `abs(solid.volume)` still came back
    # right for this fixture while the raw integral was 47% low.
    assert solid.is_winding_consistent
    assert _divergence_volume(solid) == pytest.approx(shell.area * thickness, rel=0.05)


def test_rim_band_is_wound_outward_on_a_flat_sheet():
    """The case that exposes an inverted band: a sheet whose rim carries volume.

    Boundary edges have to keep the direction their owning face traverses them.
    Sorting each edge to count its uses discards that, and a band built from
    sorted pairs is wound at random — here the two shells alone integrate to
    13.33 of the 40 the wall encloses, with the band cancelling the rest.
    """
    n, size = 8, 10.0
    vertices = np.array(
        [[(i / n) * size, (j / n) * size, 0.0] for j in range(n + 1) for i in range(n + 1)]
    )
    faces = []
    for j in range(n):
        for i in range(n):
            a = j * (n + 1) + i
            faces += [[a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]]
    sheet = trimesh.Trimesh(vertices=vertices, faces=np.array(faces), process=False)

    solid = thicken_shell(sheet, 0.4)
    assert solid.is_watertight
    assert solid.is_winding_consistent
    assert _divergence_volume(solid) == pytest.approx(100.0 * 0.4, rel=1e-6)


def _divergence_volume(mesh: trimesh.Trimesh) -> float:
    tri = np.asarray(mesh.vertices)[np.asarray(mesh.faces)]
    return float(np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum() / 6.0)


def test_thicken_rejects_a_non_positive_wall():
    with pytest.raises(ValueError):
        thicken_shell(build("open_cube"), 0.0)


def test_orient_consistently_agrees_across_a_shared_edge():
    cube = build("flipped_normals")
    vertices = np.asarray(cube.vertices, dtype=np.float64)
    fixed = orient_consistently(vertices, np.asarray(cube.faces, dtype=np.int64))
    repaired = trimesh.Trimesh(vertices=vertices, faces=fixed, process=False)
    assert repaired.is_winding_consistent
    assert repaired.volume > 0        # closed components are turned outward
