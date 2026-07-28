"""Numpy replacements for the two SciPy features meshfix used.

SciPy was a hard dependency for exactly two things: ``ndimage`` morphology plus
labelling in the voxel backend, and ``spatial.cKDTree`` for nearest-neighbour
queries in the metrics. It is 13.4 MB of the ~28 MB Pyodide payload — 48% — so
dropping it roughly halves what a browser has to download to run meshfix
(NOTES.md §8).

SciPy stays a *test* dependency: every function here is checked against the
SciPy implementation it replaces, so the swap is verified rather than assumed.
"""

from __future__ import annotations

import numpy as np

# --------------------------------------------------------------------------
# Binary morphology on a 3D grid (replaces scipy.ndimage)
# --------------------------------------------------------------------------

_AXES = (0, 1, 2)


def _shift_or(target: np.ndarray, source: np.ndarray, axis: int, step: int) -> None:
    """``target |= source shifted by step along axis`` (out-of-range reads as False)."""
    src = [slice(None)] * 3
    dst = [slice(None)] * 3
    n = source.shape[axis]
    if step > 0:
        src[axis] = slice(0, n - step)
        dst[axis] = slice(step, n)
    else:
        src[axis] = slice(-step, n)
        dst[axis] = slice(0, n + step)
    target[tuple(dst)] |= source[tuple(src)]


def binary_dilation(grid: np.ndarray, iterations: int = 1) -> np.ndarray:
    """6-connected dilation, equivalent to ``scipy.ndimage.binary_dilation``."""
    current = grid.copy()
    for _ in range(max(int(iterations), 0)):
        nxt = current.copy()
        for axis in _AXES:
            _shift_or(nxt, current, axis, 1)
            _shift_or(nxt, current, axis, -1)
        current = nxt
    return current


def binary_erosion(grid: np.ndarray, iterations: int = 1) -> np.ndarray:
    """6-connected erosion with the border treated as empty.

    Matches ``scipy.ndimage.binary_erosion(..., border_value=0)``: eroding the
    complement is the same as dilating it and inverting, which keeps this a
    one-liner over the tested dilation rather than a second slicing routine.
    """
    current = grid
    for _ in range(max(int(iterations), 0)):
        outside = ~current
        grown = outside.copy()
        for axis in _AXES:
            _shift_or(grown, outside, axis, 1)
            _shift_or(grown, outside, axis, -1)
        # Cells on the grid face have a missing neighbour, which counts as empty.
        for axis in _AXES:
            index = [slice(None)] * 3
            index[axis] = 0
            grown[tuple(index)] = True
            index[axis] = -1
            grown[tuple(index)] = True
        current = ~grown
    return current


def flood_from_border(passable: np.ndarray, max_sweeps: int = 32) -> np.ndarray:
    """Cells of ``passable`` reachable from the grid border, 6-connected.

    Replaces ``scipy.ndimage.label`` followed by "keep the labels that touch a
    border". Implemented as directional sweeps rather than iterated dilation:
    a single sweep propagates reachability arbitrarily far along its axis, so
    the exterior of an ordinary solid resolves in two or three sweeps, whereas
    dilation would need one iteration per voxel of travel.
    """
    reached = np.zeros_like(passable)
    for axis in _AXES:  # seed every border face
        index = [slice(None)] * 3
        index[axis] = 0
        reached[tuple(index)] |= passable[tuple(index)]
        index[axis] = -1
        reached[tuple(index)] |= passable[tuple(index)]

    for _ in range(max_sweeps):
        before = int(reached.sum())
        for axis in _AXES:
            n = reached.shape[axis]
            for step in (1, -1):
                order = range(1, n) if step > 0 else range(n - 2, -1, -1)
                prev = -step
                for i in order:
                    cur = [slice(None)] * 3
                    src = [slice(None)] * 3
                    cur[axis] = i
                    src[axis] = i + prev
                    reached[tuple(cur)] |= passable[tuple(cur)] & reached[tuple(src)]
        if int(reached.sum()) == before:
            break
    return reached


# --------------------------------------------------------------------------
# Nearest-neighbour queries (replaces scipy.spatial.cKDTree)
# --------------------------------------------------------------------------

_NEIGHBOUR_OFFSETS = np.array(
    [(i, j, k) for i in (-1, 0, 1) for j in (-1, 0, 1) for k in (-1, 0, 1)], dtype=np.int64
)


class NearestPoints:
    """Exact nearest-neighbour distances via a uniform spatial hash.

    Replaces ``scipy.spatial.cKDTree.query(..., k=1)`` and is checked against it
    in ``tests/test_nputil.py``.

    Two details make it robust on the data meshfix actually feeds it:

    * **Cell size respects effective dimensionality.** Surface samples form a
      2D sheet embedded in 3D, so sizing cells from the bounding-box *volume*
      collapses towards zero and the shell search explodes. Only the extents
      that carry real variation are used, and the cell is the d-th root over
      those.
    * **Shell search is capped, with a brute-force tail.** Offsets grow
      cubically with radius, so the few queries still unresolved after a
      handful of shells (isolated points in sparse regions) are finished by
      direct comparison. The answer stays exact — which matters, because these
      distances decide criterion A8 — without an unbounded search.
    """

    #: Past this radius the shell offsets cost more than brute force.
    MAX_SHELL_RADIUS = 3

    def __init__(self, points: np.ndarray, cell: float | None = None) -> None:
        self.points = np.ascontiguousarray(points, dtype=np.float64)
        n = max(len(self.points), 1)
        self.cell = float(cell if cell is not None else _characteristic_spacing(self.points, n))
        self.origin = self.points.min(axis=0) if len(self.points) else np.zeros(3)

        packed = self._pack(self._cell_of(self.points))
        order = np.argsort(packed, kind="stable")
        self._sorted_keys = packed[order]
        self._sorted_points = self.points[order]

    def _cell_of(self, points: np.ndarray) -> np.ndarray:
        return np.floor((points - self.origin) / self.cell).astype(np.int64)

    @staticmethod
    def _pack(cells: np.ndarray) -> np.ndarray:
        # A hash, not an ordering: searchsorted only needs equal keys adjacent.
        # Collisions cost a few extra distance checks and can never produce a
        # wrong answer, because every candidate is measured anyway.
        return (
            cells[:, 0] * np.int64(73856093)
            ^ cells[:, 1] * np.int64(19349663)
            ^ cells[:, 2] * np.int64(83492791)
        )

    def query(self, queries: np.ndarray) -> np.ndarray:
        """Distance from every query point to the closest reference point."""
        queries = np.ascontiguousarray(queries, dtype=np.float64)
        best = np.full(len(queries), np.inf)
        if len(self.points) == 0 or len(queries) == 0:
            return best

        base = self._cell_of(queries)
        pending = np.arange(len(queries))
        for radius in range(1, self.MAX_SHELL_RADIUS + 1):
            for offset in _shell_offsets(radius):
                self._probe(queries, base, pending, offset, best)
            # Having searched Chebyshev radius R, any unsearched cell starts at
            # least (R+1) cells from this cell's origin while the query sits
            # under one cell inside it, so nothing unsearched is nearer than
            # R*cell.
            pending = pending[best[pending] > radius * self.cell]
            if not len(pending):
                return best

        self._brute_force(queries, pending, best)
        return best

    def _probe(self, queries, base, pending, offset, best) -> None:
        packed = self._pack(base[pending] + offset)
        lo = np.searchsorted(self._sorted_keys, packed, side="left")
        hi = np.searchsorted(self._sorted_keys, packed, side="right")
        counts = hi - lo
        if not counts.any():
            return
        for column in range(int(counts.max())):
            active = counts > column
            if not active.any():
                break
            targets = pending[active]
            delta = self._sorted_points[lo[active] + column] - queries[targets]
            np.minimum.at(best, targets, np.sqrt(np.einsum("ij,ij->i", delta, delta)))

    def _brute_force(self, queries, pending, best, chunk: int = 256) -> None:
        """Exact tail for the queries the shells could not settle."""
        for start in range(0, len(pending), chunk):
            targets = pending[start : start + chunk]
            delta = self._sorted_points[None, :, :] - queries[targets][:, None, :]
            dist = np.sqrt(np.einsum("ijk,ijk->ij", delta, delta))
            best[targets] = np.minimum(best[targets], dist.min(axis=1))


def _characteristic_spacing(points: np.ndarray, n: int) -> float:
    """Cell size aiming at a couple of points per occupied cell.

    Only the extents carrying real variation count. A flat sheet has three
    extents but two dimensions, and the cube root of its near-zero volume would
    give a cell far below the actual point spacing.
    """
    span = np.sort(points.max(axis=0) - points.min(axis=0))[::-1]
    largest = float(span[0])
    if largest <= 0:
        return 1.0
    significant = span[span > largest * 1e-6]
    measure = float(np.prod(significant))
    return max((measure / n) ** (1.0 / len(significant)) * 1.5, largest * 1e-9)


def _shell_offsets(radius: int) -> np.ndarray:
    """Cell offsets exactly ``radius`` cells away in Chebyshev distance."""
    if radius == 1:
        return _NEIGHBOUR_OFFSETS
    span = np.arange(-radius, radius + 1)
    grid = np.stack(np.meshgrid(span, span, span, indexing="ij"), axis=-1).reshape(-1, 3)
    return grid[np.abs(grid).max(axis=1) == radius]


# --------------------------------------------------------------------------
# Connected components (replaces trimesh's scipy/networkx "graph engine")
# --------------------------------------------------------------------------

def connected_component_labels(edges: np.ndarray, n_nodes: int) -> np.ndarray:
    """Component label per node, from an undirected edge list.

    ``trimesh.graph.connected_components`` refuses to run unless SciPy or
    NetworkX is importable ("no graph engines available!"), which would drag
    SciPy back in through the side door and undo the payload saving. This is
    hooking plus pointer jumping: each round propagates the smallest label
    across every edge and then flattens the forest, so it converges in about
    log(n) fully vectorised rounds instead of a Python union-find loop.
    """
    labels = np.arange(n_nodes, dtype=np.int64)
    if len(edges) == 0:
        return labels
    a, b = edges[:, 0], edges[:, 1]
    for _ in range(64):
        previous = labels.copy()
        np.minimum.at(labels, a, labels[b])
        np.minimum.at(labels, b, labels[a])
        labels = labels[labels]          # pointer jumping flattens the trees
        if np.array_equal(labels, previous):
            break
    return labels


def count_connected_components(edges: np.ndarray, n_nodes: int) -> int:
    """Number of connected components, isolated nodes included."""
    if n_nodes == 0:
        return 0
    return int(len(np.unique(connected_component_labels(edges, n_nodes))))
