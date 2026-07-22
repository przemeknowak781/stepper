/**
 * STEP (ISO 10303-21, AP214) exporter for triangle-mesh solids.
 *
 * Emits an ADVANCED_BREP_SHAPE_REPRESENTATION built from a MANIFOLD_SOLID_BREP
 * whose CLOSED_SHELL is one planar ADVANCED_FACE per triangle.  Vertices and
 * edges are shared between adjacent faces (each undirected edge becomes one
 * EDGE_CURVE, referenced by two ORIENTED_EDGEs with opposite sense) so the
 * result is a genuine watertight B-rep solid — CAD tools (FreeCAD/OCCT,
 * SolidWorks, Fusion) import it as a real solid body, not a loose mesh.
 *
 * The full AP214 product/context boilerplate is included so the file opens
 * cleanly in every major CAD package, not just geometry-only viewers.
 */

interface Welded {
  vertices: Float32Array
  indices: Uint32Array
}

/**
 * Weld a (possibly non-indexed) mesh into shared vertices, dropping degenerate
 * triangles.  A shared-vertex, shared-edge topology is a hard requirement for a
 * valid MANIFOLD_SOLID_BREP; without it every triangle would carry its own
 * edges and the shell would not be closed.
 */
export function weldMesh(
  vertices: Float32Array,
  indices: Uint32Array | null,
  tol: number,
): Welded {
  const triCount = indices ? indices.length / 3 : vertices.length / 9
  const keyToId = new Map<string, number>()
  const outVerts: number[] = []
  const invTol = 1 / tol

  const resolve = (x: number, y: number, z: number): number => {
    const key = `${Math.round(x * invTol)}_${Math.round(y * invTol)}_${Math.round(z * invTol)}`
    const existing = keyToId.get(key)
    if (existing !== undefined) return existing
    const id = outVerts.length / 3
    outVerts.push(x, y, z)
    keyToId.set(key, id)
    return id
  }

  const outIdx: number[] = []
  for (let t = 0; t < triCount; t++) {
    let ia: number, ib: number, ic: number
    if (indices) {
      ia = indices[t * 3]; ib = indices[t * 3 + 1]; ic = indices[t * 3 + 2]
    } else {
      ia = t * 3; ib = t * 3 + 1; ic = t * 3 + 2
    }
    const a = resolve(vertices[ia * 3], vertices[ia * 3 + 1], vertices[ia * 3 + 2])
    const b = resolve(vertices[ib * 3], vertices[ib * 3 + 1], vertices[ib * 3 + 2])
    const c = resolve(vertices[ic * 3], vertices[ic * 3 + 1], vertices[ic * 3 + 2])
    if (a === b || b === c || c === a) continue // degenerate — skip
    outIdx.push(a, b, c)
  }
  return { vertices: Float32Array.from(outVerts), indices: Uint32Array.from(outIdx) }
}

export interface StepExportOptions {
  /** Product/part name embedded in the STEP header and PRODUCT entity. */
  name?: string
  /** Weld tolerance (mm).  Defaults to 1e-4 of nothing — set per model size. */
  weldTolerance?: number
}

class EntityWriter {
  private lines: string[] = []
  private id = 0
  add(body: string): number {
    const ref = ++this.id
    this.lines.push(`#${ref}=${body};`)
    return ref
  }
  get text(): string {
    return this.lines.join('\n')
  }
}

function num(n: number): string {
  // STEP reals must contain a decimal point and must NOT use JS's lowercase
  // 'e' exponent form.  Fixed 6-decimal (nanometre-in-mm) notation avoids
  // exponential output entirely while keeping ample CAD precision.
  if (!Number.isFinite(n)) n = 0
  if (Number.isInteger(n)) return `${n}.`
  let s = n.toFixed(6).replace(/0+$/, '')
  if (s.endsWith('.')) s += '0' // keep exactly one digit after the point
  return s
}

/**
 * Build the STEP text for a single triangle-mesh solid.
 */
export function exportSTEP(
  vertices: Float32Array,
  indices: Uint32Array | null,
  options: StepExportOptions = {},
): string {
  const name = (options.name ?? 'part').replace(/'/g, '')
  const tol = options.weldTolerance ?? 1e-4
  const mesh = weldMesh(vertices, indices, tol)
  const { vertices: V, indices: F } = mesh

  const w = new EntityWriter()

  // --- Shared placement/direction primitives -------------------------------
  const origin = w.add('CARTESIAN_POINT(\'\',(0.,0.,0.))')
  const dirZ = w.add('DIRECTION(\'\',(0.,0.,1.))')
  const dirX = w.add('DIRECTION(\'\',(1.,0.,0.))')
  const axisPlacement = w.add(`AXIS2_PLACEMENT_3D('',#${origin},#${dirZ},#${dirX})`)

  // --- Vertices: one CARTESIAN_POINT + VERTEX_POINT per welded vertex ------
  const nV = V.length / 3
  const pointRef = new Int32Array(nV)
  const vertexRef = new Int32Array(nV)
  for (let v = 0; v < nV; v++) {
    const p = w.add(
      `CARTESIAN_POINT('',(${num(V[v * 3])},${num(V[v * 3 + 1])},${num(V[v * 3 + 2])}))`,
    )
    pointRef[v] = p
    vertexRef[v] = w.add(`VERTEX_POINT('',#${p})`)
  }

  // --- Edges: one EDGE_CURVE (with a LINE) per undirected vertex pair -------
  interface EdgeRec { curve: number; lo: number; hi: number }
  const edgeMap = new Map<number, EdgeRec>()
  const edgeKey = (a: number, b: number) => {
    const lo = a < b ? a : b
    const hi = a < b ? b : a
    return lo * 0x4000000 + hi
  }
  const getEdge = (a: number, b: number): EdgeRec => {
    const k = edgeKey(a, b)
    let rec = edgeMap.get(k)
    if (rec) return rec
    const lo = a < b ? a : b
    const hi = a < b ? b : a
    const dx = V[hi * 3] - V[lo * 3]
    const dy = V[hi * 3 + 1] - V[lo * 3 + 1]
    const dz = V[hi * 3 + 2] - V[lo * 3 + 2]
    const len = Math.hypot(dx, dy, dz) || 1
    const dir = w.add(`DIRECTION('',(${num(dx / len)},${num(dy / len)},${num(dz / len)}))`)
    const vec = w.add(`VECTOR('',#${dir},${num(len)})`)
    const line = w.add(`LINE('',#${pointRef[lo]},#${vec})`)
    const curve = w.add(`EDGE_CURVE('',#${vertexRef[lo]},#${vertexRef[hi]},#${line},.T.)`)
    rec = { curve, lo, hi }
    edgeMap.set(k, rec)
    return rec
  }

  // --- Faces: one planar ADVANCED_FACE per triangle ------------------------
  const faceRefs: number[] = []
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t], b = F[t + 1], c = F[t + 2]
    const ax = V[a * 3], ay = V[a * 3 + 1], az = V[a * 3 + 2]
    const bx = V[b * 3], by = V[b * 3 + 1], bz = V[b * 3 + 2]
    const cx = V[c * 3], cy = V[c * 3 + 1], cz = V[c * 3 + 2]
    // Face normal (Newell/cross); skip if degenerate.
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    const nlen = Math.hypot(nx, ny, nz)
    if (nlen < 1e-12) continue
    nx /= nlen; ny /= nlen; nz /= nlen
    // In-plane reference direction from vertex a toward b.
    let rx = bx - ax, ry = by - ay, rz = bz - az
    const rlen = Math.hypot(rx, ry, rz) || 1
    rx /= rlen; ry /= rlen; rz /= rlen

    const oriented: string[] = []
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const edge = getEdge(p, q)
      // ORIENTED_EDGE sense: .T. when the directed use matches lo→hi.
      const sense = p === edge.lo ? '.T.' : '.F.'
      oriented.push(`#${w.add(`ORIENTED_EDGE('',*,*,#${edge.curve},${sense})`)}`)
    }
    const loop = w.add(`EDGE_LOOP('',(${oriented.join(',')}))`)
    const bound = w.add(`FACE_OUTER_BOUND('',#${loop},.T.)`)
    const normDir = w.add(`DIRECTION('',(${num(nx)},${num(ny)},${num(nz)}))`)
    const refDir = w.add(`DIRECTION('',(${num(rx)},${num(ry)},${num(rz)}))`)
    const placement = w.add(`AXIS2_PLACEMENT_3D('',#${pointRef[a]},#${normDir},#${refDir})`)
    const plane = w.add(`PLANE('',#${placement})`)
    faceRefs.push(w.add(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`))
  }

  if (faceRefs.length === 0) {
    throw new Error('exportSTEP: mesh has no non-degenerate triangles')
  }

  const shell = w.add(`CLOSED_SHELL('',(${faceRefs.map(f => `#${f}`).join(',')}))`)
  const brep = w.add(`MANIFOLD_SOLID_BREP('${name}',#${shell})`)

  // --- Representation context + units --------------------------------------
  const lengthUnit = w.add('( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )')
  const angleUnit = w.add('( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )')
  const solidAngleUnit = w.add('( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )')
  const uncertainty = w.add(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(${num(tol)}),#${lengthUnit},'distance_accuracy_value','')`,
  )
  const context = w.add(
    `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnit},#${angleUnit},#${solidAngleUnit})) REPRESENTATION_CONTEXT('Context','3D') )`,
  )
  const shapeRep = w.add(
    `ADVANCED_BREP_SHAPE_REPRESENTATION('',(#${brep},#${axisPlacement}),#${context})`,
  )

  // --- Product / AP214 boilerplate -----------------------------------------
  const appContext = w.add(
    'APPLICATION_CONTEXT(\'automotive design\')',
  )
  w.add(
    `APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appContext})`,
  )
  const product = w.add(
    `PRODUCT('${name}','${name}','',(#${w.add(`PRODUCT_CONTEXT('',#${appContext},'mechanical')`)}))`,
  )
  w.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(#${product}))`)
  const formation = w.add(
    `PRODUCT_DEFINITION_FORMATION('','',#${product})`,
  )
  const pdContext = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appContext},'design')`)
  const productDef = w.add(
    `PRODUCT_DEFINITION('design','',#${formation},#${pdContext})`,
  )
  const productDefShape = w.add(
    `PRODUCT_DEFINITION_SHAPE('','',#${productDef})`,
  )
  w.add(
    `SHAPE_DEFINITION_REPRESENTATION(#${productDefShape},#${shapeRep})`,
  )

  const header = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('STEP AP214 solid generated by Stepper'),'2;1');",
    `FILE_NAME('${name}.step','1970-01-01T00:00:00',(''),(''),'Stepper','Stepper 0.1','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
  ].join('\n')

  return [header, 'DATA;', w.text, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n')
}
