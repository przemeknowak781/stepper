import { computeAABB, aabbMaxExtent, type AABB } from './boundingBox'
import { computeGridFromVertices, type GridMeta, type SliceAxis } from './sliceFrame'
import { sliceAndVoxelize } from './sliceVoxelize'
import { occupancyToSolid, taubinSmoothBounded, type SolidMesh } from './slicedSolid'
import { marchingCubesFromVoxelDensity } from './marchingCubes'

/**
 * How the input surface is turned into an engineering solid:
 *
 * - `voxel`   — cuberille remesh of the occupancy grid.  Blocky but the most
 *               literal representation of the discretised body; every face is
 *               axis-aligned so the STEP output is a small set of large planar
 *               facets.  Guaranteed watertight & manifold.
 * - `smooth`  — marching-cubes iso-surface of the occupancy field, then
 *               feature-preserving Taubin smoothing.  Rounds off the staircase
 *               into an organic-but-still-watertight solid.  More triangles,
 *               closer to the original silhouette.
 */
export type ConvertMethod = 'voxel' | 'smooth'

export interface ConvertSettings {
  method: ConvertMethod
  /** Slicing axis for the voxel grid. */
  axis: SliceAxis
  /**
   * In-plane grid density (cells across the longer of the two in-plane
   * extents).  Higher = finer, more faithful, heavier output.
   */
  resolution: number
  /** Number of layers along the slicing axis. */
  slices: number
  /** Taubin smoothing iterations (only for the `smooth` method). */
  smoothIterations: number
}

export const DEFAULT_CONVERT_SETTINGS: ConvertSettings = {
  method: 'smooth',
  axis: 'z',
  resolution: 48,
  slices: 48,
  smoothIterations: 8,
}

export interface ConvertReport {
  /** Triangle count of the input mesh. */
  inputTriangles: number
  /** Triangle count of the produced solid. */
  outputTriangles: number
  /** Vertex count of the produced solid. */
  outputVertices: number
  /** Occupied voxels in the grid the solid was reconstructed from. */
  occupiedVoxels: number
  grid: { nx: number; ny: number; nz: number }
  /**
   * Fraction of scan rows the voxeliser could not close because the input
   * surface was open there.  0 for a clean watertight input; > 0 warns the
   * user their mesh had holes (which the remesh nonetheless repaired).
   */
  openRowFraction: number
  /**
   * Whether the OUTPUT mesh is a closed 2-manifold (every edge shared by
   * exactly two triangles).  The whole point of the pipeline: even a torn
   * input yields `true` here.
   */
  watertight: boolean
  aabb: AABB
}

export interface ConvertResult {
  solid: SolidMesh
  report: ConvertReport
}

/**
 * Build the dense per-voxel density field (0/1) marching cubes expects from the
 * occupancy grid.  Occupancy already uses the same `k*nx*ny + j*nx + i`
 * indexing, so this is an identity copy into a Float32Array.
 */
function occupancyToField(occupancy: Uint8Array): Float32Array {
  const field = new Float32Array(occupancy.length)
  for (let i = 0; i < occupancy.length; i++) field[i] = occupancy[i]
  return field
}

/**
 * Convert an arbitrary input triangle mesh into a clean, watertight engineering
 * solid.
 *
 * The pipeline is deliberately reconstruction-based rather than repair-based:
 * we rasterise the input into a voxel occupancy grid and rebuild a fresh
 * surface from that grid.  This is what makes topology *correct by
 * construction* — self-intersections, non-manifold edges, flipped normals,
 * duplicated faces and small holes in the input all disappear because the
 * output is generated from scratch around the filled volume, never inherited
 * from the input connectivity.  The grid resolution is the single optimisation
 * knob: coarser grids simplify (fewer faces, faster STEP), finer grids stay
 * faithful.
 */
export function convertMeshToSolid(
  vertices: Float32Array,
  indices: Uint32Array | null,
  settings: ConvertSettings,
): ConvertResult {
  const grid: GridMeta = computeGridFromVertices(
    vertices,
    settings.axis,
    settings.slices,
    settings.resolution,
  )

  const vox = sliceAndVoxelize(vertices, indices, grid)

  let solid: SolidMesh
  if (settings.method === 'voxel') {
    solid = occupancyToSolid(vox.occupancy, grid)
  } else {
    const field = occupancyToField(vox.occupancy)
    const mc = marchingCubesFromVoxelDensity(field, grid, 0.5)
    const smoothed =
      settings.smoothIterations > 0
        ? taubinSmoothBounded(
            mc.vertices,
            mc.indices,
            settings.smoothIterations,
            grid.cellSize,
            grid.layerThickness,
          )
        : mc.vertices
    solid = { vertices: smoothed, indices: mc.indices }
  }

  const inputTriangles = indices ? indices.length / 3 : vertices.length / 9
  const report: ConvertReport = {
    inputTriangles,
    outputTriangles: solid.indices.length / 3,
    outputVertices: solid.vertices.length / 3,
    occupiedVoxels: vox.occupiedVoxels,
    grid: { nx: grid.nx, ny: grid.ny, nz: grid.nz },
    openRowFraction: vox.openRowFraction,
    watertight: isWatertight(solid.indices),
    aabb: computeAABB(solid.vertices),
  }

  return { solid, report }
}

/**
 * Closed-2-manifold check: an indexed surface is watertight iff every
 * undirected edge is used by exactly two triangles.  Cheap O(triangles) hash
 * pass — the honest signal that the reconstruction actually sealed the volume.
 */
export function isWatertight(indices: Uint32Array): boolean {
  if (indices.length === 0) return false
  const edgeCount = new Map<number, number>()
  const key = (a: number, b: number) => {
    const lo = a < b ? a : b
    const hi = a < b ? b : a
    // Pack two 26-bit vertex ids into a JS-safe integer key.
    return lo * 0x4000000 + hi
  }
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2]
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const k = key(x, y)
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1)
    }
  }
  for (const n of edgeCount.values()) {
    if (n !== 2) return false
  }
  return true
}

/** Rough auto-default for grid resolution given a model's size (unused knob helper). */
export function suggestResolution(vertices: Float32Array): number {
  const extent = aabbMaxExtent(computeAABB(vertices))
  return extent > 0 ? 48 : 48
}
