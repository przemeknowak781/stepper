import { computeAABB, aabbMaxExtent } from './boundingBox'
import { triangulateFace } from './triangulate'

/**
 * Heuristic manifold repair for imperfect input meshes.  Complex models
 * (scans, game assets, the vehicle in the report) are rarely clean closed
 * manifolds — they have duplicated/degenerate faces, inconsistent winding, and
 * small cracks.  This tries to turn such a mesh into a closed, consistently
 * oriented 2-manifold so the faithful planar-merge path can run on it (exact,
 * economical) instead of always resorting to voxel reconstruction.
 *
 * Passes: weld → drop degenerate → drop duplicate → orient each connected
 * component consistently and flip it outward (by signed volume) → fill small
 * boundary holes by ear-clipping their loops.  `closed` reports whether the
 * result is a watertight, orientable manifold; if not, the caller solidifies.
 */
export interface RepairOptions {
  weldTol?: number
  fillHoles?: boolean
  /** Only fill boundary loops with at most this many edges (bigger = a genuine opening). */
  maxHoleEdges?: number
}

export interface RepairReport {
  removedDegenerate: number
  removedDuplicate: number
  flippedTriangles: number
  components: number
  filledHoles: number
  openBoundaryLoops: number
  closed: boolean
}

export interface RepairedMesh {
  vertices: Float32Array
  indices: Uint32Array
  report: RepairReport
}

const SHIFT = 33554432 // 2^25
const ekey = (a: number, b: number) => (a < b ? a * SHIFT + b : b * SHIFT + a)
const dkey = (a: number, b: number) => a * SHIFT + b // directed

export function repairMesh(
  verticesIn: Float32Array,
  indicesIn: Uint32Array | null,
  options: RepairOptions = {},
): RepairedMesh {
  const size = aabbMaxExtent(computeAABB(verticesIn))
  const tol = options.weldTol ?? Math.max(1e-6, size * 1e-6)
  const fillHoles = options.fillHoles ?? true
  const maxHoleEdges = options.maxHoleEdges ?? 2000

  // --- Weld coincident vertices ------------------------------------------
  const triCount = indicesIn ? indicesIn.length / 3 : verticesIn.length / 9
  const keyToId = new Map<string, number>()
  const verts: number[] = []
  const invTol = 1 / tol
  const resolve = (x: number, y: number, z: number): number => {
    const k = `${Math.round(x * invTol)}_${Math.round(y * invTol)}_${Math.round(z * invTol)}`
    const e = keyToId.get(k)
    if (e !== undefined) return e
    const id = verts.length / 3
    verts.push(x, y, z)
    keyToId.set(k, id)
    return id
  }
  const tris: number[] = [] // flat [a,b,c,...]
  let removedDegenerate = 0
  for (let t = 0; t < triCount; t++) {
    let ia: number, ib: number, ic: number
    if (indicesIn) { ia = indicesIn[t * 3]; ib = indicesIn[t * 3 + 1]; ic = indicesIn[t * 3 + 2] }
    else { ia = t * 3; ib = t * 3 + 1; ic = t * 3 + 2 }
    const a = resolve(verticesIn[ia * 3], verticesIn[ia * 3 + 1], verticesIn[ia * 3 + 2])
    const b = resolve(verticesIn[ib * 3], verticesIn[ib * 3 + 1], verticesIn[ib * 3 + 2])
    const c = resolve(verticesIn[ic * 3], verticesIn[ic * 3 + 1], verticesIn[ic * 3 + 2])
    if (a === b || b === c || c === a) { removedDegenerate++; continue }
    tris.push(a, b, c)
  }
  const V = Float32Array.from(verts)

  // --- Drop duplicate triangles (same vertex set) ------------------------
  // Compacted IN PLACE: `tris.push(...kept)` would spread hundreds of
  // thousands of arguments onto the call stack and blow it up on real models.
  let removedDuplicate = 0
  {
    const seen = new Set<string>()
    let out = 0
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2]
      // Order-independent key without allocating/sorting an array per triangle.
      const lo = a < b ? (a < c ? a : c) : (b < c ? b : c)
      const hi = a > b ? (a > c ? a : c) : (b > c ? b : c)
      const mid = a + b + c - lo - hi
      const s = `${lo}_${mid}_${hi}`
      if (seen.has(s)) { removedDuplicate++; continue }
      seen.add(s)
      tris[out] = a; tris[out + 1] = b; tris[out + 2] = c
      out += 3
    }
    tris.length = out
  }

  // --- Consistent orientation per connected component --------------------
  const nT = tris.length / 3
  // undirected edge → triangle ids
  const edgeTris = new Map<number, number[]>()
  for (let t = 0; t < nT; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2]
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const k = ekey(x, y)
      const l = edgeTris.get(k)
      if (l) l.push(t); else edgeTris.set(k, [t])
    }
  }
  const triEdgeDir = (t: number, x: number, y: number): 1 | -1 => {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2]
    if ((a === x && b === y) || (b === x && c === y) || (c === x && a === y)) return 1
    return -1
  }
  const flipTri = (t: number) => {
    const tmp = tris[t * 3 + 1]; tris[t * 3 + 1] = tris[t * 3 + 2]; tris[t * 3 + 2] = tmp
  }
  const visited = new Uint8Array(nT)
  let components = 0
  let flippedTriangles = 0
  let inconsistent = false
  for (let seed = 0; seed < nT; seed++) {
    if (visited[seed]) continue
    components++
    const comp: number[] = []
    const queue = [seed]
    visited[seed] = 1
    while (queue.length) {
      const t = queue.pop()!
      comp.push(t)
      const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2]
      for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
        const owners = edgeTris.get(ekey(x, y))!
        if (owners.length !== 2) continue // boundary or non-manifold edge: skip
        const other = owners[0] === t ? owners[1] : owners[0]
        if (visited[other]) {
          // Consistency check: shared edge must run opposite in the two tris.
          if (triEdgeDir(t, x, y) === triEdgeDir(other, x, y)) inconsistent = true
          continue
        }
        // Neighbour must traverse this edge opposite (y,x). If it also goes
        // (x,y), flip it before enqueue.
        if (triEdgeDir(other, x, y) === 1) { flipTri(other); flippedTriangles++ }
        visited[other] = 1
        queue.push(other)
      }
    }
    // Orient the whole component outward by signed volume.
    let vol = 0
    for (const t of comp) {
      const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2]
      vol += (
        V[a * 3] * (V[b * 3 + 1] * V[c * 3 + 2] - V[b * 3 + 2] * V[c * 3 + 1]) -
        V[a * 3 + 1] * (V[b * 3] * V[c * 3 + 2] - V[b * 3 + 2] * V[c * 3]) +
        V[a * 3 + 2] * (V[b * 3] * V[c * 3 + 1] - V[b * 3 + 1] * V[c * 3])
      )
    }
    if (vol < 0) for (const t of comp) { flipTri(t); flippedTriangles++ }
  }

  // --- Fill small boundary holes -----------------------------------------
  let filledHoles = 0
  let openBoundaryLoops = 0
  if (fillHoles) {
    // Directed boundary edges (from the single owning triangle).
    const nextFrom = new Map<number, number>()
    const boundaryDirected = new Set<number>()
    for (const [k, owners] of edgeTris) {
      if (owners.length !== 1) continue
      const t = owners[0]
      const lo = Math.floor(k / SHIFT), hi = k % SHIFT
      const dir = triEdgeDir(t, lo, hi)
      const x = dir === 1 ? lo : hi
      const y = dir === 1 ? hi : lo
      nextFrom.set(x, y)
      boundaryDirected.add(dkey(x, y))
    }
    const used = new Set<number>()
    const loops: number[][] = []
    for (const start of nextFrom.keys()) {
      if (used.has(start)) continue
      const loop: number[] = []
      let cur = start
      let guard = 0
      while (!used.has(cur) && nextFrom.has(cur) && guard++ < nextFrom.size + 1) {
        used.add(cur); loop.push(cur); cur = nextFrom.get(cur)!
      }
      if (loop.length >= 3) loops.push(loop)
    }
    for (const ring of loops) {
      if (ring.length > maxHoleEdges) { openBoundaryLoops++; continue }
      const n = newellNormal(ring, V)
      if (!n) { openBoundaryLoops++; continue }
      const patch = triangulateFace(V, [ring], n)
      if (patch.length === 0) { openBoundaryLoops++; continue }
      // Orient patch so its edge along a boundary edge (x,y) runs (y,x).
      let flip = false
      outer: for (const [p, q, r] of patch) {
        for (const [u, w] of [[p, q], [q, r], [r, p]] as const) {
          if (boundaryDirected.has(dkey(u, w))) { flip = true; break outer }
          if (boundaryDirected.has(dkey(w, u))) { flip = false; break outer }
        }
      }
      for (const [p, q, r] of patch) {
        if (flip) tris.push(p, r, q)
        else tris.push(p, q, r)
      }
      filledHoles++
    }
  }

  // --- Final manifold / orientability check ------------------------------
  const finalEdges = new Map<number, number[]>()
  for (let t = 0; t < tris.length / 3; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2]
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const k = ekey(x, y)
      const l = finalEdges.get(k)
      if (l) l.push(t); else finalEdges.set(k, [t])
    }
  }
  let closed = !inconsistent && tris.length > 0
  if (closed) {
    for (const owners of finalEdges.values()) {
      if (owners.length !== 2) { closed = false; break }
    }
  }

  return {
    vertices: V,
    indices: Uint32Array.from(tris),
    report: {
      removedDegenerate,
      removedDuplicate,
      flippedTriangles,
      components,
      filledHoles,
      openBoundaryLoops,
      closed,
    },
  }
}

/** Newell-method normal of a vertex ring; null if degenerate. */
function newellNormal(ring: number[], V: Float32Array): [number, number, number] | null {
  let nx = 0, ny = 0, nz = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    nx += (V[a * 3 + 1] - V[b * 3 + 1]) * (V[a * 3 + 2] + V[b * 3 + 2])
    ny += (V[a * 3 + 2] - V[b * 3 + 2]) * (V[a * 3] + V[b * 3])
    nz += (V[a * 3] - V[b * 3]) * (V[a * 3 + 1] + V[b * 3 + 1])
  }
  const len = Math.hypot(nx, ny, nz)
  if (len < 1e-12) return null
  return [nx / len, ny / len, nz / len]
}
