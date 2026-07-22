import { useCallback } from 'react'
import { loadFileOutcome } from '@/lib/loaders/load3DFile'
import { useConverterStore } from '@/state/converterStore'
import type { MainMeshData } from '@/types/project'
import type { NamedMesh } from '@/lib/loaders/extractMeshes'

/** Concatenate several named meshes into one triangle soup. */
function mergeMeshes(meshes: NamedMesh[]): MainMeshData {
  let total = 0
  for (const m of meshes) total += m.triangleCount
  const out = new Float32Array(total * 9)
  let offset = 0
  for (const m of meshes) {
    out.set(m.vertices, offset)
    offset += m.vertices.length
  }
  return { vertices: out, indices: null, triangleCount: total }
}

/**
 * Load a dropped/selected 3D file into the store.  Multi-mesh OBJ/GLTF files
 * are merged into a single object (the converter treats the whole scene as one
 * body to seal) — an MVP simplification of Optimizer's per-mesh picker.
 */
export function useUpload() {
  return useCallback(async (file: File) => {
    const store = useConverterStore.getState()
    try {
      const outcome = await loadFileOutcome(file)
      const mesh = outcome.kind === 'single' ? outcome.data : mergeMeshes(outcome.meshes)
      if (mesh.triangleCount === 0) {
        store.setError('The file contained no triangles.')
        return
      }
      store.setInput(mesh, file.name)
    } catch (err) {
      store.setError(err instanceof Error ? err.message : 'Could not read file')
    }
  }, [])
}
