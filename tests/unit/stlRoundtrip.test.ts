import { describe, it, expect } from 'vitest'
import { parseSTL } from '@/lib/stl/parseSTL'
import { writeBinarySTLNonIndexed } from '@/lib/stl/exportSTL'
import { cubeSoup } from './fixtures'

describe('STL binary round-trip', () => {
  it('preserves vertices through write → parse', () => {
    const verts = cubeSoup(10)
    const buf = writeBinarySTLNonIndexed(verts)
    const parsed = parseSTL(buf)
    expect(parsed.triangleCount).toBe(verts.length / 9)
    for (let i = 0; i < verts.length; i++) {
      expect(parsed.vertices[i]).toBeCloseTo(verts[i], 4)
    }
  })
})
