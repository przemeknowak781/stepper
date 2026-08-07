import { describe, it, expect } from 'vitest'
import { diagnoseShell, thickenShell } from '@/lib/geometry/shell'
import { convertMeshToSolid, DEFAULT_CONVERT_SETTINGS } from '@/lib/geometry/convert'
import { computeAABB, aabbSize } from '@/lib/geometry/boundingBox'
import { cubeSoup } from './fixtures'

/**
 * A flat sheet in the XY plane: n×n quads, zero thickness, an open boundary all
 * the way round. This is the shape a surface modeller exports and the shape
 * there is no correct solid for.
 */
function flatSheet(n = 8, size = 10): { vertices: Float32Array; indices: Uint32Array } {
  const vertices = new Float32Array((n + 1) * (n + 1) * 3)
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const v = (j * (n + 1) + i) * 3
      vertices[v] = (i / n) * size
      vertices[v + 1] = (j / n) * size
      vertices[v + 2] = 0
    }
  }
  const indices = new Uint32Array(n * n * 6)
  let k = 0
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i
      const b = a + 1
      const c = a + (n + 1)
      const d = c + 1
      indices[k++] = a; indices[k++] = b; indices[k++] = d
      indices[k++] = a; indices[k++] = d; indices[k++] = c
    }
  }
  return { vertices, indices }
}

/** The same sheet bent 90 degrees, so the mitre has creases to deal with. */
function foldedSheet(): { vertices: Float32Array; indices: Uint32Array } {
  const flat = flatSheet(8, 10)
  const vertices = new Float32Array(flat.vertices)
  for (let v = 0; v < vertices.length; v += 3) {
    if (vertices[v] > 5) {
      vertices[v + 2] = vertices[v] - 5
      vertices[v] = 5
    }
  }
  return { vertices, indices: flat.indices }
}

describe('shell detection', () => {
  it('scores a closed solid at zero', () => {
    const diagnosis = diagnoseShell(cubeSoup(10), null)
    expect(diagnosis.isShell).toBe(false)
    expect(diagnosis.shellScore).toBeLessThan(0.5)
  })

  it('scores a zero-thickness sheet at one, and reports the thickness it has', () => {
    const sheet = flatSheet()
    const diagnosis = diagnoseShell(sheet.vertices, sheet.indices)
    expect(diagnosis.isShell).toBe(true)
    expect(diagnosis.shellScore).toBeCloseTo(1, 5)
    expect(diagnosis.boundaryEdges).toBe(32) // 8 quads per side
    expect(diagnosis.area).toBeCloseTo(100, 5)
    // The number that explains the whole failure mode: the sheet is 0 thick,
    // so any solid made from it has a thickness nobody asked for.
    expect(diagnosis.impliedThickness).toBeCloseTo(0, 6)
    expect(diagnosis.suggestedThickness).toBeGreaterThan(0)
  })
})

describe('shell thickening', () => {
  it('encloses exactly area times thickness', () => {
    const sheet = flatSheet()
    const walled = thickenShell(sheet.vertices, sheet.indices, 0.4)
    const size = aabbSize(computeAABB(walled.vertices))
    expect(size[2]).toBeCloseTo(0.4, 6)
    expect(signedVolume(walled.vertices, walled.indices)).toBeCloseTo(100 * 0.4, 4)
  })

  it('keeps the wall at full thickness across a crease', () => {
    // Offsetting along an averaged normal thins the wall to `t/2 * cos` at every
    // fold; on this 90-degree bend that is a 29% shortfall. The mitre is what
    // makes the delivered wall the wall that was asked for.
    const folded = foldedSheet()
    const area = diagnoseShell(folded.vertices, folded.indices).area
    const walled = thickenShell(folded.vertices, folded.indices, 0.4)
    expect(signedVolume(walled.vertices, walled.indices)).toBeCloseTo(area * 0.4, 3)
  })

  it('closes the surface it thickens', () => {
    const sheet = flatSheet(4)
    const walled = thickenShell(sheet.vertices, sheet.indices, 1)
    const used = new Map<string, number>()
    for (let t = 0; t < walled.indices.length / 3; t++) {
      for (let e = 0; e < 3; e++) {
        const p = walled.indices[t * 3 + e]
        const q = walled.indices[t * 3 + ((e + 1) % 3)]
        const key = p < q ? `${p}:${q}` : `${q}:${p}`
        used.set(key, (used.get(key) ?? 0) + 1)
      }
    }
    expect([...used.values()].every((n) => n === 2)).toBe(true)
  })

  it('refuses a non-positive wall rather than inventing one', () => {
    const sheet = flatSheet(2)
    expect(() => thickenShell(sheet.vertices, sheet.indices, 0)).toThrow()
  })
})

describe('converting a surface input', () => {
  const settings = { ...DEFAULT_CONVERT_SETTINGS, resolution: 32, slices: 32 }

  it('reports the shell instead of inflating it to a one-voxel plate', () => {
    const sheet = flatSheet()
    const { solid, report } = convertMeshToSolid(sheet.vertices, sheet.indices, settings)
    expect(report.shell?.isShell).toBe(true)
    expect(report.appliedThickness).toBeUndefined()
    // Nothing is produced, because without a wall there is nothing correct to
    // produce — a plate one voxel thick would look like a conversion and not be
    // one.
    expect(solid.indices.length).toBe(0)
    expect(report.watertight).toBe(false)
  })

  it('honours a supplied wall', () => {
    const sheet = flatSheet()
    const { solid, report } = convertMeshToSolid(sheet.vertices, sheet.indices, {
      ...settings,
      shellThickness: 1,
    })
    expect(report.appliedThickness).toBe(1)
    expect(report.shell?.isShell).toBe(true)
    // Once it has a wall the surface is a closed manifold, so it takes the
    // exact path — the wall is delivered to the last digit and there is no
    // voxel reconstruction anywhere in the result.
    expect(report.faithful).toBe(true)
    expect(report.reconstructed).toBe(false)
    expect(aabbSize(computeAABB(solid.vertices))[2]).toBeCloseTo(1, 6)
  })

  it('does not cap the sheet boundary while welding it', () => {
    // The outer boundary of a sheet reads as one big hole. Filling it (the
    // repair default) yields a closed surface of zero volume with no rim left
    // to thicken, and the result falls back to voxels.
    const sheet = flatSheet()
    const { report } = convertMeshToSolid(sheet.vertices, sheet.indices, {
      ...settings,
      shellThickness: 1,
    })
    expect(report.repair?.filledHoles).toBe(0)
  })
})

function signedVolume(vertices: Float32Array, indices: Uint32Array): number {
  let volume = 0
  for (let t = 0; t < indices.length / 3; t++) {
    const a = indices[t * 3] * 3
    const b = indices[t * 3 + 1] * 3
    const c = indices[t * 3 + 2] * 3
    volume +=
      (vertices[a] * (vertices[b + 1] * vertices[c + 2] - vertices[b + 2] * vertices[c + 1]) +
        vertices[a + 1] * (vertices[b + 2] * vertices[c] - vertices[b] * vertices[c + 2]) +
        vertices[a + 2] * (vertices[b] * vertices[c + 1] - vertices[b + 1] * vertices[c])) /
      6
  }
  return Math.abs(volume)
}
