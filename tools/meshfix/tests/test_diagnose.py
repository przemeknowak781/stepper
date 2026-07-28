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
