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
 * Passes: weld → drop degenerate → drop duplicate → stitch T-junctions →
 * orient each connected component consistently and flip it outward (by signed
 * volume) → fill small boundary holes by ear-clipping their loops.  `closed`
 * reports whether the result is a watertight, orientable manifold; if not,
 * `blockedBy` names the condition that stopped it and the caller solidifies.
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
  /** Edges split to match a neighbour's subdivision (T-junctions). */
  stitchedEdges: number
  flippedTriangles: number
  components: number
  filledHoles: number
  openBoundaryLoops: number
  /** Edges still used by exactly one face after every pass. */
  remainingBoundaryEdges: number
  /** Edges still used by three or more faces after every pass. */
  remainingNonManifoldEdges: number
  /** True when neighbouring faces disagree about which side is out (non-orientable). */
  orientationConflict: boolean
  closed: boolean
  /** Empty when `closed`; otherwise why the mesh could not be repaired. */
  blockedBy: string
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

  // --- Stitch T-junctions -------------------------------------------------
  // Must run before the orientation pass, because it changes connectivity.
  const stitchedEdges = stitchTJunctions(V, tris, Math.max(tol, size * 1e-5), size)

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
  let remainingBoundaryEdges = 0
  let remainingNonManifoldEdges = 0
  for (const owners of finalEdges.values()) {
    if (owners.length === 1) remainingBoundaryEdges++
    else if (owners.length > 2) remainingNonManifoldEdges++
  }
  const closed =
    !inconsistent &&
    tris.length > 0 &&
    remainingBoundaryEdges === 0 &&
    remainingNonManifoldEdges === 0

  // Saying only "not repairable" would be the "almost worked" state this
  // pipeline is supposed to refuse. Name the condition that actually blocked it.
  const reasons: string[] = []
  if (tris.length === 0) reasons.push('no triangles left after cleanup')
  if (remainingBoundaryEdges > 0) {
    reasons.push(`${remainingBoundaryEdges} open edge(s) that could not be closed`)
  }
  if (remainingNonManifoldEdges > 0) {
    reasons.push(`${remainingNonManifoldEdges} edge(s) shared by 3+ faces`)
  }
  if (inconsistent) reasons.push('faces disagree on which side is outside')
  const blockedBy = closed ? '' : reasons.join('; ')

  return {
    vertices: V,
    indices: Uint32Array.from(tris),
    report: {
      removedDegenerate,
      removedDuplicate,
      stitchedEdges,
      flippedTriangles,
      components,
      filledHoles,
      openBoundaryLoops,
      remainingBoundaryEdges,
      remainingNonManifoldEdges,
      orientationConflict: inconsistent,
      closed,
      blockedBy,
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

/**
 * Split triangles whose boundary edge has other vertices lying ON it.
 *
 * This is the defect that keeps an obviously-solid CAD mesh from ever becoming
 * a manifold. When each face of a part is triangulated independently — which
 * is what CAD tessellation and most STEP/IGES exports produce — a long edge on
 * one face may be subdivided on its neighbour. The two faces then share vertex
 * *positions* but not *edges*, so welding cannot join them: every seam stays a
 * pair of one-sided edges and each face becomes its own shell. A part with 49
 * faces reports 49 shells and "not repairable", even though nothing is
 * geometrically wrong with it.
 *
 * The fix is to re-triangulate the offending triangle as a fan through the
 * vertices sitting on its edge, so the edge is subdivided to match its
 * neighbour. Only splits are performed — no vertex moves and no geometry
 * changes, so this cannot falsify the model.
 *
 * Repeated to a fixpoint, because splitting one edge can expose a T-junction
 * on the sub-edges it creates. Returns the number of edges stitched.
 */
export function stitchTJunctions(
  V: Float32Array,
  tris: number[],
  tol: number,
  size: number,
  maxRounds = 4,
): number {
  let stitchedTotal = 0

  for (let round = 0; round < maxRounds; round++) {
    const owners = new Map<number, number[]>()
    for (let t = 0; t < tris.length / 3; t++) {
      const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2]
      for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
        const k = ekey(x, y)
        const list = owners.get(k)
        if (list) list.push(t); else owners.set(k, [t])
      }
    }
    const boundary: number[] = []
    for (const [k, list] of owners) if (list.length === 1) boundary.push(k)
    if (boundary.length === 0) break

    // The lookup grid is a coarse spatial bucket, deliberately NOT the size of
    // the tolerance: sizing cells at `tol` makes the segment walk take one step
    // per tolerance unit, which is hundreds of thousands of steps for a normal
    // edge. It only has to be at least `tol` so a 3x3x3 probe still covers it.
    const cell = Math.max(tol * 16, size / 256)
    const grid = buildVertexGrid(V, cell)
    const replaced = new Map<number, number[]>() // triangle id → replacement fan
    let splits = 0

    for (const key of boundary) {
      const t = owners.get(key)![0]
      if (replaced.has(t)) continue // one split per triangle per round
      const lo = Math.floor(key / SHIFT)
      const hi = key % SHIFT
      const mids = verticesOnSegment(V, lo, hi, grid, cell, tol)
      if (mids.length === 0) continue

      // Locate the edge inside the triangle so the fan keeps its winding.
      const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2]
      let p = -1, q = -1, r = -1
      for (const [x, y, z] of [[a, b, c], [b, c, a], [c, a, b]] as const) {
        if ((x === lo && y === hi) || (x === hi && y === lo)) { p = x; q = y; r = z; break }
      }
      if (p < 0) continue

      // Order the inserted vertices along p → q.
      const ordered = mids
        .map(v => ({ v, t: segmentParam(V, p, q, v) }))
        .sort((m, n) => m.t - n.t)
        .map(m => m.v)

      const fan: number[] = []
      let previous = p
      for (const m of ordered) { fan.push(r, previous, m); previous = m }
      fan.push(r, previous, q)
      replaced.set(t, fan)
      splits++
    }

    if (splits === 0) break
    stitchedTotal += splits

    const rebuilt: number[] = []
    for (let t = 0; t < tris.length / 3; t++) {
      const fan = replaced.get(t)
      if (fan) rebuilt.push(...fan)
      else rebuilt.push(tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2])
    }
    tris.length = 0
    for (const value of rebuilt) tris.push(value)
  }
  return stitchedTotal
}

/** Spatial hash of vertex indices, so an edge only tests nearby vertices. */
function buildVertexGrid(V: Float32Array, cell: number): Map<string, number[]> {
  const grid = new Map<string, number[]>()
  const size = Math.max(cell, 1e-12)
  for (let v = 0; v < V.length / 3; v++) {
    const k = cellKey(V[v * 3], V[v * 3 + 1], V[v * 3 + 2], size)
    const list = grid.get(k)
    if (list) list.push(v); else grid.set(k, [v])
  }
  return grid
}

function cellKey(x: number, y: number, z: number, cell: number): string {
  return `${Math.floor(x / cell)}_${Math.floor(y / cell)}_${Math.floor(z / cell)}`
}

/** Vertices lying strictly between `a` and `b`, within `tol` of the segment. */
function verticesOnSegment(
  V: Float32Array,
  a: number,
  b: number,
  grid: Map<string, number[]>,
  cell: number,
  tol: number,
): number[] {
  const ax = V[a * 3], ay = V[a * 3 + 1], az = V[a * 3 + 2]
  const dx = V[b * 3] - ax, dy = V[b * 3 + 1] - ay, dz = V[b * 3 + 2] - az
  const lengthSq = dx * dx + dy * dy + dz * dz
  if (lengthSq <= 0) return []
  const length = Math.sqrt(lengthSq)

  // Walk the segment in half-cell steps and collect the cells it passes through.
  const seen = new Set<number>()
  const found: number[] = []
  const steps = Math.ceil(length / (cell * 0.5)) + 1
  for (let s = 0; s <= steps; s++) {
    const f = s / steps
    const px = ax + dx * f, py = ay + dy * f, pz = az + dz * f
    for (let ox = -1; ox <= 1; ox++)
      for (let oy = -1; oy <= 1; oy++)
        for (let oz = -1; oz <= 1; oz++) {
          const list = grid.get(cellKey(px + ox * cell, py + oy * cell, pz + oz * cell, cell))
          if (!list) continue
          for (const v of list) {
            if (v === a || v === b || seen.has(v)) continue
            seen.add(v)
            const t = segmentParam(V, a, b, v)
            // Strictly interior, so an endpoint never counts as a T-junction.
            if (t <= 0 || t >= 1) continue
            const cx = ax + dx * t - V[v * 3]
            const cy = ay + dy * t - V[v * 3 + 1]
            const cz = az + dz * t - V[v * 3 + 2]
            if (cx * cx + cy * cy + cz * cz <= tol * tol) found.push(v)
          }
        }
  }
  return found
}

/** Normalised position of vertex `v` projected onto segment a→b. */
function segmentParam(V: Float32Array, a: number, b: number, v: number): number {
  const dx = V[b * 3] - V[a * 3]
  const dy = V[b * 3 + 1] - V[a * 3 + 1]
  const dz = V[b * 3 + 2] - V[a * 3 + 2]
  const lengthSq = dx * dx + dy * dy + dz * dz
  if (lengthSq <= 0) return 0
  return (
    ((V[v * 3] - V[a * 3]) * dx +
      (V[v * 3 + 1] - V[a * 3 + 1]) * dy +
      (V[v * 3 + 2] - V[a * 3 + 2]) * dz) / lengthSq
  )
}
