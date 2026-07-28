"""Fidelity and thickness metrics (SPEC 7.5, 9, milestone M2).

Everything here is an **estimator** based on surface sampling, and every
estimator says so in the report (``*_approximate: true``). Sampling is driven
by an explicit ``numpy.random.Generator`` seeded from ``--seed``; no function
in this module touches global RNG state (SPEC 12.1).

The Hausdorff distance is reported in **both directions** because they detect
different failures, and gating on only one was the central defect of spec
version 1.0 (change C1):

* ``out->in`` — output material far from any input surface: inflation, or a
  bridge thrown across a wide gap.
* ``in->out`` — input surface far from any output: **lost detail**, such as a
  slot the wrap filled in or a feature a voxel remesh shrank away.

For alpha wrapping ``out->in`` stays near the offset by construction, so it
cannot see lost detail; ``in->out`` grows with the depth of whatever was
swallowed. A8 therefore gates on the maximum of the two.
"""

from __future__ import annotations

import numpy as np
import trimesh
from scipy.spatial import cKDTree

DEFAULT_SAMPLES = 50_000


def surface_samples(mesh: trimesh.Trimesh, count: int, rng: np.random.Generator) -> np.ndarray:
    """Area-weighted uniform sample of a mesh surface, plus its vertices.

    Vertices are included because pure area sampling systematically misses
    corners and thin spikes, which is exactly where fidelity loss shows up.
    """
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    if len(faces) == 0:
        return vertices

    a, b, c = vertices[faces[:, 0]], vertices[faces[:, 1]], vertices[faces[:, 2]]
    areas = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    total = areas.sum()
    if total <= 0:
        return vertices

    count = max(int(count), 1)
    picked = rng.choice(len(faces), size=count, p=areas / total)
    # Uniform barycentric coordinates via the standard sqrt transform.
    u = rng.random(count)
    v = rng.random(count)
    root_u = np.sqrt(u)
    w0 = 1.0 - root_u
    w1 = root_u * (1.0 - v)
    w2 = root_u * v
    points = w0[:, None] * a[picked] + w1[:, None] * b[picked] + w2[:, None] * c[picked]
    return np.vstack([points, vertices])


def directed_hausdorff(source: np.ndarray, target_tree: cKDTree) -> float:
    """Largest distance from any source point to the nearest target point."""
    if len(source) == 0:
        return 0.0
    distances, _ = target_tree.query(source, k=1, workers=-1)
    return float(np.max(distances))


def mean_distance(source: np.ndarray, target_tree: cKDTree) -> float:
    if len(source) == 0:
        return 0.0
    distances, _ = target_tree.query(source, k=1, workers=-1)
    return float(np.mean(distances))


def compare(
    reference: trimesh.Trimesh,
    candidate: trimesh.Trimesh,
    *,
    seed: int = 0,
    samples: int = DEFAULT_SAMPLES,
) -> dict:
    """Fidelity metrics between an input (``reference``) and an output.

    ``in->out`` is measured from the reference, ``out->in`` from the candidate.
    """
    rng_in = np.random.default_rng(seed)
    rng_out = np.random.default_rng(seed + 1)
    ref_points = surface_samples(reference, samples, rng_in)
    cand_points = surface_samples(candidate, samples, rng_out)

    ref_tree = cKDTree(ref_points)
    cand_tree = cKDTree(cand_points)

    in_to_out = directed_hausdorff(ref_points, cand_tree)
    out_to_in = directed_hausdorff(cand_points, ref_tree)
    chamfer = 0.5 * (mean_distance(ref_points, cand_tree) + mean_distance(cand_points, ref_tree))

    ref_volume = _safe_volume(reference)
    cand_volume = _safe_volume(candidate)

    return {
        "hausdorff_in_to_out": in_to_out,
        "hausdorff_out_to_in": out_to_in,
        "hausdorff_two_sided": max(in_to_out, out_to_in),
        "hausdorff_approximate": True,
        "hausdorff_noise_floor": noise_floor(reference, len(ref_points)),
        "chamfer": chamfer,
        "volume_ratio": (
            float(cand_volume / ref_volume)
            if ref_volume not in (None, 0.0) and cand_volume is not None
            else None
        ),
        "face_count_ratio": (
            float(len(candidate.faces) / len(reference.faces)) if len(reference.faces) else None
        ),
        "samples_per_mesh": int(len(ref_points)),
    }


def noise_floor(mesh: trimesh.Trimesh, n_samples: int) -> float:
    """Resolution limit of the sampled Hausdorff estimate.

    Two independently drawn point sets on the *same* surface still sit roughly
    one inter-sample spacing apart, so the estimate never reaches zero: its
    floor is about ``sqrt(area / n_samples)``. Comparing two identical cubes of
    edge 10 with 20k samples, for instance, yields ~0.17, not 0.

    This matters for A8. The default threshold of 0.5% of the bounding-box
    diagonal is 0.087 for that cube — *below* the floor — so at that sampling
    density the criterion would fail on a perfect copy. The report carries this
    number so the threshold can be read against the resolution that produced
    it, and `cli` warns when the threshold sits under the floor.
    """
    if n_samples <= 0:
        return 0.0
    area = float(np.asarray(mesh.area))
    if area <= 0:
        return 0.0
    return float(np.sqrt(area / n_samples))


def _safe_volume(mesh: trimesh.Trimesh) -> float | None:
    with np.errstate(invalid="ignore", divide="ignore"):
        try:
            return float(mesh.volume)
        except Exception:  # noqa: BLE001 - a soup has no meaningful volume
            return None


# --------------------------------------------------------------------------
# Wall thickness (SPEC 7.5, change C5)
# --------------------------------------------------------------------------

def wall_thickness(
    mesh: trimesh.Trimesh,
    *,
    seed: int = 0,
    n_points: int | None = None,
    n_rays: int = 13,
    cone_half_angle_deg: float = 15.0,
) -> dict:
    """Estimate minimum wall thickness by the Shape Diameter Function.

    A single ray along the inward normal measures the hypotenuse rather than
    the height wherever a wall is tapered or skewed, and so systematically
    **over**-estimates thickness — the exact direction of error you cannot
    afford for a print-safety check. Casting a small cone and taking a
    cosine-weighted median is the standard fix (Shapira et al. 2008) and costs
    the same order of time.

    Defaults are lower than SPEC 7.5 (``K = min(20000, 5*n_faces)``, 30 rays):
    without a compiled ray backend such as ``embreex`` that is roughly 600k
    pure-numpy ray casts. Both counts are parameters, so a deployment with
    ``embreex`` installed can raise them; see NOTES.md.

    Returns ``p01`` of the thickness distribution as ``min_wall_estimate``.
    This is an estimator, never a proof, and is reported as such.
    """
    faces = np.asarray(mesh.faces, dtype=np.int64)
    if len(faces) == 0:
        return {"min_wall_estimate": None, "min_wall_approximate": True, "samples": 0}

    if n_points is None:
        n_points = min(2000, max(1, 5 * len(faces)))

    rng = np.random.default_rng(seed)
    origins, normals = _sample_with_normals(mesh, n_points, rng)
    directions, weights = _cone_directions(normals, n_rays, cone_half_angle_deg, rng)

    n_samples = len(origins)
    ray_origins = np.repeat(origins, n_rays, axis=0)
    # Step just off the surface so the ray does not immediately hit its own face.
    epsilon = float(np.linalg.norm(mesh.bounds[1] - mesh.bounds[0])) * 1e-7
    ray_origins = ray_origins + directions * epsilon

    locations, index_ray, _ = mesh.ray.intersects_location(
        ray_origins=ray_origins, ray_directions=directions, multiple_hits=False
    )
    if len(index_ray) == 0:
        return {"min_wall_estimate": None, "min_wall_approximate": True, "samples": n_samples}

    hit_distance = np.linalg.norm(locations - ray_origins[index_ray], axis=1)

    thickness: list[float] = []
    flat_weights = weights.ravel()
    for i in range(n_samples):
        lo, hi = i * n_rays, (i + 1) * n_rays
        mask = (index_ray >= lo) & (index_ray < hi)
        if not mask.any():
            continue
        d = hit_distance[mask]
        w = flat_weights[index_ray[mask]]
        thickness.append(_weighted_median(d, w))

    if not thickness:
        return {"min_wall_estimate": None, "min_wall_approximate": True, "samples": n_samples}

    values = np.asarray(thickness)
    return {
        "min_wall_estimate": float(np.percentile(values, 1, method="linear")),
        "min_wall_median": float(np.median(values)),
        "min_wall_approximate": True,
        "samples": int(len(values)),
    }


def _sample_with_normals(mesh: trimesh.Trimesh, count: int, rng: np.random.Generator):
    """Sample face centroids (area-weighted) together with inward normals."""
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    a, b, c = vertices[faces[:, 0]], vertices[faces[:, 1]], vertices[faces[:, 2]]
    areas = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    total = areas.sum()
    probabilities = areas / total if total > 0 else np.full(len(faces), 1.0 / len(faces))

    count = min(count, len(faces)) if len(faces) < count else count
    picked = rng.choice(len(faces), size=count, p=probabilities)
    centroids = (a[picked] + b[picked] + c[picked]) / 3.0
    normals = np.asarray(mesh.face_normals, dtype=np.float64)[picked]
    return centroids, -normals  # inward


def _cone_directions(
    axes: np.ndarray, n_rays: int, half_angle_deg: float, rng: np.random.Generator
):
    """Deterministic ray fan around each axis, with cosine weights."""
    half_angle = np.radians(half_angle_deg)
    # A fixed spiral rather than random directions: same seed, same rays, and
    # even coverage without clustering.
    k = np.arange(n_rays)
    theta = half_angle * np.sqrt(k / max(n_rays - 1, 1))
    phi = k * np.pi * (3.0 - np.sqrt(5.0))  # golden angle

    local = np.stack(
        [np.sin(theta) * np.cos(phi), np.sin(theta) * np.sin(phi), np.cos(theta)], axis=1
    )
    weights = np.cos(theta)

    directions = np.empty((len(axes) * n_rays, 3), dtype=np.float64)
    for i, axis in enumerate(axes):
        basis = _orthonormal_basis(axis)
        directions[i * n_rays : (i + 1) * n_rays] = local @ basis
    return directions, np.tile(weights, (len(axes), 1))


def _orthonormal_basis(axis: np.ndarray) -> np.ndarray:
    """Rows (u, v, axis) forming a right-handed frame around ``axis``."""
    axis = axis / (np.linalg.norm(axis) or 1.0)
    reference = np.array([1.0, 0.0, 0.0]) if abs(axis[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    u = np.cross(reference, axis)
    u /= np.linalg.norm(u) or 1.0
    v = np.cross(axis, u)
    return np.stack([u, v, axis])


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    order = np.argsort(values)
    values, weights = values[order], weights[order]
    cumulative = np.cumsum(weights)
    if cumulative[-1] <= 0:
        return float(np.median(values))
    return float(values[np.searchsorted(cumulative, 0.5 * cumulative[-1])])
