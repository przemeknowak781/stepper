"""Verify the numpy replacements against the SciPy functions they replace.

SciPy remains a test-only dependency precisely so this comparison exists: the
swap that halves the Pyodide payload is checked, not assumed (NOTES.md §8).
"""

from __future__ import annotations

import numpy as np
import pytest

from meshfix.nputil import NearestPoints, binary_dilation, binary_erosion, flood_from_border

ndimage = pytest.importorskip("scipy.ndimage")
spatial = pytest.importorskip("scipy.spatial")


def _random_grid(seed: int, shape=(18, 15, 13), fill=0.35) -> np.ndarray:
    return np.random.default_rng(seed).random(shape) < fill


@pytest.mark.parametrize("iterations", [1, 2, 3])
def test_dilation_matches_scipy(iterations):
    for seed in range(4):
        grid = _random_grid(seed)
        assert np.array_equal(
            binary_dilation(grid, iterations),
            ndimage.binary_dilation(grid, iterations=iterations),
        )


@pytest.mark.parametrize("iterations", [1, 2])
def test_erosion_matches_scipy(iterations):
    for seed in range(4):
        grid = _random_grid(seed, fill=0.7)
        assert np.array_equal(
            binary_erosion(grid, iterations),
            ndimage.binary_erosion(grid, iterations=iterations, border_value=0),
        )


def test_flood_matches_scipy_label_plus_border_selection():
    """The exact composite operation the voxel backend used to perform."""
    for seed in range(6):
        passable = _random_grid(seed, fill=0.6)
        labels, count = ndimage.label(passable)
        expected = np.zeros(labels.shape, dtype=bool)
        if count:
            border = np.unique(np.concatenate([
                labels[0, :, :].ravel(), labels[-1, :, :].ravel(),
                labels[:, 0, :].ravel(), labels[:, -1, :].ravel(),
                labels[:, :, 0].ravel(), labels[:, :, -1].ravel(),
            ]))
            border = border[border != 0]
            expected = np.isin(labels, border)
        assert np.array_equal(flood_from_border(passable), expected)


def test_flood_does_not_leak_into_a_sealed_cavity():
    grid = np.zeros((12, 12, 12), dtype=bool)
    grid[2:10, 2:10, 2:10] = True          # a hollow box of passable cells...
    grid[3:9, 3:9, 3:9] = True
    shell = np.ones((12, 12, 12), dtype=bool)
    shell[4:8, 4:8, 4:8] = False           # ...with a fully enclosed void
    reached = flood_from_border(shell)
    assert reached[0, 0, 0]
    assert not reached[6, 6, 6].any() if hasattr(reached[6, 6, 6], "any") else not reached[6, 6, 6]


@pytest.mark.parametrize("seed", range(5))
def test_nearest_points_matches_ckdtree_exactly(seed):
    rng = np.random.default_rng(seed)
    reference = rng.normal(0, 10, size=(2000, 3))
    queries = rng.normal(0, 12, size=(1500, 3))
    expected, _ = spatial.cKDTree(reference).query(queries, k=1)
    assert np.allclose(NearestPoints(reference).query(queries), expected, rtol=0, atol=1e-9)


def test_nearest_points_handles_clustered_and_isolated_points():
    """Sparse regions are where a fixed-radius hash would silently be wrong."""
    rng = np.random.default_rng(0)
    cluster = rng.normal(0, 0.05, size=(500, 3))
    far = np.array([[100.0, 100.0, 100.0], [-250.0, 30.0, 7.0]])
    reference = np.vstack([cluster, far])
    queries = np.vstack([rng.normal(0, 0.05, size=(50, 3)), far + 3.0, [[50.0, 0.0, 0.0]]])
    expected, _ = spatial.cKDTree(reference).query(queries, k=1)
    assert np.allclose(NearestPoints(reference).query(queries), expected, rtol=0, atol=1e-9)


def test_connected_components_matches_trimesh():
    """The count trimesh refuses to produce without a SciPy/NetworkX engine."""
    import trimesh as tm

    from meshfix.nputil import count_connected_components

    for name, expected in [("clean_cube", 1), ("two_components", 2), ("selfintersect_torus", 2)]:
        from tests.fixtures.generate import build

        mesh = build(name)
        adjacency = np.asarray(mesh.face_adjacency)
        groups = tm.graph.connected_components(
            adjacency, nodes=np.arange(len(mesh.faces)), min_len=1
        )
        ours = count_connected_components(adjacency, len(mesh.faces))
        assert ours == len(groups) == expected, name


def test_connected_components_on_a_synthetic_graph():
    from meshfix.nputil import connected_component_labels, count_connected_components

    # 0-1-2 chain, 3-4 pair, 5 isolated -> three components.
    edges = np.array([[0, 1], [1, 2], [3, 4]], dtype=np.int64)
    assert count_connected_components(edges, 6) == 3
    labels = connected_component_labels(edges, 6)
    assert labels[0] == labels[1] == labels[2]
    assert labels[3] == labels[4]
    assert len({int(labels[0]), int(labels[3]), int(labels[5])}) == 3


def test_components_long_chain_converges():
    """Pointer jumping must flatten a long chain, not stop early."""
    from meshfix.nputil import count_connected_components

    n = 5000
    edges = np.stack([np.arange(n - 1), np.arange(1, n)], axis=1).astype(np.int64)
    assert count_connected_components(edges, n) == 1
