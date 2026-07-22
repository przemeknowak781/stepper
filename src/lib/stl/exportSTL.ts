function computeNormal(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): [number, number, number] {
  const ux = bx - ax, uy = by - ay, uz = bz - az
  const vx = cx - ax, vy = cy - ay, vz = cz - az
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

/**
 * Write a binary STL from a vertex buffer and a list of vertex indices
 * (3 per triangle).  Header is 80 zero bytes, matching the reference
 * m2_*.stl artefacts that the golden test compares against.
 */
export function writeBinarySTL(
  vertices: Float32Array,
  triangleVertexIndices: Uint32Array | ArrayLike<number>,
): ArrayBuffer {
  const triCount = Math.floor(triangleVertexIndices.length / 3)
  const buffer = new ArrayBuffer(84 + triCount * 50)
  const dv = new DataView(buffer)

  dv.setUint32(80, triCount, true)

  let offset = 84
  for (let i = 0; i < triCount; i++) {
    const a = triangleVertexIndices[i * 3]
    const b = triangleVertexIndices[i * 3 + 1]
    const c = triangleVertexIndices[i * 3 + 2]

    const ax = vertices[a * 3],     ay = vertices[a * 3 + 1], az = vertices[a * 3 + 2]
    const bx = vertices[b * 3],     by = vertices[b * 3 + 1], bz = vertices[b * 3 + 2]
    const cx = vertices[c * 3],     cy = vertices[c * 3 + 1], cz = vertices[c * 3 + 2]

    const [nx, ny, nz] = computeNormal(ax, ay, az, bx, by, bz, cx, cy, cz)

    dv.setFloat32(offset, nx, true); offset += 4
    dv.setFloat32(offset, ny, true); offset += 4
    dv.setFloat32(offset, nz, true); offset += 4

    dv.setFloat32(offset, ax, true); offset += 4
    dv.setFloat32(offset, ay, true); offset += 4
    dv.setFloat32(offset, az, true); offset += 4

    dv.setFloat32(offset, bx, true); offset += 4
    dv.setFloat32(offset, by, true); offset += 4
    dv.setFloat32(offset, bz, true); offset += 4

    dv.setFloat32(offset, cx, true); offset += 4
    dv.setFloat32(offset, cy, true); offset += 4
    dv.setFloat32(offset, cz, true); offset += 4

    dv.setUint16(offset, 0, true);   offset += 2
  }
  return buffer
}

/**
 * Write a binary STL when the mesh is non-indexed (vertex buffer has 9 floats
 * per triangle already in order).  Convenience for use in tests and exporters.
 */
export function writeBinarySTLNonIndexed(vertices: Float32Array): ArrayBuffer {
  const triCount = Math.floor(vertices.length / 9)
  const indices = new Uint32Array(triCount * 3)
  for (let i = 0; i < triCount * 3; i++) indices[i] = i
  return writeBinarySTL(vertices, indices)
}
