"""Metric tests (SPEC 10.2, milestone M2).

Closing criterion for M2 is monotonicity under controlled deformation: a
metric that does not grow with a deliberately increased error is not measuring
anything.
"""

from __future__ import annotations

import numpy as np
import pytest
import trimesh

from meshfix.metrics import compare, surface_samples, wall_thickness
from tests.fixtures.generate import build

pytestmark = pytest.mark.filterwarnings("ignore::RuntimeWarning")

SAMPLES = 20_000


def test_identical_meshes_deviate_only_by_the_sampling_floor():
    """A sampled estimator cannot reach zero, and must say so.

    Two independent point sets on the same surface sit about one inter-sample
    spacing apart, so the honest expectation is "at the noise floor", not
    "zero". The reported floor has to bound the measured value.
    """
    cube = build("clean_cube")
    m = compare(cube, cube, seed=0, samples=SAMPLES)
    assert m["hausdorff_two_sided"] <= 3.0 * m["hausdorff_noise_floor"]
    assert m["hausdorff_two_sided"] < 0.05 * 17.32  # well under the bbox diagonal
    assert m["chamfer"] <= m["hausdorff_noise_floor"]
    assert m["volume_ratio"] == pytest.approx(1.0)


def test_noise_floor_shrinks_with_more_samples():
    cube = build("clean_cube")
    coarse = compare(cube, cube, seed=0, samples=2_000)
    fine = compare(cube, cube, seed=0, samples=50_000)
    assert fine["hausdorff_noise_floor"] < coarse["hausdorff_noise_floor"]
    assert fine["hausdorff_two_sided"] < coarse["hausdorff_two_sided"]


def test_hausdorff_grows_with_deformation():
    """Controlled deformation: uniform scaling by a known factor."""
    cube = build("clean_cube")
    previous = -1.0
    for scale in (1.01, 1.05, 1.2):
        scaled = cube.copy()
        scaled.apply_scale(scale)
        value = compare(cube, scaled, seed=0, samples=SAMPLES)["hausdorff_two_sided"]
        assert value > previous
        previous = value


def test_metrics_are_deterministic_for_a_seed():
    cube = build("clean_cube")
    sphere = trimesh.creation.icosphere(subdivisions=2, radius=6.0)
    a = compare(cube, sphere, seed=7, samples=SAMPLES)
    b = compare(cube, sphere, seed=7, samples=SAMPLES)
    assert a == b


def test_sampling_does_not_touch_global_rng():
    """Global RNG state must be irrelevant to the result (SPEC 12.1)."""
    cube = build("clean_cube")
    np.random.seed(1234)
    a = compare(cube, cube.copy(), seed=3, samples=5000)
    np.random.seed(9999)
    b = compare(cube, cube.copy(), seed=3, samples=5000)
    assert a == b


def test_directions_differ_when_detail_is_lost():
    """The asymmetry that A8 depends on.

    A box with a deep narrow slot, compared against the same box with the slot
    filled in, is the canonical alpha-wrapping failure: the filled version has
    no material away from the original surface, so ``out->in`` stays small,
    while the slot floor is far from anything in the output and ``in->out``
    reports the full slot depth. Gating on ``out->in`` alone would miss it,
    which is precisely the v1.0 bug (change C1).
    """
    solid = trimesh.creation.box(extents=[10.0, 10.0, 10.0])
    slot = trimesh.creation.box(extents=[1.0, 12.0, 6.0])
    slot.apply_translation([0.0, 0.0, 2.5])  # cuts down from the top face
    slotted = trimesh.boolean.difference([solid, slot])

    m = compare(slotted, solid, seed=0, samples=SAMPLES)
    assert m["hausdorff_in_to_out"] > 2.0          # roughly the slot depth
    assert m["hausdorff_out_to_in"] < 0.6          # nothing sticks out
    assert m["hausdorff_two_sided"] == m["hausdorff_in_to_out"]


def test_surface_samples_include_vertices():
    cube = build("clean_cube")
    points = surface_samples(cube, 100, np.random.default_rng(0))
    assert len(points) == 100 + len(cube.vertices)


def test_wall_thickness_matches_a_known_plate():
    """A 0.2-thick plate must estimate close to 0.2, not to its 10-unit span."""
    plate = build("thin_shell")
    result = wall_thickness(plate, seed=0, n_points=400, n_rays=7)
    assert result["min_wall_approximate"] is True
    assert result["min_wall_estimate"] == pytest.approx(0.2, rel=0.35)


def test_wall_thickness_orders_two_plates_correctly():
    thin = build("thin_shell")
    thick = thin.copy()
    thick.apply_scale([1.0, 1.0, 5.0])  # 0.2 -> 1.0
    a = wall_thickness(thin, seed=0, n_points=400, n_rays=7)["min_wall_estimate"]
    b = wall_thickness(thick, seed=0, n_points=400, n_rays=7)["min_wall_estimate"]
    assert b > a


def test_volume_ratio_is_none_when_the_input_encloses_nothing():
    """An open sheet has no volume, and reporting one is how shells go wrong.

    ``mesh.volume`` is the divergence integral, which returns a number for any
    surface. For the open cube that number is meaningless, and dividing by it
    produced ratios like -214% that then tripped the "hollow result" warning on
    a perfectly good solid.
    """
    open_shell = build("open_cube")
    metrics = compare(open_shell, build("clean_cube"), seed=0)
    assert metrics["volume_ratio"] is None
    assert metrics["candidate_volume"] == pytest.approx(build("clean_cube").volume)

    # A closed, consistently wound pair still gets a real ratio.
    cube = build("clean_cube")
    bigger = cube.copy()
    bigger.apply_scale(2.0)
    assert compare(cube, bigger, seed=0)["volume_ratio"] == pytest.approx(8.0, rel=1e-6)


def test_volume_ratio_is_none_when_windings_disagree():
    metrics = compare(build("flipped_normals"), build("clean_cube"), seed=0)
    assert metrics["volume_ratio"] is None
