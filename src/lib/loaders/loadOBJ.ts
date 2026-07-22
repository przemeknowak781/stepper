import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { Mesh } from 'three'
import type { ParsedSTL } from '@/lib/stl/parseSTL'
import { meshToFlatBuffer, type NamedMesh } from './extractMeshes'

/**
 * Parse OBJ text into a list of named meshes; UI uses listMeshesFromOBJ
 * to show the multi-mesh selection dialog when more than one is present.
 * `loadOBJ` keeps backwards-compat by concatenating all meshes.
 */
export function listMeshesFromOBJ(text: string): NamedMesh[] {
  const loader = new OBJLoader()
  const group = loader.parse(text)
  const meshes: Mesh[] = []
  group.traverse(o => {
    if ((o as Mesh).isMesh) meshes.push(o as Mesh)
  })
  return meshes.map((m, i) => ({
    name: m.name || `mesh_${i + 1}`,
    ...meshToFlatBuffer(m),
  }))
}

export function loadOBJ(text: string): ParsedSTL {
  const list = listMeshesFromOBJ(text)
  if (list.length === 0) return { vertices: new Float32Array(0), triangleCount: 0 }
  if (list.length === 1) return { vertices: list[0].vertices, triangleCount: list[0].triangleCount }
  let total = 0
  for (const m of list) total += m.triangleCount
  const out = new Float32Array(total * 9)
  let offset = 0
  for (const m of list) {
    out.set(m.vertices, offset)
    offset += m.vertices.length
  }
  return { vertices: out, triangleCount: total }
}
