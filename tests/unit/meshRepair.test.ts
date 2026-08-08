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

describe('quads cut across both diagonals', () => {
  /**
   * A closed cube with one face's two triangles replaced by `(a,b,c)` and
   * `(a,b,d)` — one half from each diagonal. They overlap over half the face and
   * leave the other half open, and the shared edge picks up a third owner.
   *
   * This is not a contrived shape. The model this was written for is a surface
   * export whose side-wall band emits exactly this pair for every rim edge: 84
   * non-manifold edges and 16 open ones, all from one wrong index.
   */
  function cubeWithDoubleDiagonalFace(): Float32Array {
    const S = 10
    const t: number[] = []
    const tri = (a: number[], b: number[], c: number[]) => t.push(...a, ...b, ...c)
    const quad = (a: number[], b: number[], c: number[], d: number[]) => { tri(a, b, c); tri(a, c, d) }
    const p = [
      [0,0,0],[S,0,0],[S,S,0],[0,S,0],
      [0,0,S],[S,0,S],[S,S,S],[0,S,S],
    ]
    // Five sound faces.
    quad(p[4],p[5],p[6],p[7])
    quad(p[0],p[1],p[5],p[4])
    quad(p[1],p[2],p[6],p[5])
    quad(p[2],p[3],p[7],p[6])
    quad(p[3],p[0],p[4],p[7])
    // The sixth, cut both ways: shares edge p0-p1 twice instead of a diagonal.
    tri(p[0], p[3], p[2])
    tri(p[0], p[3], p[1])
    return Float32Array.from(t)
  }

  it('drops the overlapping half and closes the mesh', () => {
    const r = repairMesh(cubeWithDoubleDiagonalFace(), null)
    expect(r.report.droppedOverlaps).toBeGreaterThan(0)
    expect(r.report.remainingNonManifoldEdges).toBe(0)
    expect(r.report.remainingBoundaryEdges).toBe(0)
    expect(r.report.closed).toBe(true)
  })

  it('leaves a sound mesh completely alone', () => {
    // The pass only ever inspects edges with three or more owners, so a valid
    // mesh cannot reach it — worth pinning, because a repair that can damage
    // good input is worse than no repair.
    const before = cubeSoup(10)
    const r = repairMesh(before, null)
    expect(r.report.droppedOverlaps).toBe(0)
    expect(r.report.closed).toBe(true)
    expect(r.indices.length / 3).toBe(12)
  })
})
