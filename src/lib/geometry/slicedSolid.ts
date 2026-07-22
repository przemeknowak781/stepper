import { type GridMeta, frameToWorld } from './sliceFrame'
import { HEX_FACES as FACES } from './hexFaces'

export interface SolidMesh {
  vertices: Float32Array
  indices: Uint32Array
}

/**
 * Reconstruct a watertight surface mesh from the occupancy grid (cuberille):
 * every occupied voxel contributes a quad for each face whose neighbour is
 * empty or out of bounds.  Shared corners are welded (one vertex per used grid
 * corner), so the result is a closed, manifold solid — exactly the discretised
 * model the slicer/solver sees, as a real mesh.
 */
export function occupancyToSolid(occupancy: Uint8Array, grid: GridMeta): SolidMesh {
  const { nx, ny, nz, cellSize, layerThickness, origin, axis } = grid
  const nxy = nx * ny
  const cornersPerRow = nx + 1
  const cornersPerLayer = cornersPerRow * (ny + 1)

  const cornerId = (i: number, j: number, k: number) => k * cornersPerLayer + j * cornersPerRow + i
  const vertexOf = new Map<number, number>()
  const verts: number[] = []
  const indices: number[] = []

  const resolve = (i: number, j: number, k: number): number => {
    const key = cornerId(i, j, k)
    const existing = vertexOf.get(key)
    if (existing !== undefined) return existing
    const u = origin[0] + i * cellSize
    const v = origin[1] + j * cellSize
    const w = origin[2] + k * layerThickness
    const [x, y, z] = frameToWorld(u, v, w, axis)
    const id = verts.length / 3
    verts.push(x, y, z)
    vertexOf.set(key, id)
    return id
  }

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (occupancy[k * nxy + j * nx + i] === 0) continue
        for (const face of FACES) {
          const ni = i + face.d[0]
          const nj = j + face.d[1]
          const nk = k + face.d[2]
          const neighbourSolid =
            ni >= 0 && ni < nx && nj >= 0 && nj < ny && nk >= 0 && nk < nz &&
            occupancy[nk * nxy + nj * nx + ni] === 1
          if (neighbourSolid) continue // internal face — skip
          const q = face.quad
          const v0 = resolve(i + q[0][0], j + q[0][1], k + q[0][2])
          const v1 = resolve(i + q[1][0], j + q[1][1], k + q[1][2])
          const v2 = resolve(i + q[2][0], j + q[2][1], k + q[2][2])
          const v3 = resolve(i + q[3][0], j + q[3][1], k + q[3][2])
          indices.push(v0, v1, v2, v0, v2, v3)
        }
      }
    }
  }

  return { vertices: Float32Array.from(verts), indices: Uint32Array.from(indices) }
}

/** Undirected vertex adjacency built from triangle edges (shared by every smoothing pass below). */
function buildVertexAdjacency(nV: number, indices: Uint32Array): Set<number>[] {
  const adj: Set<number>[] = Array.from({ length: nV }, () => new Set<number>())
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2]
    adj[a].add(b); adj[a].add(c)
    adj[b].add(a); adj[b].add(c)
    adj[c].add(a); adj[c].add(b)
  }
  return adj
}

/** One Laplacian relaxation step: `v += factor * (average(neighbours) - v)`. Negative `factor` is the Taubin "shrink-back" pass. */
function laplacianPass(cur: Float32Array, adj: Set<number>[], nV: number, factor: number) {
  const next = new Float32Array(cur.length)
  for (let v = 0; v < nV; v++) {
    const neighbours = adj[v]
    const base = v * 3
    if (neighbours.size === 0) {
      next[base] = cur[base]
      next[base + 1] = cur[base + 1]
      next[base + 2] = cur[base + 2]
      continue
    }
    let sx = 0, sy = 0, sz = 0
    for (const n of neighbours) {
      sx += cur[n * 3]; sy += cur[n * 3 + 1]; sz += cur[n * 3 + 2]
    }
    const inv = 1 / neighbours.size
    next[base] = cur[base] + factor * (sx * inv - cur[base])
    next[base + 1] = cur[base + 1] + factor * (sy * inv - cur[base + 1])
    next[base + 2] = cur[base + 2] + factor * (sz * inv - cur[base + 2])
  }
  return next
}

/**
 * Laplacian smoothing: nudge each vertex toward the average of its edge
 * neighbours, `iterations` times.  Rounds off the cuberille staircase into the
 * organic faceted look without changing topology.  `lambda` ∈ (0,1] is the
 * per-step strength.
 */
export function laplacianSmooth(
  vertices: Float32Array,
  indices: Uint32Array,
  iterations = 2,
  lambda = 0.5,
): Float32Array {
  const nV = vertices.length / 3
  if (iterations <= 0 || nV === 0) return vertices.slice()
  const adj = buildVertexAdjacency(nV, indices)
  let cur = vertices.slice()
  for (let iter = 0; iter < iterations; iter++) cur = laplacianPass(cur, adj, nV, lambda)
  return cur
}

/**
 * Taubin (λ|μ) smoothing: alternates a positive Laplacian pass (`lambda`,
 * shrinks/blurs) with a negative one (`mu`, expands back) each iteration.
 * Removes the same high-frequency stair-step noise as plain
 * {@link laplacianSmooth} without its volume-shrinkage — the two passes'
 * opposing low-pass/high-pass frequency response cancels out the net shrink
 * while still damping noise, which is why marching-cubes output (used for
 * SIMP's export-time solid, docs/SIMP_PLAN.md §5) uses this instead of plain
 * Laplacian. Requires `mu < -lambda` (the standard Taubin stability
 * condition) — the default pair is Taubin's own published values.
 */
export function taubinSmooth(
  vertices: Float32Array,
  indices: Uint32Array,
  iterations = 10,
  lambda = 0.5,
  mu = -0.53,
  maxOffset?: number,
): Float32Array {
  const nV = vertices.length / 3
  if (iterations <= 0 || nV === 0) return vertices.slice()
  const adj = buildVertexAdjacency(nV, indices)
  let cur = vertices.slice()
  for (let iter = 0; iter < iterations; iter++) {
    cur = laplacianPass(cur, adj, nV, lambda)
    cur = laplacianPass(cur, adj, nV, mu)
    if (maxOffset !== undefined) clampDisplacement(cur, vertices, maxOffset)
  }
  return cur
}

/**
 * Pulls every vertex of `cur` back inside a `maxOffset`-radius ball around
 * its ORIGINAL position (in place). This is what makes the bounded variant
 * below honest for structural results: unconstrained Laplacian-family
 * smoothing thins slender members from BOTH sides, and a strut a single
 * voxel wide — often exactly the load path SIMP fought to keep — can be
 * pinched to a sliver or severed outright. With the clamp applied after
 * every λ|μ pair, no cross-section can lose more than `2*maxOffset`.
 */
function clampDisplacement(cur: Float32Array, original: Float32Array, maxOffset: number): void {
  for (let v = 0; v < cur.length; v += 3) {
    const dx = cur[v] - original[v]
    const dy = cur[v + 1] - original[v + 1]
    const dz = cur[v + 2] - original[v + 2]
    const d = Math.hypot(dx, dy, dz)
    if (d <= maxOffset) continue
    const s = maxOffset / d
    cur[v] = original[v] + dx * s
    cur[v + 1] = original[v + 1] + dy * s
    cur[v + 2] = original[v + 2] + dz * s
  }
}

/**
 * The fraction of the smaller voxel dimension a smoothed vertex may move.
 * 0.25 bounds worst-case thinning of a one-voxel-wide member to half its
 * width (2 × 0.25) — it stays a load-bearing connection — while still
 * damping the ±0.5-voxel marching-cubes staircase visibly. Tightening it
 * further trades smoothness for fidelity; loosening it starts falsifying
 * slender members.
 */
export const SMOOTH_MAX_OFFSET_FRACTION = 0.25

/**
 * Feature-preserving Taubin smoothing for voxel-derived surfaces: identical
 * to {@link taubinSmooth} but every vertex is hard-clamped to
 * SMOOTH_MAX_OFFSET_FRACTION of the smaller voxel dimension around where
 * marching cubes put it. Use THIS for anything whose geometry feeds a
 * structural judgement (SIMP export, FEM surface preview) — see
 * clampDisplacement for why unbounded smoothing falsifies thin members.
 */
export function taubinSmoothBounded(
  vertices: Float32Array,
  indices: Uint32Array,
  iterations: number,
  cellSize: number,
  layerThickness: number,
): Float32Array {
  return taubinSmooth(vertices, indices, iterations, 0.5, -0.53, SMOOTH_MAX_OFFSET_FRACTION * Math.min(cellSize, layerThickness))
}
