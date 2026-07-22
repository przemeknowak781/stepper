import { computeAABB, aabbMaxExtent, type AABB } from './boundingBox'
import { computeGridFromVertices, type GridMeta, type SliceAxis } from './sliceFrame'
import { sliceAndVoxelize } from './sliceVoxelize'
import { occupancyToSolid, taubinSmoothBounded, type SolidMesh } from './slicedSolid'
import { marchingCubesFromVoxelDensity } from './marchingCubes'
import { planarizeMesh, type PlanarBrep } from './planarize'

/**
 * How the input surface is turned into an engineering solid:
 *
 * - `faithful` — merge the input's coplanar triangles into large planar faces
 *                (mesh → B-rep) with NO resampling.  A box stays an exact box
 *                of 6 faces; the STEP is economical and bit-identical to the
 *                input.  Needs a clean closed manifold; a torn input auto-falls
 *                back to `voxel` reconstruction first, then planarises.
 * - `voxel`    — reconstruct via the voxel slicer (repairs any input), then
 *                planarise the cuberille shell so the axis-aligned faces merge
 *                into a few big rectangles.  Blocky but watertight & economical.
 * - `smooth`   — marching-cubes iso-surface + feature-preserving Taubin
 *                smoothing.  Rounded, organic; STEP is a fine triangle mesh
 *                (no planar merging possible on a curved surface).
 */
export type ConvertMethod = 'faithful' | 'voxel' | 'smooth'

export interface ConvertSettings {
  method: ConvertMethod
  /** Slicing axis for the voxel grid (voxel/smooth, and faithful's repair fallback). */
  axis: SliceAxis
  /** In-plane grid density for reconstruction methods. */
  resolution: number
  /** Number of layers along the slicing axis for reconstruction methods. */
  slices: number
  /** Taubin smoothing iterations (smooth method only). */
  smoothIterations: number
  /**
   * Coplanar-merge angle tolerance (degrees) for faithful/voxel planarisation.
   * Small = faithful (a chamfer stays its own face); larger merges gently
   * curved regions into fewer planar faces.
   */
  planarToleranceDeg: number
}

export const DEFAULT_CONVERT_SETTINGS: ConvertSettings = {
  method: 'faithful',
  axis: 'z',
  resolution: 48,
  slices: 48,
  smoothIterations: 8,
  planarToleranceDeg: 1,
}

export interface ConvertReport {
  inputTriangles: number
  /** Triangles in the display/STL solid. */
  outputTriangles: number
  outputVertices: number
  /** Planar B-rep face count for STEP (undefined when STEP falls back to triangles). */
  brepFaces?: number
  brepEdges?: number
  brepVertices?: number
  occupiedVoxels: number
  grid?: { nx: number; ny: number; nz: number }
  openRowFraction: number
  watertight: boolean
  /** True when the output geometry equals the input surface exactly (faithful path). */
  faithful: boolean
  /** True when the input had to be voxel-reconstructed (not manifold). */
  reconstructed: boolean
  aabb: AABB
}

export interface ConvertResult {
  /** Triangulated solid for the viewport + STL export. */
  solid: SolidMesh
  /** Economical planar B-rep for STEP export (null → STEP uses `solid` triangles). */
  brep: PlanarBrep | null
  report: ConvertReport
}

function occupancyToField(occupancy: Uint8Array): Float32Array {
  const field = new Float32Array(occupancy.length)
  for (let i = 0; i < occupancy.length; i++) field[i] = occupancy[i]
  return field
}

/** Voxel-reconstruct an arbitrary (possibly broken) mesh into a watertight cuberille solid. */
function voxelReconstruct(
  vertices: Float32Array,
  indices: Uint32Array | null,
  settings: ConvertSettings,
): { solid: SolidMesh; grid: GridMeta; occupiedVoxels: number; openRowFraction: number } {
  const grid = computeGridFromVertices(vertices, settings.axis, settings.slices, settings.resolution)
  const vox = sliceAndVoxelize(vertices, indices, grid)
  return {
    solid: occupancyToSolid(vox.occupancy, grid),
    grid,
    occupiedVoxels: vox.occupiedVoxels,
    openRowFraction: vox.openRowFraction,
  }
}

/**
 * Convert an arbitrary input triangle mesh into a clean engineering solid plus
 * an economical planar B-rep for STEP.
 *
 * The default `faithful` path is reconstruction-free: it merges the input's
 * coplanar triangles into big planar faces, so a simple mesh yields a simple,
 * exact solid (a box → 6 faces) rather than the heavy blob a pure voxel remesh
 * produces.  Only when the input is not a clean closed manifold do we fall back
 * to voxel reconstruction to seal it, then planarise that.
 */
export function convertMeshToSolid(
  vertices: Float32Array,
  indices: Uint32Array | null,
  settings: ConvertSettings,
): ConvertResult {
  const inputTriangles = indices ? indices.length / 3 : vertices.length / 9

  if (settings.method === 'faithful') {
    const planar = planarizeMesh(vertices, indices, { angleToleranceDeg: settings.planarToleranceDeg })
    if (planar.manifold && planar.brep) {
      // Exact: the display solid is the welded input; STEP uses merged faces.
      const solid = brepToTriangles(planar.brep)
      return {
        solid,
        brep: planar.brep,
        report: {
          inputTriangles,
          outputTriangles: solid.indices.length / 3,
          outputVertices: solid.vertices.length / 3,
          brepFaces: planar.faceCount,
          brepEdges: planar.edgeCount,
          brepVertices: planar.vertexCount,
          occupiedVoxels: 0,
          openRowFraction: 0,
          watertight: true,
          faithful: true,
          reconstructed: false,
          aabb: computeAABB(solid.vertices),
        },
      }
    }
    // Not a clean manifold → reconstruct, then planarise the repaired shell.
    const rec = voxelReconstruct(vertices, indices, settings)
    const planarRec = planarizeMesh(rec.solid.vertices, rec.solid.indices, {
      angleToleranceDeg: settings.planarToleranceDeg,
    })
    return {
      solid: rec.solid,
      brep: planarRec.brep,
      report: {
        inputTriangles,
        outputTriangles: rec.solid.indices.length / 3,
        outputVertices: rec.solid.vertices.length / 3,
        brepFaces: planarRec.faceCount || undefined,
        brepEdges: planarRec.edgeCount || undefined,
        brepVertices: planarRec.vertexCount || undefined,
        occupiedVoxels: rec.occupiedVoxels,
        grid: { nx: rec.grid.nx, ny: rec.grid.ny, nz: rec.grid.nz },
        openRowFraction: rec.openRowFraction,
        watertight: isWatertight(rec.solid.indices),
        faithful: false,
        reconstructed: true,
        aabb: computeAABB(rec.solid.vertices),
      },
    }
  }

  if (settings.method === 'voxel') {
    const rec = voxelReconstruct(vertices, indices, settings)
    const planarRec = planarizeMesh(rec.solid.vertices, rec.solid.indices, {
      angleToleranceDeg: settings.planarToleranceDeg,
    })
    return {
      solid: rec.solid,
      brep: planarRec.brep,
      report: {
        inputTriangles,
        outputTriangles: rec.solid.indices.length / 3,
        outputVertices: rec.solid.vertices.length / 3,
        brepFaces: planarRec.faceCount || undefined,
        brepEdges: planarRec.edgeCount || undefined,
        brepVertices: planarRec.vertexCount || undefined,
        occupiedVoxels: rec.occupiedVoxels,
        grid: { nx: rec.grid.nx, ny: rec.grid.ny, nz: rec.grid.nz },
        openRowFraction: rec.openRowFraction,
        watertight: isWatertight(rec.solid.indices),
        faithful: false,
        reconstructed: true,
        aabb: computeAABB(rec.solid.vertices),
      },
    }
  }

  // smooth
  const grid = computeGridFromVertices(vertices, settings.axis, settings.slices, settings.resolution)
  const vox = sliceAndVoxelize(vertices, indices, grid)
  const field = occupancyToField(vox.occupancy)
  const mc = marchingCubesFromVoxelDensity(field, grid, 0.5)
  const smoothed =
    settings.smoothIterations > 0
      ? taubinSmoothBounded(mc.vertices, mc.indices, settings.smoothIterations, grid.cellSize, grid.layerThickness)
      : mc.vertices
  const solid: SolidMesh = { vertices: smoothed, indices: mc.indices }
  return {
    solid,
    brep: null,
    report: {
      inputTriangles,
      outputTriangles: solid.indices.length / 3,
      outputVertices: solid.vertices.length / 3,
      occupiedVoxels: vox.occupiedVoxels,
      grid: { nx: grid.nx, ny: grid.ny, nz: grid.nz },
      openRowFraction: vox.openRowFraction,
      watertight: isWatertight(solid.indices),
      faithful: false,
      reconstructed: true,
      aabb: computeAABB(solid.vertices),
    },
  }
}

/**
 * Fan-triangulate a planar B-rep back into a triangle mesh for display/STL.
 * Each face's outer loop is fanned from its first vertex; holes are ignored for
 * the display mesh (rare in practice and only cosmetic in the viewport).
 */
export function brepToTriangles(brep: PlanarBrep): SolidMesh {
  const indices: number[] = []
  for (const face of brep.faces) {
    const outer = face.loops[0]
    if (!outer || outer.length < 3) continue
    for (let i = 1; i + 1 < outer.length; i++) {
      indices.push(outer[0], outer[i], outer[i + 1])
    }
  }
  return { vertices: brep.vertices.slice(), indices: Uint32Array.from(indices) }
}

/**
 * Closed-2-manifold check: an indexed surface is watertight iff every
 * undirected edge is used by exactly two triangles.
 */
export function isWatertight(indices: Uint32Array): boolean {
  if (indices.length === 0) return false
  const edgeCount = new Map<number, number>()
  const key = (a: number, b: number) => {
    const lo = a < b ? a : b
    const hi = a < b ? b : a
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
