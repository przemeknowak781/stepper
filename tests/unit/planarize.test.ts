import { describe, it, expect } from 'vitest'
import { planarizeMesh } from '@/lib/geometry/planarize'
import { exportSTEPFromFaces } from '@/lib/step/exportSTEP'
import { cubeSoup } from './fixtures'

describe('planarizeMesh', () => {
  it('collapses a 12-triangle cube into 6 planar faces / 12 edges / 8 vertices', () => {
    const res = planarizeMesh(cubeSoup(10), null, { angleToleranceDeg: 1 })
    expect(res.manifold).toBe(true)
    expect(res.faceCount).toBe(6)
    expect(res.edgeCount).toBe(12)
    expect(res.vertexCount).toBe(8)
    // Every face is a 4-vertex quad (the diagonal split is gone).
    for (const f of res.brep!.faces) {
      expect(f.loops[0].length).toBe(4)
    }
  })

  it('reports non-manifold for a torn mesh', () => {
    const full = cubeSoup(10)
    const torn = full.slice(0, full.length - 9)
    const res = planarizeMesh(torn, null, {})
    expect(res.manifold).toBe(false)
    expect(res.brep).toBeNull()
  })

  it('exports an economical STEP whose closed shell shares every edge twice', () => {
    const res = planarizeMesh(cubeSoup(10), null, {})
    const step = exportSTEPFromFaces(res.brep!.vertices, res.brep!.faces, { name: 'box' })
    // 6 planar faces, not 12 triangles.
    expect((step.match(/ADVANCED_FACE/g) ?? []).length).toBe(6)
    expect(step).toContain('MANIFOLD_SOLID_BREP')

    const edgeIds = [...step.matchAll(/#(\d+)=EDGE_CURVE/g)].map((m) => m[1])
    expect(edgeIds.length).toBe(12)
    const useCount = new Map<string, number>()
    for (const m of step.matchAll(/ORIENTED_EDGE\('',\*,\*,#(\d+),/g)) {
      useCount.set(m[1], (useCount.get(m[1]) ?? 0) + 1)
    }
    for (const id of edgeIds) expect(useCount.get(id)).toBe(2)
  })
})
