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
  /** Faces removed as one half of a quad cut across both diagonals at once. */
  droppedOverlaps: number
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

/**
 * Repair, repeated until it stops making progress.
 *
 * One pass is not enough on real files and the reason is structural: dropping a
 * pair of overlapping faces opens a hole, filling that hole can leave a patch
 * overlapping something else, and only the next pass sees it. On the model this
 * was written for the sequence is 84 non-manifold edges and 16 open ones ->
 * 7 and 9 -> 5 and 0 -> 1 and 0 -> closed. Stopping after one pass reports a
 * mesh that is merely closer, which the caller can only treat as a failure.
 */
export function repairMesh(
  verticesIn: Float32Array,
  indicesIn: Uint32Array | null,
  options: RepairOptions = {},
): RepairedMesh {
  let result = repairOnce(verticesIn, indicesIn, options)
  const total = { ...result.report }
  for (let pass = 1; pass < MAX_REPAIR_PASSES && !result.report.closed; pass++) {
    const next = repairOnce(result.vertices, result.indices, options)
    // Only adopt a pass that leaves FEWER defects. Iterating without this test
    // is not merely wasteful, it regresses: on a flat sheet whose rim the first
    // pass had already capped, the next pass drops a coplanar overlap it
    // created and reopens four edges that were closed. A repair that can end
    // worse than it started is worse than one that stops early.
    const better =
      next.report.remainingNonManifoldEdges + next.report.remainingBoundaryEdges <
      result.report.remainingNonManifoldEdges + result.report.remainingBoundaryEdges
    if (!better) break
    result = next
    total.removedDegenerate += next.report.removedDegenerate
    total.removedDuplicate += next.report.removedDuplicate
    total.stitchedEdges += next.report.stitchedEdges
    total.droppedOverlaps += next.report.droppedOverlaps
    total.flippedTriangles += next.report.flippedTriangles
    total.filledHoles += next.report.filledHoles
  }
  // Counters accumulate across passes; the state ones describe where it ended.
  return {
    ...result,
    report: {
      ...total,
      components: result.report.components,
      openBoundaryLoops: result.report.openBoundaryLoops,
      remainingBoundaryEdges: result.report.remainingBoundaryEdges,
      remainingNonManifoldEdges: result.report.remainingNonManifoldEdges,
      orientationConflict: result.report.orientationConflict,
      closed: result.report.closed,
      blockedBy: result.report.blockedBy,
    },
  }
}

/** How many times to re-run before accepting the mesh cannot be closed. */
const MAX_REPAIR_PASSES = 8

function repairOnce(
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

  // --- Drop quads that were triangulated across both diagonals ------------
  // To a fixpoint: removing one overlapping pair can leave an edge with three
  // owners down to a pair that is itself one of these.
  let droppedOverlaps = 0
  for (let round = 0; round < 8; round++) {
    const dropped = recutDoubleDiagonalQuads(V, tris)
    if (dropped === 0) break
    droppedOverlaps += dropped
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
    // Boundary loops, walked through the face fan.
    //
    // The successor of a boundary edge cannot be chosen greedily. A vertex may
    // start more than one boundary edge — that happens wherever two openings
    // pinch together at a shared corner — and picking either one splices the
    // two openings into a single figure-of-eight that ear-clipping then turns
    // into garbage. Rotating around the end vertex through the incident faces
    // finds the edge that actually continues the same opening.
    const boundaryDirected = new Set<number>()
    for (const [k, owners] of edgeTris) {
      if (owners.length !== 1) continue
      const t = owners[0]
      const lo = Math.floor(k / SHIFT), hi = k % SHIFT
      const dir = triEdgeDir(t, lo, hi)
      boundaryDirected.add(dir === 1 ? dkey(lo, hi) : dkey(hi, lo))
    }

    /** Vertex `w` such that (v → w) is a directed edge of triangle `t`. */
    const outFrom = (t: number, v: number): number => {
      const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2]
      if (a === v) return b
      if (b === v) return c
      if (c === v) return a
      return -1
    }

    /** Next boundary vertex after the directed boundary edge u → v, or -1. */
    const nextBoundary = (u: number, v: number): number => {
      const start = edgeTris.get(ekey(u, v))
      if (!start || start.length !== 1) return -1
      let t = start[0]
      for (let guard = 0; guard < 4096; guard++) {
        const w = outFrom(t, v)
        if (w < 0) return -1
        const owners = edgeTris.get(ekey(v, w))
        if (!owners) return -1
        if (owners.length === 1) return w        // reached the next boundary edge
        if (owners.length !== 2) return -1       // non-manifold: refuse to guess
        t = owners[0] === t ? owners[1] : owners[0]
      }
      return -1
    }

    const usedEdges = new Set<number>()
    const loops: number[][] = []
    for (const directed of boundaryDirected) {
      if (usedEdges.has(directed)) continue
      const origin = Math.floor(directed / SHIFT)
      const loop: number[] = [origin]
      usedEdges.add(directed)
      let prev = origin
      let cur = directed % SHIFT
      let ok = true
      for (let guard = 0; cur !== origin; guard++) {
        if (guard > boundaryDirected.size) { ok = false; break }
        const next = nextBoundary(prev, cur)
        if (next < 0) { ok = false; break }
        usedEdges.add(dkey(cur, next))
        loop.push(cur)
        prev = cur
        cur = next
      }
      if (ok && loop.length >= 3) loops.push(...splitPinchedLoop(loop))
      else if (!ok) openBoundaryLoops++
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
      droppedOverlaps,
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
/**
 * Repair quads that were triangulated across BOTH diagonals at once.
 *
 * Two triangles hinged on a shared edge `P-Q`, coplanar, with their apexes on
 * the same side of it, are not a fold and not a T-junction — they are the two
 * halves of one quad cut on opposite diagonals: `(P,Q,W1)` and `(P,Q,W2)` where
 * the intended surface is the quad `P,Q,W1,W2`. Such a pair overlaps over half
 * the quad and leaves the other half as a hole, and the shared edge picks up a
 * third owner, so it reads as non-manifold.
 *
 * Real files contain this. The model this was written for is a surface export
 * whose side-wall band emits `(P,Q,Q+d)` and `(P,Q,P+d)` for every rim edge
 * instead of `(P,Q,Q+d)` and `(P,Q+d,P+d)`: 84 non-manifold edges and 16
 * unfillable boundary edges, all from one wrong index. Splitting the
 * non-manifold edges apart — the textbook repair — would faithfully preserve
 * both the overlap and the hole; re-cutting the quad removes both.
 *
 * Conservative by construction: it fires only when the four corners are
 * coplanar, the apexes splay the same way, and one of the two orderings gives a
 * simple (non-self-crossing) quad. Anything else is left alone, because a
 * genuine three-surface junction must not be silently rewritten.
 */
function recutDoubleDiagonalQuads(V: Float32Array, tris: number[]): number {
  const edgeTris = new Map<number, number[]>()
  for (let t = 0; t < tris.length / 3; t++) {
    for (let e = 0; e < 3; e++) {
      const a = tris[t * 3 + e]
      const b = tris[t * 3 + ((e + 1) % 3)]
      const key = ekey(a, b)
      const list = edgeTris.get(key)
      if (list) list.push(t)
      else edgeTris.set(key, [t])
    }
  }

  const apexOf = (t: number, a: number, b: number): number => {
    for (let i = 0; i < 3; i++) {
      const v = tris[t * 3 + i]
      if (v !== a && v !== b) return v
    }
    return -1
  }
  const dead = new Set<number>()
  let recut = 0

  for (const [key, owners] of edgeTris) {
    if (owners.length < 3) continue
    const a = Math.floor(key / SHIFT)
    const b = key % SHIFT
    const live = owners.filter((t) => !dead.has(t))
    if (live.length < 2) continue

    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const t1 = live[i]
        const t2 = live[j]
        if (dead.has(t1) || dead.has(t2)) continue
        const w1 = apexOf(t1, a, b)
        const w2 = apexOf(t2, a, b)
        if (w1 < 0 || w2 < 0 || w1 === w2) continue
        const order = simpleQuadOrder(V, a, b, w1, w2)
        if (!order) continue
        dead.add(t1)
        dead.add(t2)
        recut++
      }
    }
  }
  if (dead.size) {
    let out = 0
    for (let t = 0; t < tris.length / 3; t++) {
      if (dead.has(t)) continue
      tris[out] = tris[t * 3]; tris[out + 1] = tris[t * 3 + 1]; tris[out + 2] = tris[t * 3 + 2]
      out += 3
    }
    tris.length = out
  }
  return recut
}

/**
 * Order `a, b, w1, w2` into a simple planar quad, or return null.
 *
 * Requires the four points to be coplanar and both apexes to sit on the same
 * side of the edge `a-b` — the signature of the double-diagonal cut. Of the two
 * possible orderings exactly one can be simple; a self-crossing result means
 * these triangles are not two halves of a quad and must be left alone.
 */
function simpleQuadOrder(
  V: Float32Array,
  a: number,
  b: number,
  w1: number,
  w2: number,
): [number, number, number, number] | null {
  const at = (v: number): [number, number, number] => [V[v * 3], V[v * 3 + 1], V[v * 3 + 2]]
  const A = at(a)
  const B = at(b)
  const W1 = at(w1)
  const W2 = at(w2)

  const sub = (p: number[], q: number[]) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]]
  const cross = (p: number[], q: number[]) => [
    p[1] * q[2] - p[2] * q[1],
    p[2] * q[0] - p[0] * q[2],
    p[0] * q[1] - p[1] * q[0],
  ]
  const dot = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2]
  const len = (p: number[]) => Math.hypot(p[0], p[1], p[2])

  const edge = sub(B, A)
  const e1 = sub(W1, A)
  const e2 = sub(W2, A)
  const n1 = cross(edge, e1)
  const n2 = cross(edge, e2)
  const scale = len(edge) * Math.max(len(e1), len(e2))
  if (scale === 0) return null

  // Coplanar: the two triangle normals must be parallel. Relative to the edge
  // and apex lengths, so it means the same thing at any model scale.
  if (len(cross(n1, n2)) > scale * scale * COPLANAR_TOLERANCE) return null
  // Same side: a fold has the apexes splaying opposite ways, and folds are a
  // different defect that this repair must not touch.
  const perp = (e: number[]) => sub(e, edge.map((c) => (c * dot(e, edge)) / dot(edge, edge)))
  const p1 = perp(e1)
  const p2 = perp(e2)
  if (dot(p1, p2) <= 0) return null

  // Project onto the plane's dominant axes and test both orderings.
  const normal = n1.map((c) => Math.abs(c))
  const drop = normal[0] >= normal[1] ? (normal[0] >= normal[2] ? 0 : 2) : normal[1] >= normal[2] ? 1 : 2
  const keep = [0, 1, 2].filter((i) => i !== drop)
  const flat = (p: number[]): [number, number] => [p[keep[0]], p[keep[1]]]

  for (const [x, y] of [
    [w1, w2],
    [w2, w1],
  ]) {
    const quad: [number, number][] = [flat(A), flat(B), flat(at(x)), flat(at(y))]
    if (isSimpleQuad(quad)) return [a, b, x, y]
  }
  return null
}

/** True when the four corners form a non-self-crossing polygon. */
function isSimpleQuad(q: [number, number][]): boolean {
  // A quad self-crosses exactly when one pair of opposite sides intersects.
  return !segmentsCross(q[0], q[1], q[2], q[3]) && !segmentsCross(q[1], q[2], q[3], q[0])
}

function segmentsCross(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number],
): boolean {
  const side = (a: [number, number], b: [number, number], c: [number, number]) =>
    Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
  const d1 = side(p1, p2, p3)
  const d2 = side(p1, p2, p4)
  const d3 = side(p3, p4, p1)
  const d4 = side(p3, p4, p2)
  // Touching at an endpoint (a zero) is not a crossing — adjacent quad sides
  // legitimately share corners.
  return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4
}

/** Relative tolerance for calling two triangle normals parallel. */
const COPLANAR_TOLERANCE = 1e-4

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

/**
 * Break a boundary walk that revisits a vertex into simple closed rings.
 *
 * Where two openings pinch together the boundary passes through the shared
 * vertex twice, so the walk is a figure-of-eight rather than a simple polygon.
 * Ear clipping needs simple polygons: handed a self-touching ring it produces
 * overlapping triangles that leave the mesh open anyway. Cutting the ring at
 * each repeat yields the individual openings, which fill correctly.
 */
export function splitPinchedLoop(loop: number[]): number[][] {
  const out: number[][] = []
  const stack: number[] = []
  const seenAt = new Map<number, number>()
  for (const v of loop) {
    const previous = seenAt.get(v)
    if (previous !== undefined) {
      // Everything since the earlier visit is a closed ring of its own.
      const ring = stack.splice(previous)
      for (const w of ring) seenAt.delete(w)
      if (ring.length >= 3) out.push(ring)
    }
    seenAt.set(v, stack.length)
    stack.push(v)
  }
  if (stack.length >= 3) out.push(stack)
  return out
}
