import type { GridMeta } from './sliceFrame'
import { frameToWorld } from './sliceFrame'
import { EDGE_TABLE, TRI_TABLE } from './marchingCubesTables'

export interface MarchingCubesMesh {
  vertices: Float32Array
  indices: Uint32Array
}

// Cube corner numbering shared with marchingCubesTables.ts:
// 0:(0,0,0) 1:(1,0,0) 2:(1,1,0) 3:(0,1,0) 4:(0,0,1) 5:(1,0,1) 6:(1,1,1) 7:(0,1,1)
const CORNER_OFFSETS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
]

// Edge i connects these two corners (matches marchingCubesTables.ts's doc comment).
const EDGE_CORNERS: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
]

/**
 * Extracts a smooth isosurface from a per-voxel density field on the SIMP
 * grid (docs/SIMP_PLAN.md §5): unlike the live viewport preview
 * (SimpPreview.tsx), which renders the raw stair-stepped voxel boundary
 * directly, this is the export-time path that turns density into a printable
 * shape without axis-aligned terracing.
 *
 * Marching cubes needs a scalar value at each grid CORNER, but SIMP produces
 * one density value per grid CELL (element). Each corner's value is the mean
 * of its up-to-8 adjacent cells (missing/out-of-grid neighbours count as 0,
 * i.e. void) — a standard technique for smoothing voxel/density data into a
 * continuous field before iso-surfacing, and it naturally closes the surface
 * at the grid boundary since exterior neighbours are always 0.
 *
 * `voxelDensity` must be indexed exactly like the slicer's occupancy grid —
 * `k*nx*ny + j*nx + i` — with 0 for unoccupied (void) voxels, matching
 * hexMesh.ts's `elementVoxel` mapping.
 *
 * Uses the classic (Lorensen & Cline) case table, not the face-disambiguated
 * MC33 variant — like any implementation of that table, an input with large
 * flat plateaus of EXACTLY-tied corner values (e.g. a hand-built binary
 * 0/1 occupancy field) can produce topologically ambiguous cells and a
 * non-manifold result at those plateaus. Real SIMP density output is
 * continuous per-element — optimizer noise means adjacent elements
 * essentially never land on the exact same float — so this doesn't occur in
 * practice; see tests/unit/marchingCubes.test.ts for both cases.
 */
export function marchingCubesFromVoxelDensity(
  voxelDensity: ArrayLike<number>,
  grid: GridMeta,
  isoLevel: number,
): MarchingCubesMesh {
  const { nx, ny, nz, cellSize, layerThickness, origin, axis } = grid
  const nxy = nx * ny

  // The marching-cubes lattice samples the field AT VOXEL CENTERS (the dual
  // grid), padded with one layer of zeros so the surface closes around the
  // outermost voxels. The earlier corner-averaged lattice (mean of the up to
  // 8 voxels around each grid corner) was an implicit low-pass prefilter
  // that ERASED one-voxel-wide features outright: a 1×1 strut's corners all
  // averaged ≤ 2/8 = 0.25 < the 0.5 iso, so thin load-bearing connections —
  // often exactly the members SIMP fought hardest to keep — vanished before
  // smoothing even ran. Center sampling preserves them: the strut's own
  // center is its full density, and the iso crossing lands halfway to its
  // empty neighbours.
  const cnx = nx + 2, cny = ny + 2, cnz = nz + 2
  const cnxy = cnx * cny
  const cornerIndex = (i: number, j: number, k: number) => k * cnxy + j * cnx + i

  const corner = new Float32Array(cnx * cny * cnz)
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        corner[cornerIndex(i + 1, j + 1, k + 1)] = voxelDensity[k * nxy + j * nx + i] as number
      }
    }
  }

  const positions: number[] = []
  const indices: number[] = []
  // Dedup vertices by the (order-independent) pair of global corner ids the
  // interpolated point lies between, so adjacent cells sharing an edge reuse
  // the same vertex — required for a watertight/manifold output mesh.
  const vertexCache = new Map<string, number>()

  const cornerField = new Float32Array(8)
  const cornerGrid: [number, number, number][] = CORNER_OFFSETS.map(() => [0, 0, 0])

  for (let k = 0; k < cnz - 1; k++) {
    for (let j = 0; j < cny - 1; j++) {
      for (let i = 0; i < cnx - 1; i++) {
        let cubeindex = 0
        for (let c = 0; c < 8; c++) {
          const [ox, oy, oz] = CORNER_OFFSETS[c]
          const ci = i + ox, cj = j + oy, ck = k + oz
          cornerGrid[c][0] = ci
          cornerGrid[c][1] = cj
          cornerGrid[c][2] = ck
          const v = corner[cornerIndex(ci, cj, ck)]
          cornerField[c] = v
          if (v < isoLevel) cubeindex |= 1 << c
        }

        const bits = EDGE_TABLE[cubeindex]
        if (bits === 0) continue

        const edgeVertex = new Int32Array(12).fill(-1)
        for (let e = 0; e < 12; e++) {
          if (!(bits & (1 << e))) continue
          const [ca, cb] = EDGE_CORNERS[e]
          const pa = cornerGrid[ca], pb = cornerGrid[cb]
          const gA = cornerIndex(pa[0], pa[1], pa[2])
          const gB = cornerIndex(pb[0], pb[1], pb[2])
          const key = gA < gB ? `${gA}_${gB}` : `${gB}_${gA}`
          let vertexId = vertexCache.get(key)
          if (vertexId === undefined) {
            const fa = cornerField[ca], fb = cornerField[cb]
            const denom = fb - fa
            const t = Math.abs(denom) < 1e-9 ? 0.5 : (isoLevel - fa) / denom
            const tc = Math.min(1, Math.max(0, t))
            // Lattice index li maps to voxel (li-1)'s CENTER: li - 1 + 0.5.
            const u = origin[0] + (pa[0] + (pb[0] - pa[0]) * tc - 0.5) * cellSize
            const v = origin[1] + (pa[1] + (pb[1] - pa[1]) * tc - 0.5) * cellSize
            const w = origin[2] + (pa[2] + (pb[2] - pa[2]) * tc - 0.5) * layerThickness
            const [x, y, z] = frameToWorld(u, v, w, axis)
            vertexId = positions.length / 3
            positions.push(x, y, z)
            vertexCache.set(key, vertexId)
          }
          edgeVertex[e] = vertexId
        }

        const base = cubeindex * 16
        for (let t = 0; TRI_TABLE[base + t] !== -1; t += 3) {
          indices.push(
            edgeVertex[TRI_TABLE[base + t]],
            edgeVertex[TRI_TABLE[base + t + 1]],
            edgeVertex[TRI_TABLE[base + t + 2]],
          )
        }
      }
    }
  }

  return { vertices: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

/**
 * Expands the sparse `mesh.elements`/`elementVoxel` + per-element `density`
 * (SIMP's native shape) into the dense `nx*ny*nz` per-voxel field
 * {@link marchingCubesFromVoxelDensity} needs, filling unoccupied voxels
 * with 0 (void).
 */
export function densityToVoxelField(
  elementVoxel: ArrayLike<number>,
  density: ArrayLike<number>,
  grid: GridMeta,
): Float32Array {
  const field = new Float32Array(grid.nx * grid.ny * grid.nz)
  for (let e = 0; e < elementVoxel.length; e++) field[elementVoxel[e]] = density[e]
  return field
}
