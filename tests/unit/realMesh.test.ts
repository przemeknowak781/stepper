import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSTL } from '@/lib/stl/parseSTL'
import { convertMeshToSolid, DEFAULT_CONVERT_SETTINGS } from '@/lib/geometry/convert'
import { exportSTEP } from '@/lib/step/exportSTEP'

/** End-to-end sanity on the bundled reference mesh (a real engineering part). */
describe('real mesh pipeline (m2.stl)', () => {
  const path = join(process.cwd(), 'public/examples/m2.stl')
  const buf = readFileSync(path)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const parsed = parseSTL(ab as ArrayBuffer)

  it('parses the reference STL', () => {
    expect(parsed.triangleCount).toBeGreaterThan(100)
  })

  it('converts to a watertight solid and exports valid STEP', () => {
    const { solid, report } = convertMeshToSolid(parsed.vertices, null, {
      ...DEFAULT_CONVERT_SETTINGS,
      resolution: 40,
      slices: 40,
    })
    expect(report.watertight).toBe(true)
    const step = exportSTEP(solid.vertices, solid.indices, { name: 'm2' })
    expect(step).toContain('MANIFOLD_SOLID_BREP')
    expect(step).toContain('END-ISO-10303-21;')
    // No degenerate/empty shell.
    expect(step).toContain('ADVANCED_FACE')
  })
})
