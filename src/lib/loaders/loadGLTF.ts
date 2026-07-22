import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { Mesh } from 'three'
import type { ParsedSTL } from '@/lib/stl/parseSTL'
import { meshToFlatBuffer, type NamedMesh } from './extractMeshes'

export function listMeshesFromGLTF(buffer: ArrayBuffer): Promise<NamedMesh[]> {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader()
    loader.parse(
      buffer,
      '',
      gltf => {
        const meshes: Mesh[] = []
        gltf.scene.traverse(o => {
          if ((o as Mesh).isMesh) meshes.push(o as Mesh)
        })
        const named = meshes.map((m, i) => ({
          name: m.name || `mesh_${i + 1}`,
          ...meshToFlatBuffer(m),
        }))
        resolve(named)
      },
      err => reject(err),
    )
  })
}

export async function loadGLTF(buffer: ArrayBuffer): Promise<ParsedSTL> {
  const list = await listMeshesFromGLTF(buffer)
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
