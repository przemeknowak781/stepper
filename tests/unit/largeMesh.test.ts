import { describe, it, expect } from 'vitest'
import { repairMesh } from '@/lib/geometry/meshRepair'
import { convertMeshToSolid, DEFAULT_CONVERT_SETTINGS } from '@/lib/geometry/convert'
import { cubeSoup } from './fixtures'

/**
 * Regression guard for "Maximum call stack size exceeded" on real-world models.
 *
 * The dedup pass used to re-fill the triangle list with `tris.push(...kept)`,
 * spreading 3 × triangleCount arguments onto the call stack — which throws for
 * any mesh past a few tens of thousands of triangles. These meshes are far
 * above that threshold, so a stack-unsafe implementation cannot pass.
 */
function manyCubes(count: number): Float32Array {
  const one = cubeSoup(1)
  const out = new Float32Array(one.length * count)
  for (let n = 0; n < count; n++) {
    const off = n * one.length
    // Lay the cubes out on a lattice so they stay disjoint (spacing > size).
    const dx = (n % 32) * 3
    const dy = (Math.floor(n / 32) % 32) * 3
    const dz = Math.floor(n / 1024) * 3
    for (let i = 0; i < one.length; i += 3) {
      out[off + i] = one[i] + dx
      out[off + i + 1] = one[i + 1] + dy
      out[off + i + 2] = one[i + 2] + dz
    }
  }
  return out
}

describe('large mesh handling (stack safety)', () => {
  const CUBES = 6000 // 72 000 triangles → 216 000 spread args in the old code
  const mesh = manyCubes(CUBES)

  it('repairMesh survives a 72k-triangle mesh', () => {
    const r = repairMesh(mesh, null)
    expect(r.indices.length / 3).toBe(CUBES * 12)
    expect(r.report.components).toBe(CUBES)
    expect(r.report.closed).toBe(true)
  })

  it('repairMesh dedups a doubled large mesh without blowing the stack', () => {
    const doubled = new Float32Array(mesh.length * 2)
    doubled.set(mesh, 0)
    doubled.set(mesh, mesh.length)
    const r = repairMesh(doubled, null)
    expect(r.report.removedDuplicate).toBe(CUBES * 12)
    expect(r.indices.length / 3).toBe(CUBES * 12)
  })

  it('the full faithful conversion runs end-to-end on it', () => {
    const { report } = convertMeshToSolid(mesh, null, {
      ...DEFAULT_CONVERT_SETTINGS,
      method: 'faithful',
    })
    expect(report.faithful).toBe(true)
    // Every cube collapses to its 6 planar faces.
    expect(report.brepFaces).toBe(CUBES * 6)
  })
})
