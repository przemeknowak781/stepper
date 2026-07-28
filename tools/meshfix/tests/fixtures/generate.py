"""Deterministic fixture generation (SPEC 10.1).

Fixtures are built procedurally and never committed as binaries, so the test
suite has no opaque inputs. Every builder is a pure function of its seed.

Run directly to materialise them::

    python -m tests.fixtures.generate [outdir]
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import trimesh

DATA_DIR = Path(__file__).parent / "data"
SEED = 0


def _mesh(vertices, faces) -> trimesh.Trimesh:
    """Build a Trimesh with no implicit cleanup — fixtures must keep their defects."""
    return trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=np.float64),
        faces=np.asarray(faces, dtype=np.int64),
        process=False,
    )


def clean_cube() -> trimesh.Trimesh:
    """A correct closed cube. Expected verdict: printable."""
    return _mesh(*_box_arrays(10.0))


def open_cube() -> trimesh.Trimesh:
    """Cube missing one face: watertight fails, everything else is fine."""
    vertices, faces = _box_arrays(10.0)
    return _mesh(vertices, faces[:-2])  # drop the two triangles of one quad


def nonmanifold_edge() -> trimesh.Trimesh:
    """Three triangles sharing a single edge: the classic non-manifold edge."""
    vertices = [
        [0.0, 0.0, 0.0],  # 0 shared edge start
        [1.0, 0.0, 0.0],  # 1 shared edge end
        [0.0, 1.0, 0.0],  # 2 apex A
        [0.0, -1.0, 0.0],  # 3 apex B
        [0.0, 0.0, 1.0],  # 4 apex C
    ]
    faces = [[0, 1, 2], [0, 1, 3], [0, 1, 4]]
    return _mesh(vertices, faces)


def bowtie_vertex() -> trimesh.Trimesh:
    """Two pyramids joined at exactly one vertex.

    Every edge still has exactly two incident faces, so an edge-only manifold
    test passes. The shared apex has two separate face fans, which is what the
    vertex test in :mod:`meshfix.diagnose` must catch (SPEC 5.2, change C11).
    """
    vertices = [[0.0, 0.0, 0.0]]  # 0 = shared apex
    faces: list[list[int]] = []
    for sign in (1.0, -1.0):
        base_start = len(vertices)
        z = sign * 1.0
        vertices += [
            [-1.0, -1.0, z],
            [1.0, -1.0, z],
            [1.0, 1.0, z],
            [-1.0, 1.0, z],
        ]
        b = [base_start + i for i in range(4)]
        if sign > 0:
            faces += [[0, b[0], b[1]], [0, b[1], b[2]], [0, b[2], b[3]], [0, b[3], b[0]]]
            faces += [[b[0], b[3], b[2]], [b[0], b[2], b[1]]]
        else:
            faces += [[0, b[1], b[0]], [0, b[2], b[1]], [0, b[3], b[2]], [0, b[0], b[3]]]
            faces += [[b[0], b[1], b[2]], [b[0], b[2], b[3]]]
    return _mesh(vertices, faces)


def selfintersect_torus() -> trimesh.Trimesh:
    """Two coplanar tori whose tubes genuinely pass through each other.

    An earlier version used interlocked (perpendicular) tori, which look like
    they should intersect and do not: with major radius 5 the two centre
    circles never come closer than 5 units, well beyond the combined tube
    radius of 3. Keeping both tori in the same plane with centres 6 apart makes
    the centre circles cross outright, so the tubes must intersect.
    """
    kwargs = dict(major_radius=5.0, minor_radius=1.5, major_sections=48, minor_sections=16)
    a = trimesh.creation.torus(**kwargs)
    b = trimesh.creation.torus(**kwargs)
    b.apply_translation([6.0, 0.0, 0.0])
    return _mesh(
        np.vstack([a.vertices, b.vertices]),
        np.vstack([a.faces, b.faces + len(a.vertices)]),
    )


def flipped_normals() -> trimesh.Trimesh:
    """A sphere with 30% of its faces wound backwards (deterministic choice)."""
    sphere = trimesh.creation.icosphere(subdivisions=2, radius=5.0)
    faces = np.array(sphere.faces, dtype=np.int64)
    rng = np.random.default_rng(SEED)
    flip = rng.choice(len(faces), size=int(0.3 * len(faces)), replace=False)
    faces[flip] = faces[flip][:, ::-1]
    return _mesh(sphere.vertices, faces)


def degenerate_slivers() -> trimesh.Trimesh:
    """A clean cube plus zero-area triangles glued onto its surface."""
    vertices, faces = _box_arrays(10.0)
    vertices = list(map(list, vertices))
    faces = list(map(list, faces))
    # Three collinear points produce a triangle of exactly zero area.
    base = len(vertices)
    vertices += [[0.0, 0.0, 0.0], [1e-9, 0.0, 0.0], [2e-9, 0.0, 0.0]]
    faces += [[base, base + 1, base + 2]]
    # A needle: two coincident vertices.
    base = len(vertices)
    vertices += [[10.0, 10.0, 10.0], [10.0, 10.0, 10.0], [10.0, 9.0, 10.0]]
    faces += [[base, base + 1, base + 2]]
    return _mesh(vertices, faces)


def two_components() -> trimesh.Trimesh:
    """Two disjoint spheres: rejected at --expected-components 1, fine at 2."""
    a = trimesh.creation.icosphere(subdivisions=2, radius=3.0)
    b = trimesh.creation.icosphere(subdivisions=2, radius=3.0)
    b.apply_translation([20.0, 0.0, 0.0])
    return _mesh(
        np.vstack([a.vertices, b.vertices]),
        np.vstack([a.faces, b.faces + len(a.vertices)]),
    )


def open_shell() -> trimesh.Trimesh:
    """A curved patch with no thickness — a surface, not a solid.

    This is the case that silently produced an ``alpha/15``-thick slab in spec
    version 1.0 and now trips criterion A10 (SPEC 5.3, change C2).
    """
    n = 21
    xs = np.linspace(-10.0, 10.0, n)
    ys = np.linspace(-10.0, 10.0, n)
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    gz = 3.0 * np.sin(gx / 5.0) * np.cos(gy / 5.0)
    vertices = np.column_stack([gx.ravel(), gy.ravel(), gz.ravel()])
    faces = []
    for i in range(n - 1):
        for j in range(n - 1):
            v00 = i * n + j
            v10 = (i + 1) * n + j
            faces += [[v00, v10, v10 + 1], [v00, v10 + 1, v00 + 1]]
    return _mesh(vertices, faces)


def thin_shell() -> trimesh.Trimesh:
    """A solid plate 0.2 units thick: valid topology, too thin to print."""
    vertices, faces = _box_arrays(1.0)
    vertices = np.asarray(vertices) * np.array([10.0, 10.0, 0.2])
    return _mesh(vertices, faces)


def ai_like_blob() -> trimesh.Trimesh:
    """A sphere with radial noise, punched holes and an interpenetrating lobe.

    Stands in for the output of a generative model: severely defective in
    several independent ways at once.
    """
    rng = np.random.default_rng(SEED)
    sphere = trimesh.creation.icosphere(subdivisions=3, radius=5.0)
    vertices = np.asarray(sphere.vertices, dtype=np.float64)
    radial = vertices / np.linalg.norm(vertices, axis=1)[:, None]
    vertices = vertices + radial * rng.normal(0.0, 0.25, size=(len(vertices), 1))
    faces = np.asarray(sphere.faces, dtype=np.int64)
    # Punch holes.
    keep = np.ones(len(faces), dtype=bool)
    keep[rng.choice(len(faces), size=int(0.04 * len(faces)), replace=False)] = False
    faces = faces[keep]
    # Add a lobe that interpenetrates the body.
    lobe = trimesh.creation.icosphere(subdivisions=2, radius=3.0)
    lobe.apply_translation([4.0, 0.0, 0.0])
    return _mesh(
        np.vstack([vertices, lobe.vertices]),
        np.vstack([faces, np.asarray(lobe.faces, dtype=np.int64) + len(vertices)]),
    )


def _box_arrays(size: float):
    """Axis-aligned box spanning [0, size]^3, outward-facing, 12 triangles."""
    s = float(size)
    vertices = np.array(
        [
            [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
            [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
        ],
        dtype=np.float64,
    )
    faces = np.array(
        [
            [0, 3, 2], [0, 2, 1],  # -z
            [4, 5, 6], [4, 6, 7],  # +z
            [0, 1, 5], [0, 5, 4],  # -y
            [1, 2, 6], [1, 6, 5],  # +x
            [2, 3, 7], [2, 7, 6],  # +y
            [3, 0, 4], [3, 4, 7],  # -x
        ],
        dtype=np.int64,
    )
    return vertices, faces


BUILDERS = {
    "clean_cube": clean_cube,
    "open_cube": open_cube,
    "nonmanifold_edge": nonmanifold_edge,
    "bowtie_vertex": bowtie_vertex,
    "selfintersect_torus": selfintersect_torus,
    "flipped_normals": flipped_normals,
    "degenerate_slivers": degenerate_slivers,
    "two_components": two_components,
    "open_shell": open_shell,
    "thin_shell": thin_shell,
    "ai_like_blob": ai_like_blob,
}


def build(name: str) -> trimesh.Trimesh:
    if name not in BUILDERS:
        raise KeyError(f"unknown fixture {name!r}; have {sorted(BUILDERS)}")
    return BUILDERS[name]()


def build_all(outdir: Path | None = None) -> dict[str, Path]:
    """Materialise every fixture as an STL and return the paths."""
    from meshfix.io import save_mesh

    outdir = Path(outdir or DATA_DIR)
    outdir.mkdir(parents=True, exist_ok=True)
    written = {}
    for name in BUILDERS:
        path = outdir / f"{name}.stl"
        save_mesh(build(name), path)
        written[name] = path
    return written


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DATA_DIR
    for name, path in build_all(target).items():
        print(f"{name:24s} -> {path}")
