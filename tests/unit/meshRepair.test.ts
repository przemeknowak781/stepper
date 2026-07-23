import { describe, it, expect } from 'vitest'
import { repairMesh } from '@/lib/geometry/meshRepair'
import { isWatertight } from '@/lib/geometry/convert'
import { cubeSoup } from './fixtures'

describe('repairMesh', () => {
  it('leaves a clean cube closed with nothing to fix', () => {
    const r = repairMesh(cubeSoup(10), null)
    expect(r.report.closed).toBe(true)
    expect(r.report.filledHoles).toBe(0)
    expect(isWatertight(r.indices)).toBe(true)
  })

  it('fills a hole from a dropped face and reports a closed manifold', () => {
    const full = cubeSoup(10)
    const torn = full.slice(0, full.length - 9)
    const r = repairMesh(torn, null)
    expect(r.report.closed).toBe(true)
    expect(r.report.filledHoles).toBeGreaterThanOrEqual(1)
    expect(isWatertight(r.indices)).toBe(true)
  })

  it('re-orients inconsistently wound faces into a consistent manifold', () => {
    const soup = cubeSoup(10)
    // Flip winding of the first two triangles (one cube face).
    const flipped = Float32Array.from(soup)
    for (const t of [0, 1]) {
      const o = t * 9
      // swap vertices b and c (xyz each)
      for (let k = 0; k < 3; k++) {
        const tmp = flipped[o + 3 + k]
        flipped[o + 3 + k] = flipped[o + 6 + k]
        flipped[o + 6 + k] = tmp
      }
    }
    const r = repairMesh(flipped, null)
    expect(r.report.closed).toBe(true)
    expect(r.report.flippedTriangles).toBeGreaterThan(0)
    expect(isWatertight(r.indices)).toBe(true)
  })

  it('drops duplicate triangles', () => {
    const soup = cubeSoup(10)
    const doubled = new Float32Array(soup.length * 2)
    doubled.set(soup, 0)
    doubled.set(soup, soup.length)
    const r = repairMesh(doubled, null)
    expect(r.report.removedDuplicate).toBe(12)
    expect(r.report.closed).toBe(true)
  })
})
