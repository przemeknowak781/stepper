import { computeAABB, aabbDiagonal } from './boundingBox'

/**
 * Telling a sheet from a solid, and giving it a wall.
 *
 * Some inputs — anything exported from a surface modeller, a photogrammetry
 * scan, a generative model — are not solids at all but zero-thickness surfaces.
 * There is no correct STEP solid for such a file: the answer depends on a wall
 * thickness only the user knows. Solidifying one anyway produces a plate
 * exactly one voxel thick, which looks like a conversion bug (stair-stepped,
 * flat, nothing like the input) when it is really the honest consequence of an
 * impossible question.
 *
 * So the shell is detected and named, and the thickness is a number the user
 * supplies. This mirrors `tools/meshfix`, which refuses outright (criterion
 * A10) rather than inventing one.
 */

export interface ShellDiagnosis {
  /** 0 when the surface encloses volume like a solid, 1 for a flat sheet. */
  shellScore: number
  isShell: boolean
  /** Edges used by exactly one triangle. A closed mesh has none. */
  boundaryEdges: number
  area: number
  /** Divergence-theorem volume. Only a volume when the mesh is actually closed. */
  volume: number
  /**
   * Average wall the sheet currently has, `|volume| / area`. For a true
   * zero-thickness surface this is 0 — the number that explains everything.
   */
  impliedThickness: number
  /** A starting wall to offer the user: 1% of the bounding-box diagonal. */
  suggestedThickness: number
}

/**
 * Above this, treat the input as a surface rather than a solid.
 *
 * Matches `SHELL_SCORE_THRESHOLD` in meshfix. The score is the isoperimetric
 * quotient: a sphere scores 1 on `6*sqrt(pi)*V / A^1.5` and so 0 here, while a
 * sheet drives V to 0 and the score to 1. It is only consulted for surfaces
 * that bound no volume at all — see `MIN_RELATIVE_WALL`, which comes first,
 * because a genuinely thin-walled part is thin and the quotient cannot tell it
 * from a sheet.
 */
export const SHELL_SCORE_THRESHOLD = 0.9

/**
 * Thinnest wall, as a fraction of the body diagonal, that still counts as one.
 *
 * 0.1% is 0.5mm on a 500mm part and 0.02mm on a 20mm one — below any wall a
 * process can hold, and far above the rounding a zero-thickness surface
 * produces (which is exactly 0). The gap either side is wide, so the number is
 * not doing delicate work.
 */
const MIN_RELATIVE_WALL = 1e-3

export function diagnoseShell(vertices: Float32Array, indices: Uint32Array | null): ShellDiagnosis {
  const triangles = indices ? indices.length / 3 : vertices.length / 9
  const at = (t: number, corner: number): number =>
    indices ? indices[t * 3 + corner] * 3 : (t * 3 + corner) * 3

  // The census counts how many triangles use each edge, so it has to run over
  // *shared* vertices. An STL arrives as an un-indexed soup where every corner
  // is its own vertex and no edge is ever shared, which would read as "every
  // edge is a boundary" — or, if soups were exempted, as "no boundary at all",
  // and a closed model would be mistaken for a sheet. Welding by position first
  // is what makes the count mean anything.
  const box = computeAABB(vertices)
  const diagonal = aabbDiagonal(box)
  const tolerance = Math.max(diagonal * 1e-6, 1e-12)
  const welded = new Map<string, number>()
  const weld = (v: number): number => {
    const key = `${Math.round(vertices[v] / tolerance)},${Math.round(vertices[v + 1] / tolerance)},${Math.round(vertices[v + 2] / tolerance)}`
    const existing = welded.get(key)
    if (existing !== undefined) return existing
    const id = welded.size
    welded.set(key, id)
    return id
  }

  let area = 0
  let volume = 0
  const boundary = new Map<number, number>()

  for (let t = 0; t < triangles; t++) {
    const ia = at(t, 0)
    const ib = at(t, 1)
    const ic = at(t, 2)
    const ax = vertices[ia], ay = vertices[ia + 1], az = vertices[ia + 2]
    const bx = vertices[ib], by = vertices[ib + 1], bz = vertices[ib + 2]
    const cx = vertices[ic], cy = vertices[ic + 1], cz = vertices[ic + 2]

    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    area += Math.hypot(nx, ny, nz) / 2

    // a . (b x c) / 6, summed — the divergence volume.
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6

    for (let e = 0; e < 3; e++) {
      const p = weld(at(t, e))
      const q = weld(at(t, (e + 1) % 3))
      const key = p < q ? p * 33554432 + q : q * 33554432 + p
      boundary.set(key, (boundary.get(key) ?? 0) + 1)
    }
  }

  let boundaryEdges = 0
  for (const count of boundary.values()) if (count === 1) boundaryEdges++

  const quotient = area > 0 ? (6 * Math.sqrt(Math.PI) * Math.abs(volume)) / area ** 1.5 : 0
  const impliedThickness = area > 0 ? Math.abs(volume) / area : 0

  // The question is whether the surface bounds a body, and closedness alone
  // cannot answer it: capping a sheet's outer rim makes it closed while it
  // still bounds nothing. So the test is the wall the surface already implies.
  // A part with a real wall — the 1.2mm skin of a moulded case, say — is a
  // solid with defects, and asking its owner for a thickness would be asking
  // for one it has, then adding it a second time.
  const enclosesVolume = impliedThickness > diagonal * MIN_RELATIVE_WALL
  const shellScore = enclosesVolume
    ? 0
    : boundaryEdges === 0
      ? 1 // closed around nothing: a sheet whose rim was capped
      : area > 0
        ? 1 - Math.min(1, quotient)
        : 1

  return {
    shellScore,
    isShell: shellScore >= SHELL_SCORE_THRESHOLD,
    boundaryEdges,
    area,
    volume,
    impliedThickness,
    suggestedThickness: diagonal * 0.01,
  }
}

/**
 * Cap on the mitre extension, just above a cube corner's `sqrt(3)`.
 *
 * The exact factor diverges where a surface folds back on itself, and on a mesh
 * that needs repairing those vertices are common — uncapped, each one fires a
 * spike many times the wall thickness out of the model. Past three mutually
 * perpendicular faces the vertex normal is not bisecting anything, and
 * extending along it is guesswork.
 */
const MAX_MITER = 2

/**
 * Give an open surface a wall of `thickness`, so there is a solid to convert.
 *
 * Offsets by ±thickness/2 along angle-weighted vertex normals and closes the
 * rim with a quad band along every boundary edge. The offset is **mitred**:
 * stepping `t/2` along an averaged normal clears each incident face's plane by
 * only `t/2 * cos`, so an unmitred wall comes out thin at exactly the creases
 * where thickness matters most (37% thin on a folded box). Dividing by the
 * smallest cosine over the incident faces puts the surface back where it was
 * asked to be, erring thick rather than thin — a solidifier absorbs too much
 * material and pinches away too little.
 *
 * The result is closed but not necessarily clean; solidification handles that.
 */
export function thickenShell(
  vertices: Float32Array,
  indices: Uint32Array,
  thickness: number,
): { vertices: Float32Array; indices: Uint32Array } {
  if (!(thickness > 0)) throw new Error('wall thickness must be positive')

  const vertexCount = vertices.length / 3
  const triangles = indices.length / 3
  const normals = new Float32Array(vertices.length)
  const faceNormals = new Float32Array(triangles * 3)

  for (let t = 0; t < triangles; t++) {
    const ia = indices[t * 3] * 3
    const ib = indices[t * 3 + 1] * 3
    const ic = indices[t * 3 + 2] * 3
    const ux = vertices[ib] - vertices[ia]
    const uy = vertices[ib + 1] - vertices[ia + 1]
    const uz = vertices[ib + 2] - vertices[ia + 2]
    const vx = vertices[ic] - vertices[ia]
    const vy = vertices[ic + 1] - vertices[ia + 1]
    const vz = vertices[ic + 2] - vertices[ia + 2]
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const length = Math.hypot(nx, ny, nz)
    if (length === 0) continue // a degenerate face has no direction to offer
    nx /= length
    ny /= length
    nz /= length
    faceNormals[t * 3] = nx
    faceNormals[t * 3 + 1] = ny
    faceNormals[t * 3 + 2] = nz

    // Angle weighting, not area weighting: the result must not depend on how a
    // flat region happened to be triangulated.
    for (let corner = 0; corner < 3; corner++) {
      const here = indices[t * 3 + corner] * 3
      const next = indices[t * 3 + ((corner + 1) % 3)] * 3
      const prev = indices[t * 3 + ((corner + 2) % 3)] * 3
      const angle = cornerAngle(vertices, here, next, prev)
      normals[here] += nx * angle
      normals[here + 1] += ny * angle
      normals[here + 2] += nz * angle
    }
  }

  for (let v = 0; v < vertexCount; v++) {
    const length = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2])
    if (length === 0) continue
    normals[v * 3] /= length
    normals[v * 3 + 1] /= length
    normals[v * 3 + 2] /= length
  }

  // Smallest cosine between each vertex normal and the faces meeting there.
  const cosine = new Float32Array(vertexCount).fill(Infinity)
  for (let t = 0; t < triangles; t++) {
    const nx = faceNormals[t * 3]
    const ny = faceNormals[t * 3 + 1]
    const nz = faceNormals[t * 3 + 2]
    if (nx === 0 && ny === 0 && nz === 0) continue
    for (let corner = 0; corner < 3; corner++) {
      const v = indices[t * 3 + corner]
      const dot = normals[v * 3] * nx + normals[v * 3 + 1] * ny + normals[v * 3 + 2] * nz
      if (dot < cosine[v]) cosine[v] = dot
    }
  }

  const half = thickness / 2
  const out = new Float32Array(vertices.length * 2)
  for (let v = 0; v < vertexCount; v++) {
    const c = cosine[v]
    const miter = Number.isFinite(c) && c > 1 / MAX_MITER ? 1 / c : MAX_MITER
    const step = half * miter
    for (let axis = 0; axis < 3; axis++) {
      const base = vertices[v * 3 + axis]
      const offset = normals[v * 3 + axis] * step
      out[v * 3 + axis] = base + offset
      out[(vertexCount + v) * 3 + axis] = base - offset
    }
  }

  // Top shell, reversed bottom shell, and a quad band closing every edge that
  // only one triangle uses.
  const rim: number[] = []
  const used = new Map<number, number>()
  for (let t = 0; t < triangles; t++) {
    for (let e = 0; e < 3; e++) {
      const p = indices[t * 3 + e]
      const q = indices[t * 3 + ((e + 1) % 3)]
      const key = p < q ? p * 33554432 + q : q * 33554432 + p
      used.set(key, (used.get(key) ?? 0) + 1)
    }
  }
  for (let t = 0; t < triangles; t++) {
    for (let e = 0; e < 3; e++) {
      const p = indices[t * 3 + e]
      const q = indices[t * 3 + ((e + 1) % 3)]
      const key = p < q ? p * 33554432 + q : q * 33554432 + p
      if (used.get(key) !== 1) continue
      // The band hangs from the top shell, so it must be wound against the
      // face's own traversal of the edge: p -> q on top is counter-clockwise
      // seen from outside the top, which makes p -> q+bottom -> q the order
      // whose normal points away from the wall rather than into it.
      rim.push(p, q + vertexCount, q, p, p + vertexCount, q + vertexCount)
    }
  }

  const outIndices = new Uint32Array(indices.length * 2 + rim.length)
  outIndices.set(indices, 0)
  for (let t = 0; t < triangles; t++) {
    outIndices[indices.length + t * 3] = indices[t * 3 + 2] + vertexCount
    outIndices[indices.length + t * 3 + 1] = indices[t * 3 + 1] + vertexCount
    outIndices[indices.length + t * 3 + 2] = indices[t * 3] + vertexCount
  }
  outIndices.set(rim, indices.length * 2)

  return { vertices: out, indices: outIndices }
}

function cornerAngle(V: Float32Array, here: number, next: number, prev: number): number {
  let ux = V[next] - V[here]
  let uy = V[next + 1] - V[here + 1]
  let uz = V[next + 2] - V[here + 2]
  let vx = V[prev] - V[here]
  let vy = V[prev + 1] - V[here + 1]
  let vz = V[prev + 2] - V[here + 2]
  const lu = Math.hypot(ux, uy, uz)
  const lv = Math.hypot(vx, vy, vz)
  if (lu === 0 || lv === 0) return 0
  ux /= lu; uy /= lu; uz /= lu
  vx /= lv; vy /= lv; vz /= lv
  return Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy + uz * vz)))
}
