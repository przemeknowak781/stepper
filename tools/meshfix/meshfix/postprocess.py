"""Post-processing: shell thickening, welding, degenerate removal (SPEC 7.6, 8)."""

from __future__ import annotations

import numpy as np
import trimesh

from .io import float32_ulp


def weld_tolerance(diagonal: float) -> float:
    """Weld tolerance, floored at the storage precision (SPEC 8.1, change C9).

    ``diagonal * 1e-8`` alone sits below the float32 spacing for any model of
    ordinary size, so after a round trip through STL it would silently merge
    nothing.
    """
    return max(diagonal * 1e-8, float32_ulp(diagonal))


def thicken_shell(mesh: trimesh.Trimesh, thickness: float) -> trimesh.Trimesh:
    """Give an open shell a wall, so a backend has a solid to work with.

    Offsets the surface by ``±thickness/2`` along smoothed vertex normals and
    stitches the two sheets together with a quad band along every boundary
    edge. The result is closed but not guaranteed clean — that is the
    backend's job. What matters here is that the thickness is a number the
    *user supplied*, never one inferred from a backend's regularisation
    parameter (SPEC 5.3).
    """
    if thickness <= 0:
        raise ValueError("--shell-thickness must be positive")

    work = mesh.copy()
    # Consistent orientation first: the offset direction is meaningless if
    # neighbouring faces disagree about which side is "out".
    trimesh.repair.fix_normals(work)

    vertices = np.asarray(work.vertices, dtype=np.float64)
    faces = np.asarray(work.faces, dtype=np.int64)
    # trimesh caches vertex_normals as a read-only view; copy before scaling.
    normals = np.array(work.vertex_normals, dtype=np.float64, copy=True)
    lengths = np.linalg.norm(normals, axis=1)
    safe = lengths > 0
    normals[safe] /= lengths[safe, None]

    half = thickness / 2.0
    top = vertices + normals * half
    bottom = vertices - normals * half
    n = len(vertices)

    combined_vertices = np.vstack([top, bottom])
    combined_faces = [faces, faces[:, ::-1] + n]

    # Close the rim: every edge used by exactly one face is a boundary edge.
    edges = np.sort(faces[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2), axis=1)
    unique, counts = np.unique(edges, axis=0, return_counts=True)
    boundary = unique[counts == 1]
    if len(boundary):
        a, b = boundary[:, 0], boundary[:, 1]
        combined_faces.append(np.stack([a, b, b + n], axis=1))
        combined_faces.append(np.stack([a, b + n, a + n], axis=1))

    return trimesh.Trimesh(
        vertices=combined_vertices,
        faces=np.vstack(combined_faces),
        process=False,
    )
