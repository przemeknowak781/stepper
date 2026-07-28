"""Mesh loading and saving.

Two invariants matter here and both are easy to get wrong:

1. **Loading must not silently repair.** ``trimesh.load`` defaults to
   ``process=True``, which merges duplicate vertices *and* drops degenerate
   faces and fixes winding before you ever see the mesh. That would make
   :mod:`meshfix.diagnose` report a cleaner mesh than the user actually has,
   i.e. it would lie. We always load with ``process=False``.

   The one exception is **exact** vertex welding, which is decoding rather
   than repair: binary STL stores every triangle as three independent
   vertices and cannot express sharing at all, so without it a perfectly good
   cube reads back as twelve disconnected components with no watertight
   edges. Only bit-identical coordinates are merged, so no defect is hidden —
   merging vertices that are merely *close* is a genuine repair and belongs to
   :mod:`meshfix.postprocess`, under an explicit tolerance.

2. **Saving must be deterministic.** Byte-identical output for byte-identical
   input is a stated requirement (SPEC 1.1), so the writer must not embed
   timestamps or depend on dict ordering.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import trimesh

SUPPORTED_SUFFIXES = {".stl", ".obj", ".ply", ".off", ".3mf", ".glb"}


class UnsupportedFormatError(ValueError):
    """Raised for a file extension meshfix cannot read (CLI exit code 2)."""


class EmptyMeshError(ValueError):
    """Raised when a file loads but contains no triangles (CLI exit code 2)."""


def load_mesh(path: str | Path, *, weld: bool = True) -> trimesh.Trimesh:
    """Load a mesh **without** any implicit repair.

    Multi-mesh scenes are concatenated into one triangle soup: meshfix treats
    the input as pure geometry (SPEC 1.2), so object structure carries no
    meaning here.

    ``weld`` merges only bit-identical vertices, recovering the connectivity
    that formats like STL cannot represent. Pass ``weld=False`` to see the file
    exactly as stored.
    """
    path = Path(path)
    if path.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise UnsupportedFormatError(
            f"{path.suffix!r} is not a supported input format; "
            f"expected one of {sorted(SUPPORTED_SUFFIXES)}"
        )
    if not path.is_file():
        raise FileNotFoundError(path)

    loaded = trimesh.load(path, force="mesh", process=False)

    if isinstance(loaded, trimesh.Scene):
        geometries = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not geometries:
            raise EmptyMeshError(f"{path} contains no triangle geometry")
        loaded = trimesh.util.concatenate(geometries)

    if not isinstance(loaded, trimesh.Trimesh):
        raise EmptyMeshError(f"{path} did not load as a triangle mesh (got {type(loaded).__name__})")
    if len(loaded.faces) == 0:
        raise EmptyMeshError(f"{path} contains no triangles")

    return weld_exact(loaded) if weld else loaded


def weld_exact(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """Merge only bit-identical vertices; keep every face, including degenerate ones.

    This restores shared vertices lost by soup formats. It deliberately does
    **not** use a distance tolerance: near-coincident vertices are a real
    defect that the diagnosis has to see and the postprocessor has to fix
    under an explicit, reported tolerance.
    """
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    unique, inverse = np.unique(vertices, axis=0, return_inverse=True)
    if len(unique) == len(vertices):
        return mesh
    return trimesh.Trimesh(
        vertices=unique,
        faces=inverse.reshape(-1)[faces],
        process=False,
    )


def save_mesh(mesh: trimesh.Trimesh, path: str | Path) -> Path:
    """Write a mesh deterministically.

    Binary STL is written by hand rather than through ``mesh.export`` so the
    80-byte header is guaranteed to be zero-filled. trimesh is free to put
    identifying text there, and any such text would break the byte-identity
    requirement across versions.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    suffix = path.suffix.lower()

    if suffix == ".stl":
        path.write_bytes(_binary_stl_bytes(mesh))
    else:
        # Other writers are used as-is; determinism for them is only as good as
        # the upstream exporter, which is why STL stays the default output.
        path.write_bytes(mesh.export(file_type=suffix.lstrip(".")))
    return path


def _binary_stl_bytes(mesh: trimesh.Trimesh) -> bytes:
    """Serialise to binary STL with a zero header and float32 little-endian data."""
    triangles = np.asarray(mesh.triangles, dtype=np.float64)
    n = len(triangles)

    # Recompute normals from the vertex order rather than trusting mesh state:
    # a stale cached normal would make the output depend on load history.
    edge1 = triangles[:, 1] - triangles[:, 0]
    edge2 = triangles[:, 2] - triangles[:, 0]
    normals = np.cross(edge1, edge2)
    lengths = np.linalg.norm(normals, axis=1)
    # Degenerate faces get a zero normal, which is what the STL spec allows.
    safe = lengths > 0
    normals[safe] /= lengths[safe, None]
    normals[~safe] = 0.0

    record = np.zeros(n, dtype=np.dtype([("data", "<f4", (12,)), ("attr", "<u2")]))
    record["data"][:, 0:3] = normals
    record["data"][:, 3:6] = triangles[:, 0]
    record["data"][:, 6:9] = triangles[:, 1]
    record["data"][:, 9:12] = triangles[:, 2]

    return b"\0" * 80 + np.uint32(n).tobytes() + record.tobytes()


def sha256_file(path: str | Path) -> str:
    """Hex digest of a file, used to prove determinism and idempotence."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def float32_ulp(magnitude: float) -> float:
    """Spacing between adjacent float32 values near ``magnitude``.

    Weld tolerances are clamped to this (SPEC 8.1, change C9): a tolerance
    below the storage precision of the file format silently does nothing after
    a round trip through STL.
    """
    magnitude = abs(float(magnitude))
    if magnitude == 0.0:
        return float(np.spacing(np.float32(0)))
    return float(np.spacing(np.float32(magnitude)))
