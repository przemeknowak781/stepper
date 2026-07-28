import { describe, it, expect } from 'vitest'
import { parseSTEP } from '@/lib/step/parseSTEP'
import { exportSTEP, exportSTEPFromFaces } from '@/lib/step/exportSTEP'
import { planarizeMesh } from '@/lib/geometry/planarize'
import { computeAABB } from '@/lib/geometry/boundingBox'
import { isWatertight } from '@/lib/geometry/convert'
import { weldMesh } from '@/lib/step/exportSTEP'
import { cubeSoup } from './fixtures'

/** Signed volume of a closed triangle soup (non-indexed). */
function volumeOfSoup(v: Float32Array): number {
  let vol = 0
  for (let t = 0; t < v.length; t += 9) {
    const ax = v[t], ay = v[t + 1], az = v[t + 2]
    const bx = v[t + 3], by = v[t + 4], bz = v[t + 5]
    const cx = v[t + 6], cy = v[t + 7], cz = v[t + 8]
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return Math.abs(vol / 6)
}

describe('parseSTEP', () => {
  it('round-trips an economical planar B-rep (6-face box) back to a solid mesh', () => {
    const src = cubeSoup(10)
    const planar = planarizeMesh(src, null, {})
    const step = exportSTEPFromFaces(planar.brep!.vertices, planar.brep!.faces, { name: 'box' })

    const back = parseSTEP(step)
    // 6 quads → 2 triangles each.
    expect(back.triangleCount).toBe(12)
    expect(volumeOfSoup(back.vertices)).toBeCloseTo(1000, 3) // 10³
    const box = computeAABB(back.vertices)
    expect(box.min).toEqual([0, 0, 0])
    expect(box.max).toEqual([10, 10, 10])
    // Re-welded, the imported mesh is a closed manifold again.
    const w = weldMesh(back.vertices, null, 1e-6)
    expect(w.vertices.length / 3).toBe(8)
    expect(isWatertight(w.indices)).toBe(true)
  })

  it('round-trips the per-triangle STEP form too', () => {
    const src = cubeSoup(4)
    const step = exportSTEP(src, null, { name: 'box' })
    const back = parseSTEP(step)
    expect(back.triangleCount).toBe(12)
    expect(volumeOfSoup(back.vertices)).toBeCloseTo(64, 4)
  })

  it('handles a faceted_brep POLY_LOOP face', () => {
    const step = [
      'ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;',
      "#1=CARTESIAN_POINT('',(0.,0.,0.));",
      "#2=CARTESIAN_POINT('',(1.,0.,0.));",
      "#3=CARTESIAN_POINT('',(1.,1.,0.));",
      "#4=CARTESIAN_POINT('',(0.,1.,0.));",
      '#5=POLY_LOOP(\'\',(#1,#2,#3,#4));',
      "#6=FACE_OUTER_BOUND('',#5,.T.);",
      "#7=ADVANCED_FACE('',(#6),#8,.T.);",
      'ENDSEC;', 'END-ISO-10303-21;',
    ].join('\n')
    const back = parseSTEP(step)
    expect(back.triangleCount).toBe(2) // unit square → 2 triangles
  })

  it('returns nothing for a STEP with no faces (caller reports the error)', () => {
    const step = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;'
    expect(parseSTEP(step).triangleCount).toBe(0)
  })
})
