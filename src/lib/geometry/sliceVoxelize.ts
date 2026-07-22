import {
  type GridMeta,
  layerCenterW,
  voxelIndex,
  worldToFrame,
} from './sliceFrame'

/**
 * Per-layer intersection segments in frame (u, v) coords, packed as
 * `[u1, v1, u2, v2, …]`.  One entry per layer (`length === grid.nz`).  Used both
 * to scanline-fill the occupancy grid and to draw the smooth cross-section
 * contours in the viewport.
 */
export type LayerSegments = Float32Array[]

export interface VoxelizeResult {
  occupancy: Uint8Array
  layerSegments: LayerSegments
  /** Occupied voxel count (cheap to keep here for the report). */
  occupiedVoxels: number
  /**
   * Fraction of scanned rows that had an odd number of contour crossings — a
   * direct signal that the input mesh is not watertight (an open surface can't
   * be reliably filled).  0 for a clean watertight solid.
   */
  openRowFraction: number
}

/** Resolve the i-th triangle's three vertex offsets into the position buffer. */
function triVerts(
  vertices: Float32Array,
  indices: Uint32Array | null,
  t: number,
): [number, number, number] {
  if (indices) {
    return [indices[t * 3] * 3, indices[t * 3 + 1] * 3, indices[t * 3 + 2] * 3]
  }
  return [t * 9, t * 9 + 3, t * 9 + 6]
}

/**
 * Slice a triangle mesh into the grid's layers and rasterise each cross-section
 * into the occupancy array via even-odd scanline fill.
 *
 * Self-contained (no BVH): for each layer plane we intersect the straddling
 * triangles to get contour segments, then fill the cells between sorted
 * crossings on every grid row.  Robust as far as the mesh is watertight; an
 * open mesh surfaces as `openRowFraction > 0` so the caller can warn.
 */
export function sliceAndVoxelize(
  vertices: Float32Array,
  indices: Uint32Array | null,
  grid: GridMeta,
): VoxelizeResult {
  const { axis, nx, ny, nz, cellSize, origin } = grid
  const occupancy = new Uint8Array(nx * ny * nz)
  const triCount = indices ? indices.length / 3 : vertices.length / 9

  // Bucket contour segments per layer.  We collect into plain arrays first, then
  // freeze into typed arrays (segments-per-layer count is unknown up front).
  const buckets: number[][] = Array.from({ length: nz }, () => [])

  const wMinGrid = origin[2]
  const invThickness = 1 / grid.layerThickness

  // Scratch for the three vertices in frame coords.
  for (let t = 0; t < triCount; t++) {
    const [oa, ob, oc] = triVerts(vertices, indices, t)
    const A = worldToFrame(vertices[oa], vertices[oa + 1], vertices[oa + 2], axis)
    const B = worldToFrame(vertices[ob], vertices[ob + 1], vertices[ob + 2], axis)
    const C = worldToFrame(vertices[oc], vertices[oc + 1], vertices[oc + 2], axis)

    const wLo = Math.min(A[2], B[2], C[2])
    const wHi = Math.max(A[2], B[2], C[2])
    if (wHi < wMinGrid) continue

    // Layers whose centre falls inside [wLo, wHi].  centre_k = wMin+(k+0.5)*th.
    let k0 = Math.ceil((wLo - wMinGrid) * invThickness - 0.5)
    let k1 = Math.floor((wHi - wMinGrid) * invThickness - 0.5)
    if (k0 < 0) k0 = 0
    if (k1 > nz - 1) k1 = nz - 1

    for (let k = k0; k <= k1; k++) {
      const wk = layerCenterW(grid, k)
      // Classify by side of the plane; strict `< 0` keeps on-plane verts on the
      // upper side so a crossing triangle always yields exactly two points.
      const da = A[2] - wk
      const db = B[2] - wk
      const dc = C[2] - wk
      const sa = da < 0
      const sb = db < 0
      const sc = dc < 0
      if (sa === sb && sb === sc) continue // all one side → no crossing

      const pts: number[] = []
      pushCross(pts, A, B, da, db, sa, sb)
      pushCross(pts, B, C, db, dc, sb, sc)
      pushCross(pts, C, A, dc, da, sc, sa)
      if (pts.length >= 4) {
        const bucket = buckets[k]
        bucket.push(pts[0], pts[1], pts[2], pts[3])
      }
    }
  }

  const layerSegments: LayerSegments = new Array(nz)
  let occupied = 0
  let openRows = 0
  let rowsWithCrossings = 0
  const crossings: number[] = []

  for (let k = 0; k < nz; k++) {
    const seg = Float32Array.from(buckets[k])
    layerSegments[k] = seg
    const layerBase = k * nx * ny
    for (let j = 0; j < ny; j++) {
      const vRow = origin[1] + (j + 0.5) * cellSize
      crossings.length = 0
      for (let s = 0; s < seg.length; s += 4) {
        const u1 = seg[s], v1 = seg[s + 1], u2 = seg[s + 2], v2 = seg[s + 3]
        // Half-open span [min,max) so a vertex shared by two segments counts once.
        if ((v1 <= vRow) !== (v2 <= vRow)) {
          const u = u1 + ((vRow - v1) / (v2 - v1)) * (u2 - u1)
          crossings.push(u)
        }
      }
      if (crossings.length === 0) continue
      rowsWithCrossings++
      if (crossings.length % 2 === 1) {
        openRows++
        continue // ambiguous fill on an open contour — skip rather than guess
      }
      crossings.sort((a, b) => a - b)
      const rowBase = layerBase + j * nx
      for (let m = 0; m + 1 < crossings.length; m += 2) {
        const uA = crossings[m]
        const uB = crossings[m + 1]
        let iStart = Math.ceil((uA - origin[0]) / cellSize - 0.5)
        let iEnd = Math.floor((uB - origin[0]) / cellSize - 0.5)
        if (iStart < 0) iStart = 0
        if (iEnd > nx - 1) iEnd = nx - 1
        for (let i = iStart; i <= iEnd; i++) {
          const idx = rowBase + i
          if (occupancy[idx] === 0) {
            occupancy[idx] = 1
            occupied++
          }
        }
      }
    }
  }

  return {
    occupancy,
    layerSegments,
    occupiedVoxels: occupied,
    openRowFraction: rowsWithCrossings === 0 ? 0 : openRows / rowsWithCrossings,
  }
}

/** Append the (u, v) crossing point of edge P→Q to `out` when the edge straddles. */
function pushCross(
  out: number[],
  P: [number, number, number],
  Q: [number, number, number],
  dP: number,
  dQ: number,
  sP: boolean,
  sQ: boolean,
): void {
  if (sP === sQ) return
  const t = dP / (dP - dQ)
  out.push(P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1]))
}

/**
 * Map a region's representative world-space points to the voxels they fall in,
 * returning the set of occupied-voxel offsets touched.  Points that land in an
 * empty cell search their 3×3×3 neighbourhood so a region sitting just off a
 * filled cell centre still attaches to the body (needed for the load-path
 * check, where region surfaces hug the boundary).
 */
export function voxelsForPoints(
  points: Float32Array,
  grid: GridMeta,
  occupancy: Uint8Array,
): Set<number> {
  const { axis, nx, ny, nz, cellSize, origin, layerThickness } = grid
  const out = new Set<number>()
  for (let p = 0; p < points.length; p += 3) {
    const [u, v, w] = worldToFrame(points[p], points[p + 1], points[p + 2], axis)
    const i0 = Math.floor((u - origin[0]) / cellSize)
    const j0 = Math.floor((v - origin[1]) / cellSize)
    const k0 = Math.floor((w - origin[2]) / layerThickness)
    let best = -1
    for (let dk = -1; dk <= 1 && best < 0; dk++) {
      for (let dj = -1; dj <= 1 && best < 0; dj++) {
        for (let di = -1; di <= 1 && best < 0; di++) {
          const i = i0 + di, j = j0 + dj, k = k0 + dk
          if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue
          const idx = voxelIndex(grid, i, j, k)
          if (occupancy[idx]) best = idx
        }
      }
    }
    if (best >= 0) out.add(best)
  }
  return out
}
