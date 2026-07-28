import { triangulateFace } from '../geometry/triangulate'

/**
 * STEP (ISO 10303-21) → triangle-mesh importer — the reverse of the exporter.
 *
 * It reads the B-rep topology (shells → faces → bounds → edge loops →
 * vertices) and triangulates every face polygon in its own plane (ear clipping,
 * with holes).  Planar / faceted B-reps — which is what Stepper writes, and what
 * a large share of mechanical STEP parts are — come back EXACTLY.  Curved
 * surfaces (B-spline/cylinder/cone) are approximated by the polygon through
 * their edge vertices: coarse, but it still yields a usable mesh rather than
 * nothing.  `POLY_LOOP` (faceted_brep) and `EDGE_LOOP` are both handled.
 */
export interface ParsedSTEP {
  vertices: Float32Array
  triangleCount: number
}

type Value =
  | number
  | { ref: number }
  | { str: string }
  | { enum: string }
  | Value[]
  | { typed: string; args: Value[] }
  | null
  | '*'

interface Entity {
  type: string
  args: string
}

/** Split a STEP argument string on top-level commas, respecting quotes and nesting. */
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let inStr = false
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      cur += c
      if (c === "'") {
        // '' is an escaped quote inside a string.
        if (s[i + 1] === "'") { cur += "'"; i++ }
        else inStr = false
      }
      continue
    }
    if (c === "'") { inStr = true; cur += c; continue }
    if (c === '(') { depth++; cur += c; continue }
    if (c === ')') { depth--; cur += c; continue }
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  if (cur.trim().length) out.push(cur.trim())
  return out
}

function interpret(token: string): Value {
  const t = token.trim()
  if (t.length === 0) return null
  const c = t[0]
  if (c === '#') return { ref: parseInt(t.slice(1), 10) }
  if (c === "'") return { str: t.slice(1, -1).replace(/''/g, "'") }
  if (c === '(') return splitTopLevel(t.slice(1, -1)).map(interpret)
  if (c === '.') return { enum: t }
  if (t === '$') return null
  if (t === '*') return '*'
  // Typed value like LENGTH_MEASURE(1.0) — keep name + args (rarely needed).
  const paren = t.indexOf('(')
  if (paren > 0 && /^[A-Za-z]/.test(t)) {
    return { typed: t.slice(0, paren), args: splitTopLevel(t.slice(paren + 1, t.lastIndexOf(')'))).map(interpret) }
  }
  return parseFloat(t.replace(/[dD]/g, 'E'))
}

function isRef(v: Value): v is { ref: number } {
  return typeof v === 'object' && v !== null && 'ref' in v
}

export function parseSTEP(text: string): ParsedSTEP {
  const dataStart = text.indexOf('DATA;')
  const searchFrom = dataStart >= 0 ? dataStart + 5 : 0
  const dataEnd = text.indexOf('ENDSEC;', searchFrom)
  const body = text.slice(searchFrom, dataEnd >= 0 ? dataEnd : text.length)

  // Split the DATA section into `#id = TYPE(...)` statements (quote-aware).
  const entities = new Map<number, Entity>()
  {
    let inStr = false
    let cur = ''
    for (let i = 0; i < body.length; i++) {
      const c = body[i]
      if (inStr) {
        cur += c
        if (c === "'") { if (body[i + 1] === "'") { cur += "'"; i++ } else inStr = false }
        continue
      }
      if (c === "'") { inStr = true; cur += c; continue }
      if (c === ';') {
        const st = cur.trim()
        cur = ''
        if (st[0] !== '#') continue
        const eq = st.indexOf('=')
        if (eq < 0) continue
        const id = parseInt(st.slice(1, eq), 10)
        if (!Number.isFinite(id)) continue
        const rest = st.slice(eq + 1).trim()
        const p = rest.indexOf('(')
        if (p < 0) continue
        const type = rest.slice(0, p).trim().toUpperCase()
        const args = rest.slice(p + 1, rest.lastIndexOf(')'))
        entities.set(id, { type, args })
        continue
      }
      cur += c
    }
  }

  const argCache = new Map<number, Value[]>()
  const argsOf = (id: number): Value[] => {
    const cached = argCache.get(id)
    if (cached) return cached
    const e = entities.get(id)
    const parsed = e ? splitTopLevel(e.args).map(interpret) : []
    argCache.set(id, parsed)
    return parsed
  }
  const typeOf = (id: number) => entities.get(id)?.type ?? ''

  // --- Vertex coordinates -------------------------------------------------
  const pointCache = new Map<number, number>() // cartesian_point id → vertex index
  const verts: number[] = []
  const cartesianIndex = (id: number): number | null => {
    const cached = pointCache.get(id)
    if (cached !== undefined) return cached
    const a = argsOf(id)
    // CARTESIAN_POINT('',(x,y,z))
    const coords = a.find(Array.isArray) as Value[] | undefined
    if (!coords) return null
    const x = typeof coords[0] === 'number' ? coords[0] : 0
    const y = typeof coords[1] === 'number' ? coords[1] : 0
    const z = typeof coords[2] === 'number' ? coords[2] : 0
    const idx = verts.length / 3
    verts.push(x, y, z)
    pointCache.set(id, idx)
    return idx
  }
  const vertexPointIndex = (id: number): number | null => {
    // VERTEX_POINT('',#cartesian_point)
    const a = argsOf(id)
    const ref = a.find(isRef)
    return ref ? cartesianIndex(ref.ref) : null
  }

  // --- Loop → ordered vertex-index ring -----------------------------------
  const loopRing = (loopId: number): number[] => {
    const t = typeOf(loopId)
    const a = argsOf(loopId)
    const ring: number[] = []
    if (t === 'POLY_LOOP') {
      const list = a.find(Array.isArray) as Value[] | undefined
      if (list) for (const v of list) if (isRef(v)) {
        const idx = cartesianIndex(v.ref)
        if (idx !== null) ring.push(idx)
      }
      return ring
    }
    // EDGE_LOOP('',(#oriented_edge,...))
    const list = a.find(Array.isArray) as Value[] | undefined
    if (!list) return ring
    for (const oe of list) {
      if (!isRef(oe)) continue
      const oea = argsOf(oe.ref) // ORIENTED_EDGE('',*,*,#edge,.T.)
      const edgeRef = oea.find(isRef)
      const orient = oea.find((v): v is { enum: string } => typeof v === 'object' && v !== null && 'enum' in v)
      if (!edgeRef) continue
      const ea = argsOf(edgeRef.ref) // EDGE_CURVE('',#v1,#v2,#curve,bool)
      const vrefs = ea.filter(isRef)
      if (vrefs.length < 2) continue
      const forward = !orient || orient.enum === '.T.'
      const startVp = forward ? vrefs[0].ref : vrefs[1].ref
      const idx = vertexPointIndex(startVp)
      if (idx !== null) ring.push(idx)
    }
    return ring
  }

  // A bound = FACE_OUTER_BOUND / FACE_BOUND('',#loop,orientation)
  const boundRing = (boundId: number): number[] => {
    const a = argsOf(boundId)
    const loopRef = a.find(isRef)
    if (!loopRef) return []
    const ring = loopRing(loopRef.ref)
    const orient = a.find((v): v is { enum: string } => typeof v === 'object' && v !== null && 'enum' in v)
    if (orient && orient.enum === '.F.') ring.reverse()
    return ring
  }

  // --- Faces --------------------------------------------------------------
  const indices: number[] = []
  const addFace = (faceId: number) => {
    const a = argsOf(faceId)
    // ADVANCED_FACE('',(#bound,...),#surface,sameSense)
    const boundsList = a.find(Array.isArray) as Value[] | undefined
    if (!boundsList) return
    let outer: number[] | null = null
    const holes: number[][] = []
    for (const b of boundsList) {
      if (!isRef(b)) continue
      const ring = boundRing(b.ref)
      if (ring.length < 3) continue
      if (typeOf(b.ref) === 'FACE_OUTER_BOUND' && !outer) outer = ring
      else if (outer) holes.push(ring)
      else outer = ring // first bound becomes outer if none is explicitly outer
    }
    if (!outer || outer.length < 3) return
    const normal = newell(outer, verts)
    if (!normal) return
    const V = Float32Array.from(verts)
    for (const tri of triangulateFace(V, [outer, ...holes], normal)) {
      indices.push(tri[0], tri[1], tri[2])
    }
  }

  for (const [id, e] of entities) {
    if (e.type === 'ADVANCED_FACE' || e.type === 'FACE_SURFACE') addFace(id)
  }

  // Emit a non-indexed triangle soup (matches parseSTL's output shape).
  const out = new Float32Array(indices.length * 3)
  for (let t = 0; t < indices.length; t++) {
    const vi = indices[t]
    out[t * 3] = verts[vi * 3]
    out[t * 3 + 1] = verts[vi * 3 + 1]
    out[t * 3 + 2] = verts[vi * 3 + 2]
  }
  return { vertices: out, triangleCount: indices.length / 3 }
}

/** Newell-method normal of a vertex-index ring; null if degenerate. */
function newell(ring: number[], V: number[]): [number, number, number] | null {
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
