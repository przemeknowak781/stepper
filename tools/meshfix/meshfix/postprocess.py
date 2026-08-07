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
    parameter (SPEC 5.3) — which is why the offset is mitred: moving a vertex
    ``t/2`` along an *averaged* normal leaves the wall only ``t/2 * cos`` thick
    measured perpendicular to each face it belongs to, so a folded shell comes
    out under the requested wall exactly where it is most likely to matter.
    """
    if thickness <= 0:
        raise ValueError("--shell-thickness must be positive")

    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    # Consistent orientation first: the offset direction is meaningless if
    # neighbouring faces disagree about which side is "out". Both this and the
    # vertex normals below are computed here rather than through trimesh,
    # because `repair.fix_normals` and the `vertex_normals` property both go via
    # its graph/sparse layer, which demands NetworkX or SciPy — the two
    # dependencies meshfix dropped for Pyodide (NOTES.md §8).
    faces = orient_consistently(vertices, np.asarray(mesh.faces, dtype=np.int64))
    normals = vertex_normals(vertices, faces)

    half = thickness / 2.0 * _miter(vertices, faces, normals)[:, None]
    top = vertices + normals * half
    bottom = vertices - normals * half
    n = len(vertices)

    combined_vertices = np.vstack([top, bottom])
    combined_faces = [faces, faces[:, ::-1] + n]

    # Close the rim: every edge used by exactly one face is a boundary edge.
    # The edge must be kept in its owning face's *direction* — sorting it to
    # count occurrences throws that away, and a band built from sorted pairs is
    # wound at random. It also has to run against that direction, since the band
    # hangs off the top shell: `a -> b` counter-clockwise seen from above makes
    # `a -> b+n -> b` the winding whose normal points out of the wall.
    directed = faces[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2)
    _, inverse, counts = np.unique(
        np.sort(directed, axis=1), axis=0, return_inverse=True, return_counts=True
    )
    boundary = directed[counts[inverse.ravel()] == 1]
    if len(boundary):
        a, b = boundary[:, 0], boundary[:, 1]
        combined_faces.append(np.stack([a, b + n, b], axis=1))
        combined_faces.append(np.stack([a, a + n, b + n], axis=1))

    return trimesh.Trimesh(
        vertices=combined_vertices,
        faces=np.vstack(combined_faces),
        process=False,
    )


#: Cap on the mitre extension, set just above a cube corner's ``sqrt(3)``.
#:
#: The factor diverges where the surface folds back on itself, and on a mesh
#: that needs repairing those vertices are common: on the model this was tuned
#: against, 11.5% of vertices sat at a cap of 4, each one firing a spike four
#: times the wall thickness out of the model. That tripled the Hausdorff
#: deviation and broke manifoldness — a far worse outcome than the locally thin
#: crease the cap causes, which the backend regularises away. Three mutually
#: perpendicular faces is the worst configuration a real corner produces;
#: beyond it the vertex normal is not bisecting anything and extending along it
#: is guesswork.
MAX_MITER = 2.0


def _miter(vertices: np.ndarray, faces: np.ndarray, normals: np.ndarray) -> np.ndarray:
    """Per-vertex factor that restores the true perpendicular offset distance.

    A vertex normal at a crease bisects the faces meeting there, so a step of
    ``d`` along it clears each face's plane by only ``d * cos(angle between the
    two)``. Dividing by that cosine puts the offset surface back at ``d`` from
    every face. The *smallest* cosine over the incident faces is used, so the
    wall is never thinner than requested — erring towards too thick, which a
    solidifier absorbs, rather than too thin, which it may pinch away.
    """
    cosine = np.full(len(vertices), np.inf)
    if len(faces):
        tri = vertices[faces]
        face_normals = _normalize(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]))
        for column in range(3):
            at_corner = np.einsum("ij,ij->i", normals[faces[:, column]], face_normals)
            np.minimum.at(cosine, faces[:, column], at_corner)

    usable = np.isfinite(cosine) & (cosine > 1.0 / MAX_MITER)
    return np.where(usable, 1.0 / np.where(usable, cosine, 1.0), MAX_MITER)


def _normalize(vectors: np.ndarray) -> np.ndarray:
    """Unit vectors, leaving zero-length rows at zero instead of dividing by 0."""
    lengths = np.linalg.norm(vectors, axis=1)
    out = np.zeros_like(vectors)
    safe = lengths > 0
    out[safe] = vectors[safe] / lengths[safe, None]
    return out


def vertex_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Unit vertex normals, weighted by the incident angle at each vertex.

    Angle weighting (Thürmer & Wüthrich), not area weighting, because the
    result must not depend on how a flat region happened to be triangulated —
    and a cube is exactly the case that exposes the difference: area weighting
    pulls a corner towards whichever side got the most triangles, giving
    ``(-0.82, -0.41, -0.41)`` where the answer is ``(-0.58, -0.58, -0.58)``.
    Since these normals are the direction an open shell is offset along, a
    skewed corner normal is a skewed wall.

    Vertices with no usable incident face (isolated, or surrounded entirely by
    degenerate triangles) keep a zero normal: they are simply not offset, rather
    than being pushed in an arbitrary direction.
    """
    normals = np.zeros_like(vertices)
    if len(faces):
        tri = vertices[faces]
        face_normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        face_normals = _normalize(face_normals)
        for column in range(3):
            other = (tri[:, (column + 1) % 3], tri[:, (column + 2) % 3])
            u = _normalize(other[0] - tri[:, column])
            v = _normalize(other[1] - tri[:, column])
            cosine = np.clip(np.einsum("ij,ij->i", u, v), -1.0, 1.0)
            np.add.at(normals, faces[:, column], face_normals * np.arccos(cosine)[:, None])

    lengths = np.linalg.norm(normals, axis=1)
    safe = lengths > 0
    normals[safe] /= lengths[safe, None]
    return normals


def orient_consistently(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Make neighbouring faces agree on which side is out, per component.

    Breadth-first over faces joined by a shared edge: if a neighbour traverses
    that edge in the *same* direction as the current face, the two disagree and
    the neighbour is flipped. Closed components are then turned outward by the
    sign of their volume; open ones are left as they are, since "outward" is
    undefined for a sheet and the symmetric offset only needs consistency.

    Returns a new face array; the input is not modified.
    """
    faces = faces.copy()
    if len(faces) == 0:
        return faces

    edge_faces: dict[tuple[int, int], list[int]] = {}
    for f, (a, b, c) in enumerate(faces):
        for u, v in ((a, b), (b, c), (c, a)):
            edge_faces.setdefault((u, v) if u < v else (v, u), []).append(f)

    def traverses(f: int, u: int, v: int) -> bool:
        """True when face ``f`` walks the edge in the direction u → v."""
        a, b, c = faces[f]
        return (a == u and b == v) or (b == u and c == v) or (c == u and a == v)

    visited = np.zeros(len(faces), dtype=bool)
    for seed in range(len(faces)):
        if visited[seed]:
            continue
        visited[seed] = True
        component = [seed]
        stack = [seed]
        closed = True
        while stack:
            f = stack.pop()
            a, b, c = faces[f]
            for u, v in ((a, b), (b, c), (c, a)):
                owners = edge_faces[(u, v) if u < v else (v, u)]
                if len(owners) != 2:
                    closed = False          # boundary or non-manifold edge
                    continue
                other = owners[0] if owners[1] == f else owners[1]
                if visited[other]:
                    continue
                if traverses(other, u, v):  # same direction means disagreement
                    faces[other] = faces[other][::-1]
                visited[other] = True
                component.append(other)
                stack.append(other)

        if not closed:
            continue                        # a sheet has no outside to face
        tri = vertices[faces[component]]
        volume = np.einsum(
            "ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])
        ).sum() / 6.0
        if volume < 0:
            faces[component] = faces[component][:, ::-1]
    return faces
