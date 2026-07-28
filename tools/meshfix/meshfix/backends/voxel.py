"""Native voxel solidification backend (SPEC 7.3).

Implemented directly on numpy (see :mod:`meshfix.nputil`) rather than through
OpenVDB or headless Blender. The algorithm is small, the two libraries are
already hard dependencies, and shelling out to Blender costs seconds of
start-up and makes byte-identical output depend on a version we do not pin.
See NOTES.md for the full argument.

Volume is defined by **connectivity to the outside**, not by ray parity:

1. Rasterise every triangle into a padded occupancy grid by dense point
   sampling (finer than half a voxel, so the shell has no pinholes).
2. Dilate that shell by ``seal`` voxels, bridging cracks up to that width.
3. Flood the *outside* inward from the grid border. Anything the flood never
   reaches is interior, whatever the input's normals or open boundaries said.
4. Erode by ``seal`` to undo the dilation's inflation.
5. Fill the diagonal voxel configurations that would make the extracted
   surface non-manifold — only those, so flat faces stay flat.
6. Extract the cuberille surface with welded corners.

Steps 3 and 5 are what make the output watertight and 2-manifold by
construction, which is the entire reason this backend exists as a fallback.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from logging import Logger
from pathlib import Path

import numpy as np
import trimesh
from ..io import load_mesh, save_mesh
from ..nputil import binary_dilation, binary_erosion, flood_from_border
from . import BackendResult, RunContext

#: Empty border kept around the model so the outside flood always has a seed.
PAD_VOXELS = 2


@dataclass
class Grid:
    origin: np.ndarray      # world position of voxel (0,0,0)'s min corner
    spacing: float
    shape: tuple[int, int, int]


class VoxelBackend:
    name = "voxel"

    def available(self) -> tuple[bool, str]:
        return True, ""

    def suggest_params(self, mesh: trimesh.Trimesh, ctx: RunContext) -> dict:
        """Voxel size from a target resolution, not from ``p01(edge_length)``.

        The percentile of edge length is dominated by the sliver triangles this
        backend exists to remove, so it never actually steered the parameter
        (SPEC 7.3, change C4).
        """
        diagonal = float(np.linalg.norm(mesh.bounds[1] - mesh.bounds[0]))
        if ctx.voxel_size is not None:
            spacing = float(ctx.voxel_size)
        else:
            resolution = max(int(ctx.voxel_resolution), 1)
            spacing = diagonal / resolution
            spacing = min(max(spacing, diagonal / 1024.0), diagonal / 64.0)
        return {"voxel_size": spacing, "seal": int(ctx.seal)}

    def run(
        self, input_path: Path, output_path: Path, params: dict, log: Logger
    ) -> BackendResult:
        started = time.perf_counter()
        mesh = load_mesh(input_path)
        spacing = float(params["voxel_size"])
        seal = int(params.get("seal", 1))

        occupancy, grid = solidify(mesh, spacing=spacing, seal=seal, log=log)
        occupied = int(occupancy.sum())
        if occupied == 0:
            return BackendResult(
                success=False,
                wall_time_s=time.perf_counter() - started,
                params_used=params,
                message="solidification produced an empty volume; voxel size is probably too large",
            )

        result = cuberille_surface(occupancy, grid)
        save_mesh(result, output_path)
        log.info(
            "voxel: spacing=%.5g grid=%s occupied=%d faces=%d",
            spacing, grid.shape, occupied, len(result.faces),
        )
        return BackendResult(
            success=True,
            output_path=output_path,
            wall_time_s=time.perf_counter() - started,
            params_used={**params, "grid_shape": list(grid.shape), "occupied_voxels": occupied},
            message="",
        )


# --------------------------------------------------------------------------
# Volume definition
# --------------------------------------------------------------------------

def build_grid(mesh: trimesh.Trimesh, spacing: float) -> Grid:
    """Padded grid, offset by half a voxel.

    The half-voxel shift puts axis-aligned model faces at voxel *centres*
    instead of on voxel boundaries, where sample points would round
    ambiguously to either side and scatter stray voxels along a flat wall.
    """
    lo, hi = np.asarray(mesh.bounds, dtype=np.float64)
    origin = lo - (PAD_VOXELS + 0.5) * spacing
    extent = (hi - lo) / spacing
    shape = tuple(int(np.ceil(e)) + 2 * PAD_VOXELS + 1 for e in extent)
    return Grid(origin=origin, spacing=spacing, shape=shape)


def rasterise_surface(mesh: trimesh.Trimesh, grid: Grid) -> np.ndarray:
    """Mark every voxel the surface passes through, with no gaps.

    Triangles are sampled on a barycentric lattice finer than half a voxel.
    Triangles are bucketed by the lattice density they need, so each bucket is
    generated once and applied to all its triangles by broadcasting rather
    than one Python iteration per triangle.
    """
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    occupancy = np.zeros(grid.shape, dtype=bool)
    if len(faces) == 0:
        return occupancy

    a, b, c = vertices[faces[:, 0]], vertices[faces[:, 1]], vertices[faces[:, 2]]
    longest = np.maximum(
        np.linalg.norm(b - a, axis=1),
        np.maximum(np.linalg.norm(c - a, axis=1), np.linalg.norm(c - b, axis=1)),
    )
    needed = np.ceil(longest / (0.5 * grid.spacing)).astype(np.int64)
    needed = np.clip(needed, 1, 1 << 12)
    level = np.ceil(np.log2(np.maximum(needed, 1))).astype(np.int64)

    for lvl in np.unique(level):
        selection = np.flatnonzero(level == lvl)
        n = int(1 << int(lvl))
        bary = _barycentric_lattice(n)                       # (m, 3)
        # Chunk so (chunk * m * 3) stays a sane allocation.
        chunk = max(1, int(2_000_000 / max(len(bary), 1)))
        for start in range(0, len(selection), chunk):
            idx = selection[start : start + chunk]
            points = (
                bary[None, :, 0, None] * a[idx][:, None, :]
                + bary[None, :, 1, None] * b[idx][:, None, :]
                + bary[None, :, 2, None] * c[idx][:, None, :]
            ).reshape(-1, 3)
            _mark(occupancy, grid, points)
    return occupancy


def _barycentric_lattice(n: int) -> np.ndarray:
    """Uniform barycentric lattice with ``n`` subdivisions per edge."""
    i, j = np.meshgrid(np.arange(n + 1), np.arange(n + 1), indexing="ij")
    keep = (i + j) <= n
    u = i[keep] / n
    v = j[keep] / n
    return np.stack([1.0 - u - v, u, v], axis=1)


def _mark(occupancy: np.ndarray, grid: Grid, points: np.ndarray) -> None:
    index = np.floor((points - grid.origin) / grid.spacing).astype(np.int64)
    inside = np.all((index >= 0) & (index < np.array(grid.shape)), axis=1)
    index = index[inside]
    if len(index):
        occupancy[index[:, 0], index[:, 1], index[:, 2]] = True


def solidify(
    mesh: trimesh.Trimesh, *, spacing: float, seal: int = 1, log: Logger | None = None
) -> tuple[np.ndarray, Grid]:
    """Occupancy grid of the solid interior, robust to holes and bad normals."""
    grid = build_grid(mesh, spacing)
    surface = rasterise_surface(mesh, grid)

    sealed = binary_dilation(surface, iterations=seal) if seal > 0 else surface

    # Everything the outside can reach through empty space is exterior.
    outside = flood_from_border(~sealed)

    solid = ~outside
    if seal > 0:
        solid = binary_erosion(solid, iterations=seal)
    make_manifold(solid)
    if log is not None:
        log.debug("solidify: shape=%s occupied=%d", grid.shape, int(solid.sum()))
    return solid, grid


def make_manifold(occupancy: np.ndarray) -> None:
    """Remove the diagonal voxel patterns that pinch the extracted surface.

    Around a grid edge, four voxels meet. When two of them are solid on one
    diagonal and the other two empty, the cuberille surface folds so that four
    faces share that edge — a non-manifold edge. Filling one empty voxel of the
    pair turns the 2/2 pattern into 3/1, which is manifold.

    Only those cells are touched, unlike a blanket dilation, which would bevel
    every edge in the model. Iterated to a fixpoint with a hard cap so it
    always terminates. Modifies ``occupancy`` in place.
    """
    for _ in range(6):
        changed = False
        for axis_a, axis_b in ((1, 2), (0, 2), (0, 1)):
            base = [slice(None)] * 3
            def sl(da: int, db: int):
                s = list(base)
                s[axis_a] = slice(da, occupancy.shape[axis_a] - 1 + da)
                s[axis_b] = slice(db, occupancy.shape[axis_b] - 1 + db)
                return tuple(s)

            p00, p01_, p10, p11 = (occupancy[sl(0, 0)], occupancy[sl(0, 1)],
                                   occupancy[sl(1, 0)], occupancy[sl(1, 1)])
            diag_a = p00 & p11 & ~p01_ & ~p10
            diag_b = p01_ & p10 & ~p00 & ~p11
            if diag_a.any():
                occupancy[sl(0, 1)] |= diag_a
                changed = True
            if diag_b.any():
                occupancy[sl(0, 0)] |= diag_b
                changed = True
        if not changed:
            break


# --------------------------------------------------------------------------
# Surface extraction
# --------------------------------------------------------------------------

_FACE_CORNERS = {
    (-1, 0, 0): ((0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)),
    (1, 0, 0): ((1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)),
    (0, -1, 0): ((0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)),
    (0, 1, 0): ((0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)),
    (0, 0, -1): ((0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)),
    (0, 0, 1): ((0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)),
}


def cuberille_surface(occupancy: np.ndarray, grid: Grid) -> trimesh.Trimesh:
    """Boundary surface of the occupancy grid, with corners welded.

    A quad is emitted for every voxel face whose neighbour is empty, wound
    outward. Because corners are shared through a single global index, the
    result is watertight wherever the occupancy is manifold.
    """
    nx, ny, nz = occupancy.shape
    corner_stride = np.array([1, nx + 1, (nx + 1) * (ny + 1)], dtype=np.int64)

    quads: list[np.ndarray] = []
    for direction, corners in _FACE_CORNERS.items():
        shifted = np.zeros_like(occupancy)
        src = tuple(
            slice(max(d, 0), occupancy.shape[i] + min(d, 0)) for i, d in enumerate(direction)
        )
        dst = tuple(
            slice(max(-d, 0), occupancy.shape[i] - max(d, 0)) for i, d in enumerate(direction)
        )
        shifted[dst] = occupancy[src]
        exposed = occupancy & ~shifted
        if not exposed.any():
            continue
        voxels = np.argwhere(exposed)
        ids = np.stack(
            [((voxels + np.array(c)) * corner_stride).sum(axis=1) for c in corners], axis=1
        )
        quads.append(ids)

    if not quads:
        return trimesh.Trimesh(
            vertices=np.zeros((0, 3)), faces=np.zeros((0, 3), dtype=np.int64), process=False
        )

    quad_ids = np.vstack(quads)
    unique, inverse = np.unique(quad_ids.ravel(), return_inverse=True)
    local = inverse.reshape(quad_ids.shape)

    # Decode global corner ids back into lattice coordinates, then to world.
    ci = unique % (nx + 1)
    cj = (unique // (nx + 1)) % (ny + 1)
    ck = unique // ((nx + 1) * (ny + 1))
    vertices = grid.origin + np.stack([ci, cj, ck], axis=1) * grid.spacing

    faces = np.empty((len(local) * 2, 3), dtype=np.int64)
    faces[0::2] = local[:, [0, 1, 2]]
    faces[1::2] = local[:, [0, 2, 3]]
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
