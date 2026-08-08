"""Diagnosis tests (SPEC 10, milestone M1).

These encode the calibration outcomes recorded in NOTES.md. Two of them exist
specifically because the version 1.1 draft got them wrong.
"""

from __future__ import annotations

import pytest

from meshfix.diagnose import analyze
from tests.fixtures.generate import build

pytestmark = pytest.mark.filterwarnings("ignore::RuntimeWarning")


def diag(name: str):
    return analyze(build(name))


def test_clean_cube_is_printable():
    d = diag("clean_cube")
    assert d.verdict == "printable"
    assert d.is_watertight and d.is_winding_consistent
    assert d.n_boundary_edges == 0
    assert d.n_nonmanifold_edges == 0
    assert d.n_selfintersecting_faces == 0
    assert d.genus == 0
    assert d.volume == pytest.approx(1000.0)


def test_open_cube_is_open_but_not_a_shell():
    """A chunky solid missing one face must not be mistaken for a sheet.

    The draft formula scored this 0.94 (shell) purely because 4 of its 18 edges
    are boundary edges — boundary ratio tracks tessellation density, not
    shell-ness.
    """
    d = diag("open_cube")
    assert not d.is_watertight
    assert d.n_boundary_edges == 4
    assert d.shell_score < 0.5
    assert d.verdict == "repairable"


def test_nonmanifold_edge_detected():
    d = diag("nonmanifold_edge")
    assert d.n_nonmanifold_edges == 1


def test_bowtie_vertex_is_caught_by_the_vertex_test():
    """The case an edge-only manifold test cannot see (SPEC 5.2, change C11)."""
    d = diag("bowtie_vertex")
    assert d.is_watertight              # every edge has exactly two faces ...
    assert d.n_nonmanifold_edges == 0   # ... so the edge test reports nothing
    assert d.n_nonmanifold_vertices == 1  # only the fan test finds it


def test_selfintersection_is_detected_and_is_not_winding():
    d = diag("selfintersect_torus")
    assert d.n_selfintersecting_faces > 0
    # Both tori are individually well-wound; self-intersection is a separate
    # concept from broken faces / winding (SPEC 15).
    assert d.is_winding_consistent


def test_clean_mesh_has_no_false_selfintersections():
    for name in ("clean_cube", "flipped_normals", "two_components", "thin_shell"):
        assert analyze(build(name)).n_selfintersecting_faces == 0, name


@pytest.mark.parametrize("scale", [1.0, 1e-3, 1e3])
def test_selfintersection_verdict_does_not_depend_on_model_scale(scale):
    """A5 must not change its mind when the same mesh is measured in other units.

    It used to. The parallel-plane test compared the *unnormalised* ``n1 x n2``
    against a fixed epsilon, and that quantity scales with the product of the
    face areas — so shrinking a mesh made every pair look coplanar, and two
    perpendicular walls meeting at a corner were reported as intersecting. On a
    voxel mesh a few thousandths across that flagged 27771 of 71920 faces.
    """
    mesh = build("clean_cube")
    mesh.apply_scale(scale)
    assert analyze(mesh).n_selfintersecting_faces == 0

    tangled = build("selfintersect_torus")
    tangled.apply_scale(scale)
    assert analyze(tangled).n_selfintersecting_faces > 0


def test_faces_closer_together_than_float32_are_not_an_intersection():
    """Two triangles a hair apart, not overlapping in plane, must read as clean.

    A mesh round-trips through binary STL, which stores float32, so a gap of
    1e-11 at coordinates near 0.1 is 700x under the spacing the file can even
    express. The old code decided coplanarity from the angle between the normals
    alone; these two just missed that threshold, went down the crossing-chord
    branch, and every vertex within eps of the plane was counted as lying on it
    — turning the "chord" into the whole triangle and any two such triangles
    into an overlap.
    """
    import numpy as np

    from meshfix.selfintersect import self_intersecting_faces

    # Side by side in x, 1e-11 apart in z: no shared vertex, no in-plane overlap.
    vertices = np.array([
        [-0.0959, 0.0004, 0.00046],
        [-0.0923, 0.0016, 0.00046],
        [-0.0960, 0.0061, 0.00046],
        [-0.0858, 0.0118, 0.00046 + 1e-11],
        [-0.0904, 0.0049, 0.00046 + 1e-11],
        [-0.0853, 0.0106, 0.00046 + 1e-11],
    ])
    faces = np.array([[0, 1, 2], [3, 4, 5]])
    assert len(self_intersecting_faces(vertices, faces)) == 0

    # And a pair that genuinely crosses is still caught.
    assert len(self_intersecting_faces(*_crossing_pair())) == 2


def _crossing_pair():
    """Two triangles that really do pass through each other."""
    import numpy as np

    vertices = np.array([
        [0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, 4.0, 0.0],
        [1.0, 1.0, -1.0], [1.0, 1.0, 1.0], [3.0, 1.0, 0.0],
    ])
    return vertices, np.array([[0, 1, 2], [3, 4, 5]])


def test_flipped_normals_is_not_a_shell():
    """Inconsistent winding corrupts the divergence volume.

    The draft formula therefore scored this solid sphere 0.60 on thinness. A
    closed mesh encloses volume by definition, so A10 must ignore it.
    """
    d = diag("flipped_normals")
    assert not d.is_winding_consistent
    assert d.n_boundary_edges == 0
    assert d.shell_score == 0.0
    assert d.verdict == "repairable"


def test_degenerate_faces_detected():
    d = diag("degenerate_slivers")
    assert d.n_degenerate_faces == 2


def test_two_components_counted():
    assert diag("two_components").n_components == 2


def test_open_shell_scores_high():
    d = diag("open_shell")
    assert d.n_boundary_edges > 0
    assert d.shell_score >= 0.5
    assert d.verdict == "shell"


def test_thin_plate_is_a_solid_not_a_shell():
    """0.2 units thick but closed: that is A9's problem, not A10's."""
    d = diag("thin_shell")
    assert d.is_watertight
    assert d.shell_score == 0.0
    assert d.verdict == "printable"


def test_ai_like_blob_is_severe():
    d = diag("ai_like_blob")
    assert d.verdict == "severe"
    assert d.n_selfintersecting_faces > 0
    assert d.n_boundary_edges > 0


def test_analyze_does_not_mutate_input():
    mesh = build("degenerate_slivers")
    before = (mesh.vertices.copy(), mesh.faces.copy())
    analyze(mesh)
    assert (mesh.vertices == before[0]).all()
    assert (mesh.faces == before[1]).all()
