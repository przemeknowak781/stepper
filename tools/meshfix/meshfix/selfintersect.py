"""Self-intersection detection (SPEC 5.2, 13.1).

Note the concept being tested: two faces that pass *through* each other. It is
unrelated to non-manifold edges and to ``trimesh.repair.broken_faces``, which
tests winding consistency (SPEC 15). Pairs sharing a vertex are excluded — two
adjacent triangles always meet along their shared edge, and that is not a
defect.

Structure: a uniform spatial hash finds candidate pairs, four vectorised
rejection stages discard almost all of them, and Möller's triangle-triangle
test runs only on what survives.

The rejection stages exist because the Python-level narrow phase was the whole
cost. Measured on ``ai_like_blob`` upscaled to ~100k faces, they discard over
99.9% of candidates, which is what brings the routine inside the 30 s budget
that SPEC 13.1 sets for 500k faces — and it matters twice over under Pyodide,
where Python-level loops run roughly twice as slow again (NOTES.md §8).
"""

from __future__ import annotations

import numpy as np

#: Faces whose bounding box spans more cells than this are bucketed by their
#: centre only. Without the cap one huge triangle would be inserted into
#: thousands of cells and dominate the broad phase.
MAX_CELLS_PER_FACE = 64

#: Multiplier used to pack a face-index pair into a single int64. Comfortably
#: above any realistic face count while keeping the product inside int64.
PAIR_STRIDE = np.int64(1) << 26


def self_intersecting_faces(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Indices of faces that intersect a non-adjacent face."""
    if len(faces) < 2:
        return np.empty(0, dtype=np.int64)

    tri = vertices[faces]                      # (F, 3, 3)
    lo, hi = tri.min(axis=1), tri.max(axis=1)

    pairs = _candidate_pairs(lo, hi)
    if len(pairs) == 0:
        return np.empty(0, dtype=np.int64)

    pairs = _reject(pairs, faces, tri, lo, hi)
    if len(pairs) == 0:
        return np.empty(0, dtype=np.int64)

    hits: set[int] = set()
    for a, b in pairs:
        if _tri_tri_intersect(tri[a], tri[b]):
            hits.add(int(a))
            hits.add(int(b))
    return np.array(sorted(hits), dtype=np.int64)


# --------------------------------------------------------------------------
# Broad phase
# --------------------------------------------------------------------------

def _candidate_pairs(lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
    """Face pairs sharing at least one spatial-hash cell, as an (n, 2) array."""
    n = len(lo)
    cell = float(np.median(hi - lo)) * 2.0
    if not np.isfinite(cell) or cell <= 0:
        extent = float(np.max(hi.max(axis=0) - lo.min(axis=0)))
        cell = (extent / 64.0) if extent > 0 else 1.0

    origin = lo.min(axis=0)
    cell_lo = np.floor((lo - origin) / cell).astype(np.int64)
    cell_hi = np.floor((hi - origin) / cell).astype(np.int64)
    span = cell_hi - cell_lo + 1
    counts = span.prod(axis=1)

    # Oversized faces collapse to a single cell so the insert count stays linear.
    oversized = counts > MAX_CELLS_PER_FACE
    if oversized.any():
        cell_lo[oversized] = (cell_lo[oversized] + cell_hi[oversized]) // 2
        span[oversized] = 1
        counts = span.prod(axis=1)

    total = int(counts.sum())
    if total == 0:
        return np.empty((0, 2), dtype=np.int64)

    face_of = np.repeat(np.arange(n, dtype=np.int64), counts)
    starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
    local = np.arange(total, dtype=np.int64) - np.repeat(starts, counts)

    span_of = span[face_of]
    di = local % span_of[:, 0]
    rest = local // span_of[:, 0]
    dj = rest % span_of[:, 1]
    dk = rest // span_of[:, 1]
    cells = cell_lo[face_of] + np.stack([di, dj, dk], axis=1)

    keys = (
        cells[:, 0] * np.int64(73856093)
        ^ cells[:, 1] * np.int64(19349663)
        ^ cells[:, 2] * np.int64(83492791)
    )
    order = np.argsort(keys, kind="stable")
    keys, face_of = keys[order], face_of[order]

    # Runs of equal keys, read straight off the sorted array. Calling
    # np.unique here would sort a second time for no reason.
    boundaries = np.flatnonzero(np.diff(keys)) + 1
    run_starts = np.concatenate([[0], boundaries])
    run_lengths = np.diff(np.concatenate([run_starts, [len(keys)]]))
    if len(run_lengths) == 0 or run_lengths.max() < 2:
        return np.empty((0, 2), dtype=np.int64)

    # Pair every bucket member with every later member, one vectorised pass per
    # separation k rather than a Python loop per bucket.
    position = np.arange(len(keys), dtype=np.int64) - np.repeat(run_starts, run_lengths)
    length_of = np.repeat(run_lengths, run_lengths)

    chunks = []
    for k in range(1, int(run_lengths.max())):
        usable = position + k < length_of
        if not usable.any():
            break
        idx = np.flatnonzero(usable)
        first, second = face_of[idx], face_of[idx + k]
        lower = np.minimum(first, second)
        upper = np.maximum(first, second)
        # Pack each pair into one integer: deduplicating a 1-D array is far
        # cheaper than the lexicographic row sort np.unique(axis=0) performs,
        # and pair counts run into the millions on dense meshes.
        chunks.append(lower * PAIR_STRIDE + upper)
    if not chunks:
        return np.empty((0, 2), dtype=np.int64)

    packed = np.unique(np.concatenate(chunks))
    return np.stack([packed // PAIR_STRIDE, packed % PAIR_STRIDE], axis=1)


# --------------------------------------------------------------------------
# Vectorised rejection
# --------------------------------------------------------------------------

def _reject(
    pairs: np.ndarray, faces: np.ndarray, tri: np.ndarray, lo: np.ndarray, hi: np.ndarray
) -> np.ndarray:
    """Drop pairs that provably cannot intersect, without any Python loop."""
    a, b = pairs[:, 0], pairs[:, 1]

    # 1. Adjacency: any shared vertex means they legitimately touch.
    fa, fb = faces[a], faces[b]
    shared = np.zeros(len(pairs), dtype=bool)
    for i in range(3):
        for j in range(3):
            shared |= fa[:, i] == fb[:, j]
    keep = ~shared

    # 2. Bounding boxes must overlap on all three axes.
    keep &= np.all(lo[a] <= hi[b], axis=1) & np.all(lo[b] <= hi[a], axis=1)
    if not keep.any():
        return np.empty((0, 2), dtype=np.int64)
    pairs = pairs[keep]
    a, b = pairs[:, 0], pairs[:, 1]

    # 3./4. Each triangle must straddle the other's plane.
    keep = _straddles(tri[a], tri[b]) & _straddles(tri[b], tri[a])
    return pairs[keep]


def _straddles(subject: np.ndarray, reference: np.ndarray, eps: float = 1e-12) -> np.ndarray:
    """Whether each subject triangle reaches both sides of the reference plane."""
    normal = np.cross(reference[:, 1] - reference[:, 0], reference[:, 2] - reference[:, 0])
    offset = -np.einsum("ij,ij->i", normal, reference[:, 0])
    distance = np.einsum("ijk,ik->ij", subject, normal) + offset[:, None]
    return ~(np.all(distance > eps, axis=1) | np.all(distance < -eps, axis=1))


# --------------------------------------------------------------------------
# Narrow phase (Möller)
# --------------------------------------------------------------------------

def _tri_tri_intersect(t1: np.ndarray, t2: np.ndarray, eps: float = 1e-12) -> bool:
    """Möller's triangle-triangle overlap test, including the coplanar case."""
    n2 = np.cross(t2[1] - t2[0], t2[2] - t2[0])
    d2 = -float(n2 @ t2[0])
    dist1 = t1 @ n2 + d2
    if np.all(dist1 > eps) or np.all(dist1 < -eps):
        return False

    n1 = np.cross(t1[1] - t1[0], t1[2] - t1[0])
    d1 = -float(n1 @ t1[0])
    dist2 = t2 @ n1 + d1
    if np.all(dist2 > eps) or np.all(dist2 < -eps):
        return False

    direction = np.cross(n1, n2)
    if float(direction @ direction) < eps:
        return _coplanar_overlap(t1, t2, n1)

    axis = int(np.argmax(np.abs(direction)))
    i1 = _plane_interval(t1[:, axis], dist1)
    i2 = _plane_interval(t2[:, axis], dist2)
    if i1 is None or i2 is None:
        return False
    return i1[0] <= i2[1] and i2[0] <= i1[1]


def _plane_interval(proj: np.ndarray, dist: np.ndarray, eps: float = 1e-12):
    """Where a triangle crosses the other's plane, projected on one axis.

    Collecting every edge crossing and every on-plane vertex handles the
    touching and straddling cases uniformly, without the sign bookkeeping the
    classic formulation needs.
    """
    points: list[float] = []
    for i in range(3):
        j = (i + 1) % 3
        di, dj = float(dist[i]), float(dist[j])
        if abs(di) <= eps:
            points.append(float(proj[i]))
        if di * dj < 0:
            t = di / (di - dj)
            points.append(float(proj[i] + t * (proj[j] - proj[i])))
    if not points:
        return None
    return min(points), max(points)


def _coplanar_overlap(t1: np.ndarray, t2: np.ndarray, normal: np.ndarray) -> bool:
    """2D overlap of two coplanar triangles, by the separating axis theorem."""
    drop = int(np.argmax(np.abs(normal)))
    keep = [i for i in range(3) if i != drop]
    a, b = t1[:, keep], t2[:, keep]
    for poly, other in ((a, b), (b, a)):
        for i in range(3):
            edge = poly[(i + 1) % 3] - poly[i]
            axis = np.array([-edge[1], edge[0]])
            pa, pb = poly @ axis, other @ axis
            if pa.max() < pb.min() or pb.max() < pa.min():
                return False
    return True
