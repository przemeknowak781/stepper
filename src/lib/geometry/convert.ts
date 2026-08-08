import { computeAABB, aabbMaxExtent, type AABB } from './boundingBox'
import { type GridMeta, type SliceAxis } from './sliceFrame'
import { occupancyToSolid, taubinSmoothBounded, type SolidMesh } from './slicedSolid'
import { marchingCubesFromVoxelDensity } from './marchingCubes'
import { planarizeMesh, type PlanarBrep } from './planarize'
import { triangulateFace } from './triangulate'
import { repairMesh, type RepairedMesh, type RepairReport } from './meshRepair'
import { solidifyToOccupancy, paddedGridFor } from './solidify'
import { diagnoseShell, thickenShell, type ShellDiagnosis } from './shell'

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
  /**
   * Wall to give a zero-thickness input surface, in model units. 0 means "not
   * set": a surface input is then reported as such rather than being solidified
   * into a plate one voxel thick, because there is no correct answer without
   * this number (see `shell.ts`).
   */
  shellThickness: number
}

export const DEFAULT_CONVERT_SETTINGS: ConvertSettings = {
  method: 'faithful',
  axis: 'z',
  resolution: 64,
  slices: 64,
  smoothIterations: 8,
  planarToleranceDeg: 1,
  seal: 1,
  shellThickness: 0,
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
  /** Present when the input is a surface rather than a solid. */
  shell?: ShellDiagnosis
  /** The wall actually applied to a surface input, in model units. */
  appliedThickness?: number
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

  // Repair BEFORE deciding whether this is a surface. The shell score is driven
  // by the open boundary, and a part can be one weld and a few broken faces away
  // from closed — 16 open edges out of 1728 is a defect, not a design intent.
  // Asking such a model for a wall thickness is asking for one it already has,
  // and then adding it a second time. If the repair closes the mesh there is
  // nothing to decide: a closed surface encloses a volume by definition.
  const repaired = repairMesh(vertices, indices)
  // A closed mesh scores 0 by definition, so this answers "shell" only for
  // surfaces the repair genuinely could not close.
  const shell = diagnoseShell(repaired.vertices, repaired.indices)

  // A surface has no solid form until someone says how thick it is. With a wall
  // supplied, thicken first and convert the resulting solid; without one, carry
  // on so the user sees something, but hand the diagnosis to the UI so the
  // one-voxel plate that comes out is labelled rather than passed off as the
  // conversion the user asked for.
  if (shell.isShell && settings.shellThickness > 0) {
    // Weld and orient first: an offset direction is meaningless while
    // neighbouring triangles disagree about which side is out. Hole filling has
    // to be off — a sheet's outer boundary reads as a 32-edge hole, and capping
    // it produces a closed surface of zero volume with no rim left to thicken.
    const welded = repairMesh(vertices, indices, { fillHoles: false })
    const walled = thickenShell(welded.vertices, welded.indices, settings.shellThickness)
    const result = convertCore(walled.vertices, walled.indices, settings, inputTriangles)
    result.report.shell = shell
    result.report.appliedThickness = settings.shellThickness
    return result
  }

  if (shell.isShell) {
    // No wall, so there is no solid to produce. Returning the one-voxel plate
    // the solidifier would build is worse than returning nothing: it looks like
    // a converted model and it is not one. The diagnosis goes back instead, and
    // the UI asks for the thickness.
    return {
      solid: { vertices: new Float32Array(0), indices: new Uint32Array(0) },
      brep: null,
      report: {
        inputTriangles,
        outputTriangles: 0,
        outputVertices: 0,
        occupiedVoxels: 0,
        openRowFraction: 0,
        watertight: false,
        faithful: false,
        reconstructed: false,
        shell,
        aabb: computeAABB(vertices),
      },
    }
  }

  return convertCore(repaired.vertices, repaired.indices, settings, inputTriangles, repaired)
}

function convertCore(
  vertices: Float32Array,
  indices: Uint32Array | null,
  settings: ConvertSettings,
  inputTriangles: number,
  prerepaired?: RepairedMesh,
): ConvertResult {
  if (settings.method === 'faithful') {
    const repaired = prerepaired ?? repairMesh(vertices, indices)
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
