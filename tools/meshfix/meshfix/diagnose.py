"""Read-only mesh diagnosis (SPEC 5).

Nothing in this module mutates the input mesh. Three concepts that are
routinely conflated are kept strictly apart, because the report has to
distinguish them (SPEC 15):

* **boundary edge** — used by exactly one face; the mesh is open there.
* **non-manifold edge** — used by three or more faces.
* **self-intersection** — two faces that pass through each other. This is a
  geometric property and has nothing to do with either of the above.
  ``trimesh.repair.broken_faces`` does *not* test for it.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import numpy as np
import trimesh

from .nputil import count_connected_components
from .selfintersect import self_intersecting_faces


@dataclass
class Diagnosis:
    n_vertices: int
    n_faces: int
    bbox: list[float]
    bbox_diagonal: float
    is_watertight: bool
    is_winding_consistent: bool
    is_volume: bool
    volume: float | None
    area: float
    euler_number: int
    genus: int | None
    n_components: int
    n_boundary_edges: int
    n_nonmanifold_edges: int
    n_nonmanifold_vertices: int
    n_selfintersecting_faces: int
    n_degenerate_faces: int
    n_duplicate_vertices: int
    n_unreferenced_vertices: int
    edge_length_percentiles: dict = field(default_factory=dict)
    face_area_percentiles: dict = field(default_factory=dict)
    min_dihedral_angle_deg: float = 180.0
    shell_score: float = 0.0
    verdict: str = "repairable"

    def to_dict(self) -> dict:
        return asdict(self)


# Threshold constants. These are the calibrated values (SPEC 5.1, 5.3, 13.3);
# see NOTES.md for the measurements they came from.
SEVERE_SELFINTERSECT_RATIO = 0.05
SEVERE_COMPONENT_COUNT = 20
SEVERE_NONMANIFOLD_RATIO = 0.02
SHELL_SCORE_THRESHOLD = 0.5
SHELL_BOUNDARY_GAIN = 4.0


def analyze(mesh: trimesh.Trimesh, *, check_selfintersection: bool = True) -> Diagnosis:
    """Measure a mesh without changing it."""
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)

    bounds = np.array([vertices.min(axis=0), vertices.max(axis=0)])
    diagonal = float(np.linalg.norm(bounds[1] - bounds[0]))

    edges = np.sort(faces[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2), axis=1)
    unique_edges, edge_counts = np.unique(edges, axis=0, return_counts=True)
    n_boundary = int((edge_counts == 1).sum())
    n_nonmanifold_edges = int((edge_counts > 2).sum())

    eps_area = (diagonal * 1e-6) ** 2
    areas = _triangle_areas(vertices, faces)
    n_degenerate = int((areas <= eps_area).sum())

    euler = len(_referenced(vertices, faces)) - len(unique_edges) + len(faces)
    n_components = _component_count(mesh, faces)
    n_nonmanifold_vertices = _nonmanifold_vertex_count(faces)

    manifold = n_nonmanifold_edges == 0 and n_nonmanifold_vertices == 0
    genus: int | None = None
    if manifold and n_boundary == 0 and n_components == 1 and euler % 2 == 0:
        genus = int((2 - euler) // 2)

    n_selfintersecting = (
        int(len(self_intersecting_faces(vertices, faces))) if check_selfintersection else 0
    )

    edge_lengths = np.linalg.norm(
        vertices[unique_edges[:, 0]] - vertices[unique_edges[:, 1]], axis=1
    )

    volume: float | None = None
    # A zero-volume soup makes trimesh's centre-of-mass divide by zero. That is
    # an expected outcome for a degenerate input, not an error, so the warning
    # is silenced here only — never the exception, which stays reported.
    with np.errstate(invalid="ignore", divide="ignore"):
        try:
            volume = float(mesh.volume)
            is_volume = bool(mesh.is_volume)
        except Exception as exc:  # noqa: BLE001 - reported, never swallowed (SPEC 15)
            volume = None
            is_volume = False
            _ = exc

    shell_score = _shell_score(
        n_boundary_edges=n_boundary,
        n_edges=len(unique_edges),
        area=float(areas.sum()),
        signed_volume=_divergence_volume(vertices, faces),
    )

    diag = Diagnosis(
        n_vertices=len(vertices),
        n_faces=len(faces),
        bbox=[float(x) for x in bounds.ravel()],
        bbox_diagonal=diagonal,
        is_watertight=bool(mesh.is_watertight),
        is_winding_consistent=bool(mesh.is_winding_consistent),
        is_volume=is_volume,
        volume=volume,
        area=float(areas.sum()),
        euler_number=int(euler),
        genus=genus,
        n_components=n_components,
        n_boundary_edges=n_boundary,
        n_nonmanifold_edges=n_nonmanifold_edges,
        n_nonmanifold_vertices=n_nonmanifold_vertices,
        n_selfintersecting_faces=n_selfintersecting,
        n_degenerate_faces=n_degenerate,
        n_duplicate_vertices=_duplicate_vertex_count(vertices, diagonal),
        n_unreferenced_vertices=len(vertices) - len(_referenced(vertices, faces)),
        edge_length_percentiles=_percentiles(edge_lengths),
        face_area_percentiles=_percentiles(areas),
        min_dihedral_angle_deg=_min_dihedral_deg(mesh),
        shell_score=shell_score,
    )
    diag.verdict = classify(diag)
    return diag


def classify(diag: Diagnosis) -> str:
    """Assign a verdict (SPEC 5.1). ``shell`` outranks ``severe``."""
    printable = (
        diag.is_watertight
        and diag.n_nonmanifold_edges == 0
        and diag.n_nonmanifold_vertices == 0
        and diag.is_winding_consistent
        and (diag.volume or 0.0) > 0
        and diag.n_selfintersecting_faces == 0
        and diag.n_degenerate_faces == 0
    )
    if printable:
        return "printable"
    if diag.shell_score >= SHELL_SCORE_THRESHOLD:
        return "shell"
    if (
        diag.n_selfintersecting_faces > SEVERE_SELFINTERSECT_RATIO * diag.n_faces
        or diag.n_components > SEVERE_COMPONENT_COUNT
        or diag.n_nonmanifold_edges > SEVERE_NONMANIFOLD_RATIO * diag.n_faces
    ):
        return "severe"
    return "repairable"


# --------------------------------------------------------------------------
# Shell detection (SPEC 5.3)
# --------------------------------------------------------------------------

def _shell_score(*, n_boundary_edges: int, n_edges: int, area: float, signed_volume: float) -> float:
    """How much the input looks like an open surface rather than a solid.

    An **open boundary is a precondition**, and ``thinness`` is the score:

    * ``thinness`` — the dimensionless isoperimetric quotient. A sphere scores
      exactly 1 on ``6*sqrt(pi)*V / A**1.5`` and therefore 0 thinness; a sheet
      of vanishing thickness drives V to 0 and thinness to 1.

    Calibration on the fixtures (SPEC 5.3, 13.3) rejected the version 1.1 draft
    formula ``max(4*boundary_ratio, thinness)`` for two independent reasons:

    1. ``boundary_ratio`` measures tessellation density, not shell-ness. The
       ``open_shell`` patch scores 0.065 while ``open_cube`` — a chunky solid
       missing one face — scores 0.22, i.e. the signal is inverted on the very
       pair it has to separate.
    2. On a *closed* mesh the divergence volume is corrupted by inconsistent
       winding, so ``flipped_normals`` (a perfectly solid sphere) scored 0.60.
       A closed mesh encloses volume by definition, so thinness there is A9's
       business, not A10's.

    Hence: closed mesh always scores 0; an open mesh is scored by thinness.
    """
    if n_boundary_edges == 0 or n_edges == 0:
        return 0.0
    if area <= 0:
        return 1.0
    quotient = (6.0 * math.sqrt(math.pi) * abs(signed_volume)) / (area ** 1.5)
    return float(1.0 - min(1.0, quotient))


def _divergence_volume(vertices: np.ndarray, faces: np.ndarray) -> float:
    """Signed volume by the divergence theorem; valid even on an open mesh."""
    a, b, c = vertices[faces[:, 0]], vertices[faces[:, 1]], vertices[faces[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


# --------------------------------------------------------------------------
# Non-manifold vertices (SPEC 5.2, change C11)
# --------------------------------------------------------------------------

def _nonmanifold_vertex_count(faces: np.ndarray) -> int:
    """Count vertices whose incident faces form more than one fan.

    A "bowtie" vertex joins two otherwise separate surface patches at a single
    point. Every edge around it still has exactly two incident faces, so an
    edge-only manifold test reports success — which is precisely why this test
    has to exist separately.

    Two faces incident to vertex ``v`` belong to the same fan when they share
    an edge that contains ``v``; the vertex is manifold when that relation
    leaves exactly one connected group.
    """
    if len(faces) == 0:
        return 0

    # For each (vertex, edge-through-that-vertex) pair, remember the faces.
    edge_faces: dict[tuple[int, int], list[int]] = {}
    vertex_faces: dict[int, set[int]] = {}
    for fi, (a, b, c) in enumerate(faces):
        for u, v in ((a, b), (b, c), (c, a)):
            key = (u, v) if u < v else (v, u)
            edge_faces.setdefault(key, []).append(fi)
        for v in (a, b, c):
            vertex_faces.setdefault(int(v), set()).add(fi)

    # Group the edges by each of their endpoints so the fan walk is local.
    vertex_edges: dict[int, list[tuple[int, int]]] = {}
    for key in edge_faces:
        vertex_edges.setdefault(key[0], []).append(key)
        vertex_edges.setdefault(key[1], []).append(key)

    count = 0
    for vertex, incident in vertex_faces.items():
        if len(incident) < 2:
            continue
        parent = {f: f for f in incident}

        def find(x: int) -> int:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for key in vertex_edges.get(vertex, ()):
            owners = [f for f in edge_faces[key] if f in parent]
            for other in owners[1:]:
                ra, rb = find(owners[0]), find(other)
                if ra != rb:
                    parent[rb] = ra

        if len({find(f) for f in incident}) > 1:
            count += 1
    return count


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------

def _triangle_areas(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    a, b, c = vertices[faces[:, 0]], vertices[faces[:, 1]], vertices[faces[:, 2]]
    return 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)


def _referenced(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    return np.unique(faces)


def _duplicate_vertex_count(vertices: np.ndarray, diagonal: float) -> int:
    """Vertices that would collapse at the postprocess weld tolerance.

    Exact duplicates are already merged while loading (format decoding), so
    counting them again would always return zero. What matters here is how
    many vertices sit *within tolerance* of another, i.e. how much work the
    weld in :mod:`meshfix.postprocess` will actually do.
    """
    if len(vertices) == 0:
        return 0
    from .io import float32_ulp

    tol = max(diagonal * 1e-8, float32_ulp(diagonal))
    if tol <= 0:
        return 0
    keys = np.round(vertices / tol).astype(np.int64)
    return int(len(vertices) - len(np.unique(keys, axis=0)))


def _component_count(mesh: trimesh.Trimesh, faces: np.ndarray) -> int:
    if len(faces) == 0:
        return 0
    adjacency = np.asarray(mesh.face_adjacency)
    if adjacency.size == 0:
        return len(faces)
    # Counted here rather than through trimesh, which raises "no graph engines
    # available!" unless SciPy or NetworkX is importable — that would pull
    # SciPy back in and undo the Pyodide payload saving (NOTES.md §8).
    # Isolated faces have no adjacency entry and must still count.
    return count_connected_components(adjacency, len(faces))


def _percentiles(values: np.ndarray) -> dict:
    if len(values) == 0:
        return {"p01": 0.0, "p50": 0.0, "p99": 0.0}
    p01, p50, p99 = np.percentile(values, [1, 50, 99], method="linear")
    return {"p01": float(p01), "p50": float(p50), "p99": float(p99)}


def _min_dihedral_deg(mesh: trimesh.Trimesh) -> float:
    """Smallest dihedral angle between adjacent faces, in degrees.

    ``face_adjacency_angles`` is the angle between face *normals*; the
    dihedral angle of the surface is its supplement, so a flat region reads
    180 degrees and a cube edge reads 90.
    """
    angles = np.asarray(mesh.face_adjacency_angles)
    if angles.size == 0:
        return 180.0
    return float(np.degrees(np.pi - angles.max()))
