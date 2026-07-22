import { describe, it, expect } from 'vitest'
import { exportSTEP, weldMesh } from '@/lib/step/exportSTEP'
import { convertMeshToSolid, DEFAULT_CONVERT_SETTINGS } from '@/lib/geometry/convert'
import { cubeSoup } from './fixtures'

describe('exportSTEP', () => {
  const verts = cubeSoup(20)
  const { solid } = convertMeshToSolid(verts, null, {
    ...DEFAULT_CONVERT_SETTINGS,
    method: 'voxel',
    resolution: 20,
    slices: 20,
  })
  const step = exportSTEP(solid.vertices, solid.indices, { name: 'cube' })

  it('emits a well-formed ISO-10303-21 envelope', () => {
    expect(step.startsWith('ISO-10303-21;')).toBe(true)
    expect(step).toContain('END-ISO-10303-21;')
    expect(step).toContain('FILE_SCHEMA')
    expect(step).toContain('MANIFOLD_SOLID_BREP')
    expect(step).toContain('CLOSED_SHELL')
    expect(step).toContain('ADVANCED_BREP_SHAPE_REPRESENTATION')
  })

  it('never emits lowercase-e exponent reals (invalid in STEP)', () => {
    // A real like 1.2e-7 would break strict STEP parsers.
    const badReal = /\d\.\d*e[-+]?\d/i
    expect(badReal.test(step)).toBe(false)
  })

  it('builds a closed shell: every EDGE_CURVE is used by exactly two ORIENTED_EDGEs', () => {
    const edgeIds = [...step.matchAll(/#(\d+)=EDGE_CURVE/g)].map((m) => m[1])
    expect(edgeIds.length).toBeGreaterThan(0)
    const useCount = new Map<string, number>()
    for (const m of step.matchAll(/ORIENTED_EDGE\('',\*,\*,#(\d+),/g)) {
      useCount.set(m[1], (useCount.get(m[1]) ?? 0) + 1)
    }
    for (const id of edgeIds) {
      expect(useCount.get(id)).toBe(2)
    }
  })

  it('welds a triangle soup into shared vertices and drops degenerates', () => {
    const soup = cubeSoup(10)
    const welded = weldMesh(soup, null, 1e-4)
    // A cube has 8 unique corners.
    expect(welded.vertices.length / 3).toBe(8)
    expect(welded.indices.length / 3).toBe(12)
  })
})
