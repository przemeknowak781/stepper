import type { Mesh, BufferGeometry } from 'three'
import type { ParsedSTL } from '@/lib/stl/parseSTL'

/**
 * Flatten a single three.js Mesh (indexed or non-indexed) into a flat
 * Float32Array with 9 floats per triangle (3 verts × 3 components), applying
 * `mesh.matrixWorld` so nested transforms are baked into the vertex buffer.
 */
export function meshToFlatBuffer(mesh: Mesh): ParsedSTL {
  const g = mesh.geometry as BufferGeometry
  const pos = g.attributes.position
  const idx = g.index
  const m = mesh.matrixWorld
  mesh.updateMatrixWorld(true)

  const applyMatrix = (x: number, y: number, z: number): [number, number, number] => {
    const tx = m.elements[0] * x + m.elements[4] * y + m.elements[8] * z + m.elements[12]
    const ty = m.elements[1] * x + m.elements[5] * y + m.elements[9] * z + m.elements[13]
    const tz = m.elements[2] * x + m.elements[6] * y + m.elements[10] * z + m.elements[14]
    return [tx, ty, tz]
  }

  if (idx) {
    const tris = idx.count / 3
    const buf = new Float32Array(tris * 9)
    for (let i = 0; i < idx.count; i++) {
      const vi = idx.getX(i)
      const [tx, ty, tz] = applyMatrix(pos.getX(vi), pos.getY(vi), pos.getZ(vi))
      buf[i * 3]     = tx
      buf[i * 3 + 1] = ty
      buf[i * 3 + 2] = tz
    }
    return { vertices: buf, triangleCount: tris }
  }

  const tris = pos.count / 3
  const buf = new Float32Array(tris * 9)
  for (let i = 0; i < pos.count; i++) {
    const [tx, ty, tz] = applyMatrix(pos.getX(i), pos.getY(i), pos.getZ(i))
    buf[i * 3]     = tx
    buf[i * 3 + 1] = ty
    buf[i * 3 + 2] = tz
  }
  return { vertices: buf, triangleCount: tris }
}

export interface NamedMesh extends ParsedSTL {
  name: string
}
