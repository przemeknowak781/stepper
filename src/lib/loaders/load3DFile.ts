import { parseSTL } from '@/lib/stl/parseSTL'
import { listMeshesFromOBJ } from './loadOBJ'
import { listMeshesFromGLTF } from './loadGLTF'
import type { MainMeshData } from '@/types/project'
import type { NamedMesh } from './extractMeshes'

export type SupportedFormat = 'stl' | 'obj' | 'gltf' | 'glb'

function extension(filename: string): SupportedFormat | null {
  const m = filename.toLowerCase().match(/\.(stl|obj|gltf|glb)$/)
  if (!m) return null
  return m[1] as SupportedFormat
}

function toMainMeshData(parsed: { vertices: Float32Array; triangleCount: number }): MainMeshData {
  return {
    vertices: parsed.vertices,
    indices: null,
    triangleCount: parsed.triangleCount,
  }
}

/**
 * Result type that lets the caller distinguish between a single-mesh load
 * (auto-take it) and a multi-mesh OBJ/GLTF where the user must pick which
 * mesh is the main object (spec §13: "Multi-mesh w jednym pliku ...
 * Dialog wyboru: który mesh jest głównym").
 */
export type LoadOutcome =
  | { kind: 'single'; data: MainMeshData }
  | { kind: 'multi'; meshes: NamedMesh[] }

export async function loadFileOutcome(file: File): Promise<LoadOutcome> {
  const fmt = extension(file.name)
  if (!fmt) throw new Error(`Unsupported file extension: ${file.name}`)

  if (fmt === 'stl') {
    const buf = await file.arrayBuffer()
    return { kind: 'single', data: toMainMeshData(parseSTL(buf)) }
  }
  if (fmt === 'obj') {
    const text = await file.text()
    const list = listMeshesFromOBJ(text)
    if (list.length <= 1) {
      return { kind: 'single', data: toMainMeshData(list[0] ?? { vertices: new Float32Array(0), triangleCount: 0 }) }
    }
    return { kind: 'multi', meshes: list }
  }
  // gltf / glb
  const buf = await file.arrayBuffer()
  const list = await listMeshesFromGLTF(buf)
  if (list.length <= 1) {
    return { kind: 'single', data: toMainMeshData(list[0] ?? { vertices: new Float32Array(0), triangleCount: 0 }) }
  }
  return { kind: 'multi', meshes: list }
}

/**
 * Back-compat helper used by code paths that don't need the multi-mesh
 * disambiguation (e.g. fixture loaders).  Returns a single concatenated
 * mesh when the file holds more than one.
 */
export async function load3DFile(file: File): Promise<MainMeshData> {
  const outcome = await loadFileOutcome(file)
  if (outcome.kind === 'single') return outcome.data
  let total = 0
  for (const m of outcome.meshes) total += m.triangleCount
  const out = new Float32Array(total * 9)
  let offset = 0
  for (const m of outcome.meshes) {
    out.set(m.vertices, offset)
    offset += m.vertices.length
  }
  return { vertices: out, indices: null, triangleCount: total }
}
