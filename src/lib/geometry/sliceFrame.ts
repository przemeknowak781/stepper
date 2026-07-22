import type { Vector3Tuple } from 'three'
import { computeAABB, type AABB } from './boundingBox'

/**
 * The slicing axis: the model is cut into horizontal layers whose normal points
 * along this world axis.  Default `z` (these meshes are modelled Z-up, like the
 * reference m2 set).  The two remaining axes span the in-plane (u, v) grid.
 */
export type SliceAxis = 'x' | 'y' | 'z'

/**
 * Static description of the voxel grid the slicer rasterises into.  `(nx, ny)`
 * is the in-plane cell count, `nz` the number of layers (= `Slices`).  Indexing
 * is `k*nx*ny + j*nx + i` (i→u, j→v, k→w).  Mirrors the discretisation the
 * Superficialis solver builds from `HorizontalDensityInCells × Slices`, so what
 * the user previews is what the solver sees.
 */
export interface GridMeta {
  axis: SliceAxis
  nx: number
  ny: number
  nz: number
  /** In-plane cell edge length (mm).  Square cells in u and v. */
  cellSize: number
  /** Layer thickness along the slicing axis (mm). */
  layerThickness: number
  /** Min corner of the grid in frame coords (uMin, vMin, wMin). */
  origin: Vector3Tuple
  /** The model AABB, in world coords, the grid was fitted to. */
  worldAABB: AABB
}

/** Map a world point to frame coords (u, v, w) for the chosen slicing axis. */
export function worldToFrame(
  x: number,
  y: number,
  z: number,
  axis: SliceAxis,
): [number, number, number] {
  switch (axis) {
    // w is the slicing direction; (u, v) span the layer plane.
    case 'x':
      return [y, z, x]
    case 'y':
      return [x, z, y]
    default:
      return [x, y, z]
  }
}

/** Inverse of {@link worldToFrame}: frame coords (u, v, w) back to world (x, y, z). */
export function frameToWorld(
  u: number,
  v: number,
  w: number,
  axis: SliceAxis,
): Vector3Tuple {
  switch (axis) {
    case 'x':
      return [w, u, v]
    case 'y':
      return [u, w, v]
    default:
      return [u, v, w]
  }
}

/**
 * Fit a {@link GridMeta} to a mesh AABB.  `slices` layers along the axis;
 * `density` cells across the *larger* in-plane extent (the common slicer
 * convention — the smaller axis simply gets fewer cells of the same size so
 * cells stay square).  Both counts are clamped to ≥1.
 */
export function computeGrid(
  worldAABB: AABB,
  axis: SliceAxis,
  slices: number,
  density: number,
): GridMeta {
  const [uMin, vMin, wMin] = worldToFrame(worldAABB.min[0], worldAABB.min[1], worldAABB.min[2], axis)
  const [uMax, vMax, wMax] = worldToFrame(worldAABB.max[0], worldAABB.max[1], worldAABB.max[2], axis)

  const extentU = Math.max(uMax - uMin, 1e-9)
  const extentV = Math.max(vMax - vMin, 1e-9)
  const extentW = Math.max(wMax - wMin, 1e-9)

  const nz = Math.max(1, Math.floor(slices) || 1)
  const dens = Math.max(1, Math.floor(density) || 1)

  const cellSize = Math.max(extentU, extentV) / dens
  const nx = Math.max(1, Math.ceil(extentU / cellSize))
  const ny = Math.max(1, Math.ceil(extentV / cellSize))
  const layerThickness = extentW / nz

  return {
    axis,
    nx,
    ny,
    nz,
    cellSize,
    layerThickness,
    origin: [uMin, vMin, wMin],
    worldAABB,
  }
}

/** Convenience: build the grid straight from a vertex buffer. */
export function computeGridFromVertices(
  vertices: Float32Array,
  axis: SliceAxis,
  slices: number,
  density: number,
): GridMeta {
  return computeGrid(computeAABB(vertices), axis, slices, density)
}

/** World-space centre of layer `k` along the slicing axis (mm on that axis). */
export function layerCenterW(grid: GridMeta, k: number): number {
  return grid.origin[2] + (k + 0.5) * grid.layerThickness
}

/** Frame-space centre (u, v) of in-plane cell (i, j). */
export function cellCenterUV(grid: GridMeta, i: number, j: number): [number, number] {
  return [
    grid.origin[0] + (i + 0.5) * grid.cellSize,
    grid.origin[1] + (j + 0.5) * grid.cellSize,
  ]
}

/** Flatten a voxel index (i, j, k) into the occupancy array offset. */
export function voxelIndex(grid: GridMeta, i: number, j: number, k: number): number {
  return k * grid.nx * grid.ny + j * grid.nx + i
}

/** Total voxel count of a grid. */
export function voxelCount(grid: GridMeta): number {
  return grid.nx * grid.ny * grid.nz
}
