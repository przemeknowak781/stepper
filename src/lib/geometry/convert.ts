import { computeAABB, aabbMaxExtent, type AABB } from './boundingBox'
import { type GridMeta, type SliceAxis } from './sliceFrame'
import { occupancyToSolid, taubinSmoothBounded, type SolidMesh } from './slicedSolid'
import { marchingCubesFromVoxelDensity } from './marchingCubes'
import { planarizeMesh, type PlanarBrep } from './planarize'
import { triangulateFace } from './triangulate'
import { repairMesh, type RepairReport } from './meshRepair'
import { solidifyToOccupancy, paddedGridFor } from './solidify'

/**
 * How the input surface is turned into an engineering solid:
 *
 * - `faithful` — repair the input to a clean closed manifold (weld, dedup,
 *                consistent orientation, small-hole fill) and merge its coplanar
 *                triangles into large planar faces. No resampling: exact,
 *                economical. If it can't be made manifold, it auto-solidifies
 *                (below) and planarises that.
 * - `voxel`    — robust solidification of ANY mesh (surface voxelisation +
 *                flood-fill inside/outside, immune to holes/flipped normals),
 *                cuberille shell, then planarised.
 * - `smooth`   — solidify, then a marching-cubes iso-surface + Taubin smoothing.
 */
export type ConvertMethod = 'faithful' | 'voxel' | 'smooth'

export interface ConvertSettings {
  method: ConvertMethod
  axis: SliceAxis
  resolution: number
  slices: number
  smoothIterations: number
  planarToleranceDeg: number
  /**
   * Crack-sealing radius (voxels) for solidification: bridges holes up to this
   * many voxels wide so the flood fill can't leak into a hollow model. 0 = off.
   */
  seal: number
}

export const DEFAULT_CONVERT_SETTINGS: ConvertSettings = {
  method: 'faithful',
  axis: 'z',
  resolution: 64,
  slices: 64,
  smoothIterations: 8,
  planarToleranceDeg: 1,
  seal: 1,
}

export interface ConvertReport {
  inputTriangles: number
  outputTriangles: number
  outputVertices: number
  brepFaces?: number
  brepEdges?: number
  brepVertices?: number
  occupiedVoxels: number
  grid?: { nx: number; ny: number; nz: number }
  openRowFraction: number
  watertight: boolean
  faithful: boolean
  reconstructed: boolean
  /** Manifold-repair stats when the faithful path ran (undefined for pure voxel/smooth). */
  repair?: RepairReport
  aabb: AABB
}

export interface ConvertResult {
  solid: SolidMesh
  brep: PlanarBrep | null
  report: ConvertReport
}

function occupancyToField(occupancy: Uint8Array): Float32Array {
  const field = new Float32Array(occupancy.length)
  for (let i = 0; i < occupancy.length; i++) field[i] = occupancy[i]
  return field
}

/** Robustly voxel-solidify a mesh into a watertight cuberille solid. */
function solidReconstruct(
  vertices: Float32Array,
  indices: Uint32Array | null,
  settings: ConvertSettings,
): { solid: SolidMesh; grid: GridMeta; occupiedVoxels: number } {
  const grid = paddedGridFor(vertices, settings.axis, settings.slices, settings.resolution)
  const { occupancy, occupiedVoxels } = solidifyToOccupancy(vertices, indices, grid, settings.seal)
  return { solid: occupancyToSolid(occupancy, grid), grid, occupiedVoxels }
}

/**
 * Convert an arbitrary input triangle mesh into a clean engineering solid plus
 * an economical planar B-rep for STEP.
 */
export function convertMeshToSolid(
  vertices: Float32Array,
  indices: Uint32Array | null,
  settings: ConvertSettings,
): ConvertResult {
  const inputTriangles = indices ? indices.length / 3 : vertices.length / 9

  if (settings.method === 'faithful') {
    const repaired = repairMesh(vertices, indices)
    if (repaired.report.closed) {
      const planar = planarizeMesh(repaired.vertices, repaired.indices, {
        angleToleranceDeg: settings.planarToleranceDeg,
      })
      if (planar.manifold && planar.brep) {
        const solid: SolidMesh = { vertices: repaired.vertices, indices: repaired.indices }
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
            repair: repaired.report,
            aabb: computeAABB(solid.vertices),
          },
        }
      }
    }
    // Could not repair to a manifold → robust solidify, then planarise.
    const rec = solidReconstruct(vertices, indices, settings)
    const planarRec = planarizeMesh(rec.solid.vertices, rec.solid.indices, {
      angleToleranceDeg: settings.planarToleranceDeg,
    })
    return reconstructedResult(inputTriangles, rec, planarRec, repaired.report)
  }

  if (settings.method === 'voxel') {
    const rec = solidReconstruct(vertices, indices, settings)
    const planarRec = planarizeMesh(rec.solid.vertices, rec.solid.indices, {
      angleToleranceDeg: settings.planarToleranceDeg,
    })
    return reconstructedResult(inputTriangles, rec, planarRec)
  }

  // smooth
  const grid = paddedGridFor(vertices, settings.axis, settings.slices, settings.resolution)
  const { occupancy, occupiedVoxels } = solidifyToOccupancy(vertices, indices, grid, settings.seal)
  const field = occupancyToField(occupancy)
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
      occupiedVoxels,
      grid: { nx: grid.nx, ny: grid.ny, nz: grid.nz },
      openRowFraction: 0,
      watertight: isWatertight(solid.indices),
      faithful: false,
      reconstructed: true,
      aabb: computeAABB(solid.vertices),
    },
  }
}

function reconstructedResult(
  inputTriangles: number,
  rec: { solid: SolidMesh; grid: GridMeta; occupiedVoxels: number },
  planarRec: ReturnType<typeof planarizeMesh>,
  repair?: RepairReport,
): ConvertResult {
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
      openRowFraction: 0,
      watertight: isWatertight(rec.solid.indices),
      faithful: false,
      reconstructed: true,
      repair,
      aabb: computeAABB(rec.solid.vertices),
    },
  }
}

/**
 * Triangulate a planar B-rep into a display/STL mesh via per-face ear clipping
 * (handles non-convex outlines and holes) — no overlapping/flipped triangles.
 */
export function brepToTriangles(brep: PlanarBrep): SolidMesh {
  const indices: number[] = []
  for (const face of brep.faces) {
    for (const tri of triangulateFace(brep.vertices, face.loops, face.normal)) {
      indices.push(tri[0], tri[1], tri[2])
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
