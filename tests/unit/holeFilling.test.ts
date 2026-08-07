import { describe, it, expect } from 'vitest'
import { repairMesh, splitPinchedLoop } from '@/lib/geometry/meshRepair'

/**
 * Flat 4x4 grid of quads with the corner quad and a diagonal neighbour removed.
 *
 * The two openings meet at exactly one vertex, so the boundary walk passes
 * through it twice: a figure-of-eight, not a simple polygon. That is the shape
 * real meshes take around non-manifold junctions, and it used to defeat the
 * hole filler entirely.
 */
function sheetWithPinchedBoundary(): Float32Array {
  const t: number[] = []
  const P = (i: number, j: number) => [i, j, 0]
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      if ((i === 0 && j === 0) || (i === 1 && j === 1)) continue
      t.push(...P(i, j), ...P(i + 1, j), ...P(i + 1, j + 1))
      t.push(...P(i, j), ...P(i + 1, j + 1), ...P(i, j + 1))
    }
  return Float32Array.from(t)
}

describe('boundary loop walking', () => {
  it('closes a boundary that pinches at a shared vertex', () => {
    const r = repairMesh(sheetWithPinchedBoundary(), null)
    // Previously: one 20-edge figure-of-eight, one bad fill, 10 edges left open.
    expect(r.report.filledHoles).toBe(2)
    expect(r.report.remainingBoundaryEdges).toBe(0)
    expect(r.report.openBoundaryLoops).toBe(0)
  })

  it('still fills an ordinary single hole', () => {
    // Cube with one face removed.
    const S = 1
    const t: number[] = []
    const tri = (a: number[], b: number[], c: number[]) => t.push(...a, ...b, ...c)
    const quad = (a: number[], b: number[], c: number[], d: number[]) => { tri(a,b,c); tri(a,c,d) }
    quad([0,0,0],[0,S,0],[S,S,0],[S,0,0])
    quad([0,0,0],[S,0,0],[S,0,S],[0,0,S])
    quad([S,0,0],[S,S,0],[S,S,S],[S,0,S])
    quad([S,S,0],[0,S,0],[0,S,S],[S,S,S])
    quad([0,S,0],[0,0,0],[0,0,S],[0,S,S])
    // +z deliberately missing
    const r = repairMesh(Float32Array.from(t), null)
    expect(r.report.filledHoles).toBe(1)
    expect(r.report.closed).toBe(true)
  })
})

describe('splitPinchedLoop', () => {
  it('leaves a simple ring alone', () => {
    expect(splitPinchedLoop([0, 1, 2, 3])).toEqual([[0, 1, 2, 3]])
  })

  it('cuts a figure-of-eight into its two rings', () => {
    // 0-1-2 back to 0, then 0-3-4 back to 0.
    const rings = splitPinchedLoop([0, 1, 2, 0, 3, 4])
    expect(rings).toHaveLength(2)
    expect(rings.map(r => r.length).sort()).toEqual([3, 3])
  })

  it('drops degenerate stubs shorter than a triangle', () => {
    expect(splitPinchedLoop([0, 1, 0, 2, 3, 4])).toEqual([[0, 2, 3, 4]])
  })
})
