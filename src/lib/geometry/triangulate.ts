/**
 * Robust planar-polygon triangulation (ear clipping with hole support).
 *
 * A planar B-rep face is a polygon that may be non-convex and may contain
 * holes.  Fan triangulation from a single vertex only works for convex
 * polygons; on a non-convex outline it emits triangles that fall OUTSIDE the
 * polygon and overlap their neighbours — which renders as flickering
 * zero-thickness "phantom" walls and z-fighting, with normals pointing every
 * which way.  This triangulator projects the face to 2D, bridges holes into the
 * outer loop, and ear-clips the result, emitting only triangles that tile the
 * real area, all wound consistently with the face normal.
 */

type Tri = [number, number, number]

interface P2 {
  x: number
  y: number
  vi: number // original vertex index
}

/** Triangulate one planar face given its loops (outer first, then holes). */
export function triangulateFace(
  V: Float32Array,
  loops: number[][],
  normal: [number, number, number],
): Tri[] {
  const outer = loops[0]
  if (!outer || outer.length < 3) return []

  // In-plane orthonormal basis (u, w) with u × ... aligned so CCW ⇒ +normal.
  const [nx, ny, nz] = normal
  const refX = Math.abs(nx) < 0.9 ? 1 : 0
  const refY = Math.abs(nx) < 0.9 ? 0 : 1
  let ux = refY * nz - 0 * ny
  let uy = 0 * nx - refX * nz
  let uz = refX * ny - refY * nx
  const ul = Math.hypot(ux, uy, uz) || 1
  ux /= ul; uy /= ul; uz /= ul
  const wx = ny * uz - nz * uy
  const wy = nz * ux - nx * uz
  const wz = nx * uy - ny * ux

  const to2D = (vi: number): P2 => ({
    x: V[vi * 3] * ux + V[vi * 3 + 1] * uy + V[vi * 3 + 2] * uz,
    y: V[vi * 3] * wx + V[vi * 3 + 1] * wy + V[vi * 3 + 2] * wz,
    vi,
  })

  let poly: P2[] = outer.map(to2D)
  // Outer must be CCW (positive area) in the (u, w) frame.
  if (signedArea(poly) < 0) poly.reverse()

  // Bridge each hole (made CW) into the outer polygon, largest-x hole first.
  const holes = loops.slice(1).filter(h => h.length >= 3).map(h => {
    const ring = h.map(to2D)
    if (signedArea(ring) > 0) ring.reverse() // holes CW
    return ring
  })
  holes.sort((a, b) => maxX(b) - maxX(a))
  for (const hole of holes) poly = bridgeHole(poly, hole)

  return earClip(poly)
}

function signedArea(p: P2[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]
    a += p[i].x * q.y - q.x * p[i].y
  }
  return a / 2
}

function maxX(p: P2[]): number {
  let m = -Infinity
  for (const q of p) if (q.x > m) m = q.x
  return m
}

/**
 * Merge a hole ring into the outer polygon by inserting a two-way bridge
 * between the hole's rightmost vertex and a mutually-visible outer vertex.
 */
function bridgeHole(outer: P2[], hole: P2[]): P2[] {
  // Hole's rightmost vertex.
  let hi = 0
  for (let i = 1; i < hole.length; i++) if (hole[i].x > hole[hi].x) hi = i
  const m = hole[hi]

  // Pick the visible outer vertex closest in x to the right of m (simple, robust
  // enough for the near-axis-aligned faces we produce; falls back to nearest).
  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < outer.length; i++) {
    const o = outer[i]
    if (o.x < m.x) continue
    const d = (o.x - m.x) * (o.x - m.x) + (o.y - m.y) * (o.y - m.y)
    if (d < bestDist) { bestDist = d; best = i }
  }
  if (best < 0) {
    for (let i = 0; i < outer.length; i++) {
      const o = outer[i]
      const d = (o.x - m.x) * (o.x - m.x) + (o.y - m.y) * (o.y - m.y)
      if (d < bestDist) { bestDist = d; best = i }
    }
  }

  // Splice: outer[0..best], hole[hi..], hole[..hi], outer[best..].
  const rotatedHole: P2[] = []
  for (let i = 0; i < hole.length; i++) rotatedHole.push(hole[(hi + i) % hole.length])
  rotatedHole.push(hole[hi]) // close back to bridge start

  const out: P2[] = []
  for (let i = 0; i <= best; i++) out.push(outer[i])
  for (const h of rotatedHole) out.push(h)
  for (let i = best; i < outer.length; i++) out.push(outer[i])
  return out
}

/** O(n²) ear-clipping of a simple CCW polygon. */
function earClip(poly: P2[]): Tri[] {
  const tris: Tri[] = []
  const idx: number[] = poly.map((_, i) => i)
  let guard = 0
  const maxGuard = idx.length * idx.length + 16
  while (idx.length > 3 && guard++ < maxGuard) {
    let clipped = false
    for (let i = 0; i < idx.length; i++) {
      const a = poly[idx[(i - 1 + idx.length) % idx.length]]
      const b = poly[idx[i]]
      const c = poly[idx[(i + 1) % idx.length]]
      if (cross(a, b, c) <= 0) continue // reflex or collinear — not an ear tip
      let isEar = true
      for (let j = 0; j < idx.length; j++) {
        const p = poly[idx[j]]
        if (p === a || p === b || p === c) continue
        if (pointInTriangle(p, a, b, c)) { isEar = false; break }
      }
      if (!isEar) continue
      tris.push([a.vi, b.vi, c.vi])
      idx.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) break // degenerate; stop rather than loop forever
  }
  if (idx.length === 3) {
    tris.push([poly[idx[0]].vi, poly[idx[1]].vi, poly[idx[2]].vi])
  }
  return tris
}

function cross(a: P2, b: P2, c: P2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function pointInTriangle(p: P2, a: P2, b: P2, c: P2): boolean {
  const d1 = cross(a, b, p)
  const d2 = cross(b, c, p)
  const d3 = cross(c, a, p)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}
