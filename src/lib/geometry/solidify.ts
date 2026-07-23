import { type GridMeta, type SliceAxis, worldToFrame, computeGridFromVertices } from './sliceFrame'

/**
 * Fit a voxel grid to the mesh and pad it with an empty border of `pad` voxels
 * on every side.  The padding is essential for robust solidification: it
 * guarantees an all-empty outer shell for the outside flood to start from, and
 * keeps the model's (often axis-aligned) faces off the grid boundary so they
 * rasterise into interior voxels cleanly.
 */
export function paddedGridFor(
  vertices: Float32Array,
  axis: SliceAxis,
  slices: number,
  density: number,
  pad = 2,
): GridMeta {
  const base = computeGridFromVertices(vertices, axis, slices, density)
  // Extra half-voxel shift so axis-aligned model faces land at voxel CENTRES,
  // not on voxel boundaries — otherwise point samples on such a face floor
  // ambiguously to either side and scatter stray voxels (a wiggly shell).
  return {
    ...base,
    nx: base.nx + 2 * pad + 1,
    ny: base.ny + 2 * pad + 1,
    nz: base.nz + 2 * pad + 1,
    origin: [
      base.origin[0] - (pad + 0.5) * base.cellSize,
      base.origin[1] - (pad + 0.5) * base.cellSize,
      base.origin[2] - (pad + 0.5) * base.layerThickness,
    ],
  }
}

/**
 * Robust volume definition from an ARBITRARY (possibly broken, non-manifold,
 * self-intersecting, open) triangle mesh — the heuristic the even-odd scanline
 * fill can't handle on complex models.
 *
 * Three passes:
 *  1. Rasterise every triangle into the voxel grid (dense barycentric point
 *     sampling, finer than half a voxel) marking the "surface" voxels — gap-free
 *     even for faces lying exactly on voxel planes.
 *  2. Morphologically CLOSE the surface (dilate by `seal`, then the flood in
 *     step 3 can't leak through cracks/holes up to `seal` voxels wide).
 *  3. Flood-fill "outside" from the grid border through non-surface voxels; any
 *     voxel the flood never reaches is interior.  Solid = surface ∪ interior.
 *
 * Because inside/outside is decided by connectivity to the border — not by
 * per-row crossing parity — it is immune to open boundaries and flipped normals
 * as long as gaps are within `seal` voxels.  A final erosion by `seal` undoes
 * the dilation's inflation so the solid stays close to the true surface.
 */
export function solidifyToOccupancy(
  vertices: Float32Array,
  indices: Uint32Array | null,
  grid: GridMeta,
  seal = 1,
): { occupancy: Uint8Array; occupiedVoxels: number } {
  const { axis, nx, ny, nz, cellSize, layerThickness, origin } = grid
  const nxy = nx * ny
  const N = nxy * nz
  const surface = new Uint8Array(N)

  const triCount = indices ? indices.length / 3 : vertices.length / 9
  const A: [number, number, number] = [0, 0, 0]
  const B: [number, number, number] = [0, 0, 0]
  const C: [number, number, number] = [0, 0, 0]

  const frameOf = (vi: number, out: [number, number, number]) => {
    const f = worldToFrame(vertices[vi * 3], vertices[vi * 3 + 1], vertices[vi * 3 + 2], axis)
    out[0] = f[0]; out[1] = f[1]; out[2] = f[2]
  }

  // Dense point-sampling rasterisation: sample each triangle on a barycentric
  // lattice finer than half a voxel, so consecutive samples never skip a voxel
  // and the marked shell is gap-free (robust even for faces lying exactly on
  // voxel planes, where an exact triangle/box test leaves pinholes).
  const step = 0.5 * Math.min(cellSize, layerThickness)
  const mark = (u: number, v: number, w: number) => {
    const i = Math.floor((u - origin[0]) / cellSize)
    const j = Math.floor((v - origin[1]) / cellSize)
    const k = Math.floor((w - origin[2]) / layerThickness)
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return
    surface[k * nxy + j * nx + i] = 1
  }
  for (let t = 0; t < triCount; t++) {
    let a: number, b: number, c: number
    if (indices) { a = indices[t * 3]; b = indices[t * 3 + 1]; c = indices[t * 3 + 2] }
    else { a = t * 3; b = t * 3 + 1; c = t * 3 + 2 }
    frameOf(a, A); frameOf(b, B); frameOf(c, C)
    const eAB = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2])
    const eAC = Math.hypot(C[0] - A[0], C[1] - A[1], C[2] - A[2])
    const n = Math.max(1, Math.ceil(Math.max(eAB, eAC) / step))
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const bu = i / n, bv = j / n
        mark(
          A[0] + bu * (B[0] - A[0]) + bv * (C[0] - A[0]),
          A[1] + bu * (B[1] - A[1]) + bv * (C[1] - A[1]),
          A[2] + bu * (B[2] - A[2]) + bv * (C[2] - A[2]),
        )
      }
    }
  }

  const sealed = seal > 0 ? dilate(surface, nx, ny, nz, seal) : surface

  // Flood "outside" from the border through non-surface voxels.
  const outside = new Uint8Array(N)
  const stack: number[] = []
  const pushIfOpen = (idx: number) => {
    if (sealed[idx] === 0 && outside[idx] === 0) { outside[idx] = 1; stack.push(idx) }
  }
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) {
          pushIfOpen(k * nxy + j * nx + i)
        }
      }
  while (stack.length) {
    const idx = stack.pop()!
    const i = idx % nx, j = ((idx / nx) | 0) % ny, k = (idx / nxy) | 0
    if (i > 0) pushIfOpen(idx - 1)
    if (i < nx - 1) pushIfOpen(idx + 1)
    if (j > 0) pushIfOpen(idx - nx)
    if (j < ny - 1) pushIfOpen(idx + nx)
    if (k > 0) pushIfOpen(idx - nxy)
    if (k < nz - 1) pushIfOpen(idx + nxy)
  }

  // Solid = everything the outside flood never reached.
  const solidRaw = new Uint8Array(N)
  for (let idx = 0; idx < N; idx++) solidRaw[idx] = outside[idx] ? 0 : 1
  // The `seal` barrier dilated the surface outward by `seal` voxels, inflating
  // the solid by the same amount; erode it back so the boundary tracks the true
  // surface (net effect: bridge cracks up to `seal` wide without bulging).
  const solid = seal > 0 ? erode(solidRaw, nx, ny, nz, seal) : solidRaw

  // Make the cuberille surface a true 2-manifold by filling only the diagonal
  // voxel configurations that create non-manifold edges — flat faces stay flat
  // (unlike a blanket dilation, which bevels every edge).
  makeManifold(solid, nx, ny, nz)

  let occupied = 0
  for (let idx = 0; idx < N; idx++) if (solid[idx]) occupied++
  return { occupancy: solid, occupiedVoxels: occupied }
}

/**
 * Eliminate the diagonal voxel configurations that make the cuberille surface
 * non-manifold.  A grid edge is non-manifold when the 4 voxels around it (in
 * the plane perpendicular to the edge) are solid on one diagonal and empty on
 * the other — the surface then pinches to 4 faces meeting at that edge.  Filling
 * one of the empty diagonal voxels turns the 2/2 diagonal into a 3/1 config,
 * which is manifold.  Iterated to a fixpoint (a fill can expose a new diagonal),
 * capped so it always terminates.  In-place.
 */
function makeManifold(occ: Uint8Array, nx: number, ny: number, nz: number): void {
  const nxy = nx * ny
  const at = (i: number, j: number, k: number) => occ[k * nxy + j * nx + i]
  const set = (i: number, j: number, k: number) => { occ[k * nxy + j * nx + i] = 1 }
  for (let pass = 0; pass < 6; pass++) {
    let changed = false
    // Edges along X: 2×2 of voxels in the (y,z) plane.
    for (let i = 0; i < nx; i++)
      for (let k = 1; k < nz; k++)
        for (let j = 1; j < ny; j++) {
          const a = at(i, j, k), b = at(i, j - 1, k), c = at(i, j, k - 1), d = at(i, j - 1, k - 1)
          if (a && d && !b && !c) { set(i, j - 1, k); changed = true }
          else if (b && c && !a && !d) { set(i, j, k); changed = true }
        }
    // Edges along Y: (x,z) plane.
    for (let j = 0; j < ny; j++)
      for (let k = 1; k < nz; k++)
        for (let i = 1; i < nx; i++) {
          const a = at(i, j, k), b = at(i - 1, j, k), c = at(i, j, k - 1), d = at(i - 1, j, k - 1)
          if (a && d && !b && !c) { set(i - 1, j, k); changed = true }
          else if (b && c && !a && !d) { set(i, j, k); changed = true }
        }
    // Edges along Z: (x,y) plane.
    for (let k = 0; k < nz; k++)
      for (let j = 1; j < ny; j++)
        for (let i = 1; i < nx; i++) {
          const a = at(i, j, k), b = at(i - 1, j, k), c = at(i, j - 1, k), d = at(i - 1, j - 1, k)
          if (a && d && !b && !c) { set(i - 1, j, k); changed = true }
          else if (b && c && !a && !d) { set(i, j, k); changed = true }
        }
    if (!changed) break
  }
}

/** 6-neighbour erosion, `r` times (grid border counts as empty). */
function erode(src: Uint8Array, nx: number, ny: number, nz: number, r: number): Uint8Array {
  const nxy = nx * ny
  let cur = src
  for (let pass = 0; pass < r; pass++) {
    const next = new Uint8Array(cur.length)
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const idx = k * nxy + j * nx + i
          if (!cur[idx]) continue
          if (
            i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1 ||
            !cur[idx - 1] || !cur[idx + 1] || !cur[idx - nx] || !cur[idx + nx] ||
            !cur[idx - nxy] || !cur[idx + nxy]
          ) continue
          next[idx] = 1
        }
    cur = next
  }
  return cur
}

/** 6-neighbour dilation, `r` times. */
function dilate(src: Uint8Array, nx: number, ny: number, nz: number, r: number): Uint8Array {
  const nxy = nx * ny
  let cur = src
  for (let pass = 0; pass < r; pass++) {
    const next = new Uint8Array(cur.length)
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const idx = k * nxy + j * nx + i
          if (cur[idx]) { next[idx] = 1; continue }
          if (
            (i > 0 && cur[idx - 1]) || (i < nx - 1 && cur[idx + 1]) ||
            (j > 0 && cur[idx - nx]) || (j < ny - 1 && cur[idx + nx]) ||
            (k > 0 && cur[idx - nxy]) || (k < nz - 1 && cur[idx + nxy])
          ) next[idx] = 1
        }
    cur = next
  }
  return cur
}

