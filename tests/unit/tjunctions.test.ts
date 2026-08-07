import { describe, it, expect } from 'vitest'
import { repairMesh } from '@/lib/geometry/meshRepair'
import { convertMeshToSolid, DEFAULT_CONVERT_SETTINGS, isWatertight } from '@/lib/geometry/convert'

/**
 * A box whose +z face is subdivided 2x2 while its sides are single quads.
 *
 * The rim edges therefore do not match: a side spans (0,0,2)->(2,0,2) in one
 * edge while the top splits it at the midpoint. That is a T-junction, and it is
 * what CAD tessellation produces whenever each face of a part is triangulated
 * independently — the exact reason a visibly solid part used to report dozens
 * of shells and fall through to voxel reconstruction.
 */
function boxWithTJunctions(): Float32Array {
  const t: number[] = []
  const tri = (a: number[], b: number[], c: number[]) => t.push(...a, ...b, ...c)
  const quad = (a: number[], b: number[], c: number[], d: number[]) => { tri(a, b, c); tri(a, c, d) }
  const S = 2
  quad([0, 0, 0], [0, S, 0], [S, S, 0], [S, 0, 0])          // -z
  quad([0, 0, 0], [S, 0, 0], [S, 0, S], [0, 0, S])          // -y
  quad([S, 0, 0], [S, S, 0], [S, S, S], [S, 0, S])          // +x
  quad([S, S, 0], [0, S, 0], [0, S, S], [S, S, S])          // +y
  quad([0, S, 0], [0, 0, 0], [0, 0, S], [0, S, S])          // -x
  for (let i = 0; i < 2; i++)                                // +z, subdivided
    for (let j = 0; j < 2; j++)
      quad([i, j, S], [i + 1, j, S], [i + 1, j + 1, S], [i, j + 1, S])
  return Float32Array.from(t)
}

describe('T-junction stitching', () => {
  it('turns a mismatched-tessellation box into one closed manifold', () => {
    const r = repairMesh(boxWithTJunctions(), null)
    expect(r.report.stitchedEdges).toBeGreaterThan(0)
    expect(r.report.components).toBe(1)
    expect(r.report.remainingBoundaryEdges).toBe(0)
    expect(r.report.closed).toBe(true)
    expect(r.report.blockedBy).toBe('')
    expect(isWatertight(r.indices)).toBe(true)
  })

  it('lets the faithful path stay exact instead of falling back to voxels', () => {
    const { report } = convertMeshToSolid(boxWithTJunctions(), null, {
      ...DEFAULT_CONVERT_SETTINGS,
      method: 'faithful',
    })
    expect(report.faithful).toBe(true)
    expect(report.reconstructed).toBe(false)
    expect(report.brepFaces).toBe(6)     // a box is six planar faces, exactly
  })

  it('names the blocking condition when a mesh genuinely cannot be closed', () => {
    // A lone triangle can never become a solid; the report must say why.
    const lone = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const r = repairMesh(lone, null, { fillHoles: false })
    expect(r.report.closed).toBe(false)
    expect(r.report.blockedBy).toContain('open edge')
  })

  it('leaves a already-clean mesh untouched', () => {
    const cube = Float32Array.from([
      0,0,0, 0,1,0, 1,1,0,  0,0,0, 1,1,0, 1,0,0,
      0,0,1, 1,0,1, 1,1,1,  0,0,1, 1,1,1, 0,1,1,
      0,0,0, 1,0,0, 1,0,1,  0,0,0, 1,0,1, 0,0,1,
      1,0,0, 1,1,0, 1,1,1,  1,0,0, 1,1,1, 1,0,1,
      1,1,0, 0,1,0, 0,1,1,  1,1,0, 0,1,1, 1,1,1,
      0,1,0, 0,0,0, 0,0,1,  0,1,0, 0,0,1, 0,1,1,
    ])
    const r = repairMesh(cube, null)
    expect(r.report.stitchedEdges).toBe(0)
    expect(r.report.closed).toBe(true)
  })
})
