import { describe, it, expect } from 'vitest'
import { triangulateFace } from '@/lib/geometry/triangulate'

/** Sum of triangle areas for a set of tris over a vertex buffer. */
function triArea(V: Float32Array, tris: number[][]): number {
  let a = 0
  for (const [i, j, k] of tris) {
    const ax = V[i * 3], ay = V[i * 3 + 1], az = V[i * 3 + 2]
    const bx = V[j * 3], by = V[j * 3 + 1], bz = V[j * 3 + 2]
    const cx = V[k * 3], cy = V[k * 3 + 1], cz = V[k * 3 + 2]
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    a += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
  }
  return a
}

describe('triangulateFace', () => {
  it('triangulates a convex quad into 2 triangles covering its area', () => {
    // Unit square in the z=0 plane.
    const V = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])
    const tris = triangulateFace(V, [[0, 1, 2, 3]], [0, 0, 1])
    expect(tris.length).toBe(2)
    expect(triArea(V, tris)).toBeCloseTo(1, 6)
  })

  it('triangulates a non-convex L-shape without exceeding its true area', () => {
    // L-shape (area 3) — a fan from vertex 0 would spill outside and overlap.
    const V = new Float32Array([
      0, 0, 0, // 0
      2, 0, 0, // 1
      2, 1, 0, // 2
      1, 1, 0, // 3
      1, 2, 0, // 4
      0, 2, 0, // 5
    ])
    const tris = triangulateFace(V, [[0, 1, 2, 3, 4, 5]], [0, 0, 1])
    expect(tris.length).toBe(4) // n-2 triangles
    expect(triArea(V, tris)).toBeCloseTo(3, 6)
  })

  it('respects a hole: area = outer minus hole', () => {
    // 4×4 outer square (area 16) with a 2×2 hole (area 4) → 12.
    const V = new Float32Array([
      0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 4, 0, // outer 0..3
      1, 1, 0, 1, 3, 0, 3, 3, 0, 3, 1, 0, // hole 4..7 (CCW; will be flipped)
    ])
    const tris = triangulateFace(V, [[0, 1, 2, 3], [4, 5, 6, 7]], [0, 0, 1])
    expect(triArea(V, tris)).toBeCloseTo(12, 5)
  })
})
