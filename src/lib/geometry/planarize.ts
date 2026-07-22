import { computeAABB, aabbMaxExtent } from './boundingBox'
import { weldMesh } from '../step/exportSTEP'
import type { StepFace } from '../step/exportSTEP'

export interface PlanarBrep {
  /** Compacted vertex buffer — only vertices referenced by a face loop. */
  vertices: Float32Array
  faces: StepFace[]
}

export interface PlanarizeOptions {
  /**
   * Two adjacent triangles merge into one planar face when their normals differ
   * by less than this angle AND they lie on the same plane.  ~1° keeps the
   * result faithful (a box stays a box, a chamfer stays separate); raising it
   * simplifies gently-curved regions into fewer planar faces (approximation).
   */
  angleToleranceDeg?: number
}

export interface PlanarizeResult {
  brep: PlanarBrep | null
  /** Whether the (welded) input was a closed 2-manifold — required to planarize. */
  manifold: boolean
  faceCount: number
  edgeCount: number
  vertexCount: number
}

const EDGE_SHIFT = 33554432 // 2^25 — packs two vertex ids into one JS-safe int

function edgeKey(a: number, b: number): number {
  return a < b ? a * EDGE_SHIFT + b : b * EDGE_SHIFT + a
}

/** Union-find over triangle ids. */
class DSU {
  private p: Int32Array
  constructor(n: number) {
    this.p = new Int32Array(n)
    for (let i = 0; i < n; i++) this.p[i] = i
  }
  find(x: number): number {
    while (this.p[x] !== x) {
      this.p[x] = this.p[this.p[x]]
      x = this.p[x]
    }
    return x
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b)
    if (ra !== rb) this.p[rb] = ra
  }
}

/**
 * Turn a triangle mesh into a B-rep of large planar faces by merging coplanar,
 * edge-adjacent triangles and simplifying the collinear vertices out of each
 * region's boundary.
 *
 * This is the "excellent, economical, faithful" path: because it only *merges*
 * existing faces and *drops* redundant collinear boundary vertices, the output
 * geometry is bit-identical to the input surface — no resampling, no
 * approximation — while a flat face made of hundreds of triangles collapses to
 * a single polygon. It requires a closed 2-manifold input (every edge shared by
 * exactly two triangles); otherwise it returns `{ brep: null, manifold: false }`
 * and the caller should fall back to voxel reconstruction.
 */
export function planarizeMesh(
  verticesIn: Float32Array,
  indicesIn: Uint32Array | null,
  options: PlanarizeOptions = {},
): PlanarizeResult {
  const angleTol = options.angleToleranceDeg ?? 1
  const cosMerge = Math.cos((angleTol * Math.PI) / 180)
  const cosCollinear = Math.cos((0.5 * Math.PI) / 180)

  const { vertices: V, indices: F } = weldMesh(verticesIn, indicesIn, 1e-6)
  const nT = F.length / 3
  if (nT === 0) return { brep: null, manifold: false, faceCount: 0, edgeCount: 0, vertexCount: 0 }

  const size = aabbMaxExtent(computeAABB(V))
  const planeEps = Math.max(1e-6, size * 1e-4)

  // Per-triangle normals.
  const normals = new Float32Array(nT * 3)
  for (let t = 0; t < nT; t++) {
    const a = F[t * 3], b = F[t * 3 + 1], c = F[t * 3 + 2]
    const nx = (V[b * 3 + 1] - V[a * 3 + 1]) * (V[c * 3 + 2] - V[a * 3 + 2]) - (V[b * 3 + 2] - V[a * 3 + 2]) * (V[c * 3 + 1] - V[a * 3 + 1])
    const ny = (V[b * 3 + 2] - V[a * 3 + 2]) * (V[c * 3] - V[a * 3]) - (V[b * 3] - V[a * 3]) * (V[c * 3 + 2] - V[a * 3 + 2])
    const nz = (V[b * 3] - V[a * 3]) * (V[c * 3 + 1] - V[a * 3 + 1]) - (V[b * 3 + 1] - V[a * 3 + 1]) * (V[c * 3] - V[a * 3])
    const len = Math.hypot(nx, ny, nz) || 1
    normals[t * 3] = nx / len; normals[t * 3 + 1] = ny / len; normals[t * 3 + 2] = nz / len
  }

  // Edge → owning triangles. Manifold iff every edge has exactly two.
  const edgeTris = new Map<number, number[]>()
  for (let t = 0; t < nT; t++) {
    const a = F[t * 3], b = F[t * 3 + 1], c = F[t * 3 + 2]
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const k = edgeKey(x, y)
      const owners = edgeTris.get(k)
      if (owners) owners.push(t)
      else edgeTris.set(k, [t])
    }
  }
  let manifold = true
  for (const owners of edgeTris.values()) {
    if (owners.length !== 2) { manifold = false; break }
  }
  if (!manifold) {
    return { brep: null, manifold: false, faceCount: 0, edgeCount: 0, vertexCount: 0 }
  }

  // Merge coplanar, edge-adjacent triangles.
  const dsu = new DSU(nT)
  const coplanar = (i: number, j: number): boolean => {
    const dot = normals[i * 3] * normals[j * 3] + normals[i * 3 + 1] * normals[j * 3 + 1] + normals[i * 3 + 2] * normals[j * 3 + 2]
    if (dot < cosMerge) return false
    // Distance of triangle j's first vertex from triangle i's plane.
    const ai = F[i * 3], aj = F[j * 3]
    const dx = V[aj * 3] - V[ai * 3], dy = V[aj * 3 + 1] - V[ai * 3 + 1], dz = V[aj * 3 + 2] - V[ai * 3 + 2]
    const dist = dx * normals[i * 3] + dy * normals[i * 3 + 1] + dz * normals[i * 3 + 2]
    return Math.abs(dist) <= planeEps
  }
  for (const owners of edgeTris.values()) {
    if (coplanar(owners[0], owners[1])) dsu.union(owners[0], owners[1])
  }

  // Region id per triangle + region membership.
  const regionTris = new Map<number, number[]>()
  for (let t = 0; t < nT; t++) {
    const r = dsu.find(t)
    const list = regionTris.get(r)
    if (list) list.push(t)
    else regionTris.set(r, [t])
  }

  // Which regions touch each vertex — a vertex incident to ≥3 regions is a true
  // corner and must survive boundary simplification (else faces would tear).
  const vertRegions = new Map<number, Set<number>>()
  for (let t = 0; t < nT; t++) {
    const r = dsu.find(t)
    for (const v of [F[t * 3], F[t * 3 + 1], F[t * 3 + 2]]) {
      let set = vertRegions.get(v)
      if (!set) { set = new Set(); vertRegions.set(v, set) }
      set.add(r)
    }
  }
  const isCorner = (v: number): boolean => (vertRegions.get(v)?.size ?? 0) >= 3

  const faces: StepFace[] = []
  for (const [, tris] of regionTris) {
    // Region normal (average of member triangle normals).
    let rnx = 0, rny = 0, rnz = 0
    for (const t of tris) { rnx += normals[t * 3]; rny += normals[t * 3 + 1]; rnz += normals[t * 3 + 2] }
    const rlen = Math.hypot(rnx, rny, rnz) || 1
    const rn: [number, number, number] = [rnx / rlen, rny / rlen, rnz / rlen]

    // Boundary edges of the region = edges used by exactly one member triangle.
    const localCount = new Map<number, number>()
    for (const t of tris) {
      const a = F[t * 3], b = F[t * 3 + 1], c = F[t * 3 + 2]
      for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
        const k = edgeKey(x, y)
        localCount.set(k, (localCount.get(k) ?? 0) + 1)
      }
    }
    // Directed boundary edges, oriented by the triangle winding (CCW around rn).
    const nextFrom = new Map<number, number>()
    for (const t of tris) {
      const a = F[t * 3], b = F[t * 3 + 1], c = F[t * 3 + 2]
      for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
        if (localCount.get(edgeKey(x, y)) === 1) nextFrom.set(x, y)
      }
    }

    // Chain directed boundary edges into closed loops.
    const rawLoops: number[][] = []
    const used = new Set<number>()
    for (const start of nextFrom.keys()) {
      if (used.has(start)) continue
      const loop: number[] = []
      let cur = start
      let guard = 0
      while (!used.has(cur) && nextFrom.has(cur) && guard++ < nextFrom.size + 1) {
        used.add(cur)
        loop.push(cur)
        cur = nextFrom.get(cur)!
      }
      if (loop.length >= 3) rawLoops.push(loop)
    }
    if (rawLoops.length === 0) continue

    const simplified = rawLoops.map(l => simplifyLoop(l, V, cosCollinear, isCorner)).filter(l => l.length >= 3)
    if (simplified.length === 0) continue

    // Classify loops: positive signed area (along rn) = outer, negative = hole.
    let outer: number[] | null = null
    const holes: number[][] = []
    let bestArea = -Infinity
    for (const loop of simplified) {
      const area = signedArea(loop, V, rn)
      if (area >= 0 && area > bestArea) {
        if (outer) holes.push(outer)
        outer = loop
        bestArea = area
      } else {
        holes.push(loop)
      }
    }
    if (!outer) { outer = simplified[0]; holes.length = 0; holes.push(...simplified.slice(1)) }
    faces.push({ normal: rn, loops: [outer, ...holes] })
  }

  // Compact: keep only referenced vertices.
  const used = new Set<number>()
  for (const f of faces) for (const loop of f.loops) for (const v of loop) used.add(v)
  const remap = new Int32Array(V.length / 3).fill(-1)
  const outVerts: number[] = []
  const edgeSet = new Set<number>()
  for (const v of used) {
    remap[v] = outVerts.length / 3
    outVerts.push(V[v * 3], V[v * 3 + 1], V[v * 3 + 2])
  }
  const outFaces: StepFace[] = faces.map(f => ({
    normal: f.normal,
    loops: f.loops.map(loop => loop.map(v => remap[v])),
  }))
  for (const f of outFaces) {
    for (const loop of f.loops) {
      for (let i = 0; i < loop.length; i++) edgeSet.add(edgeKey(loop[i], loop[(i + 1) % loop.length]))
    }
  }

  return {
    brep: { vertices: Float32Array.from(outVerts), faces: outFaces },
    manifold: true,
    faceCount: outFaces.length,
    edgeCount: edgeSet.size,
    vertexCount: outVerts.length / 3,
  }
}

/** Remove collinear, non-corner vertices from a closed loop. */
function simplifyLoop(
  loop: number[],
  V: Float32Array,
  cosCollinear: number,
  isCorner: (v: number) => boolean,
): number[] {
  let ring = loop.slice()
  let changed = true
  while (changed && ring.length > 3) {
    changed = false
    for (let i = 0; i < ring.length; i++) {
      const v = ring[i]
      if (isCorner(v)) continue
      const u = ring[(i - 1 + ring.length) % ring.length]
      const wv = ring[(i + 1) % ring.length]
      let e1x = V[v * 3] - V[u * 3], e1y = V[v * 3 + 1] - V[u * 3 + 1], e1z = V[v * 3 + 2] - V[u * 3 + 2]
      let e2x = V[wv * 3] - V[v * 3], e2y = V[wv * 3 + 1] - V[v * 3 + 1], e2z = V[wv * 3 + 2] - V[v * 3 + 2]
      const l1 = Math.hypot(e1x, e1y, e1z) || 1
      const l2 = Math.hypot(e2x, e2y, e2z) || 1
      const dot = (e1x * e2x + e1y * e2y + e1z * e2z) / (l1 * l2)
      if (dot > cosCollinear) {
        ring.splice(i, 1)
        changed = true
        break
      }
    }
  }
  return ring
}

/** Signed area of a loop projected onto the plane with normal `n`. */
function signedArea(loop: number[], V: Float32Array, n: [number, number, number]): number {
  // Build an in-plane orthonormal basis (u, w).
  const ref: [number, number, number] = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  let ux = ref[1] * n[2] - ref[2] * n[1]
  let uy = ref[2] * n[0] - ref[0] * n[2]
  let uz = ref[0] * n[1] - ref[1] * n[0]
  const ul = Math.hypot(ux, uy, uz) || 1
  ux /= ul; uy /= ul; uz /= ul
  const wx = n[1] * uz - n[2] * uy
  const wy = n[2] * ux - n[0] * uz
  const wz = n[0] * uy - n[1] * ux

  let area = 0
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length]
    const xa = V[a * 3] * ux + V[a * 3 + 1] * uy + V[a * 3 + 2] * uz
    const ya = V[a * 3] * wx + V[a * 3 + 1] * wy + V[a * 3 + 2] * wz
    const xb = V[b * 3] * ux + V[b * 3 + 1] * uy + V[b * 3 + 2] * uz
    const yb = V[b * 3] * wx + V[b * 3 + 1] * wy + V[b * 3 + 2] * wz
    area += xa * yb - xb * ya
  }
  return area / 2
}
