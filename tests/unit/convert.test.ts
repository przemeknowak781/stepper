import { describe, it, expect } from 'vitest'
import { convertMeshToSolid, isWatertight, DEFAULT_CONVERT_SETTINGS } from '@/lib/geometry/convert'
import { cubeSoup } from './fixtures'

describe('convertMeshToSolid', () => {
  it('produces a watertight solid from a clean cube (voxel method)', () => {
    const verts = cubeSoup(20)
    const { solid, report } = convertMeshToSolid(verts, null, {
      ...DEFAULT_CONVERT_SETTINGS,
      method: 'voxel',
      resolution: 24,
      slices: 24,
    })
    expect(report.outputTriangles).toBeGreaterThan(0)
    expect(report.watertight).toBe(true)
    expect(isWatertight(solid.indices)).toBe(true)
  })

  it('produces a watertight solid with the smooth (marching cubes) method', () => {
    const verts = cubeSoup(20)
    const { report } = convertMeshToSolid(verts, null, {
      ...DEFAULT_CONVERT_SETTINGS,
      method: 'smooth',
      resolution: 24,
      slices: 24,
      smoothIterations: 6,
    })
    expect(report.outputTriangles).toBeGreaterThan(0)
    expect(report.watertight).toBe(true)
  })

  it('repairs a torn input: dropping a face still yields a watertight output', () => {
    const full = cubeSoup(20)
    // Drop the last triangle (9 floats) to open a hole in the surface.
    const torn = full.slice(0, full.length - 9)
    const { report } = convertMeshToSolid(torn, null, {
      ...DEFAULT_CONVERT_SETTINGS,
      method: 'voxel',
      resolution: 24,
      slices: 24,
    })
    expect(report.watertight).toBe(true)
    expect(report.occupiedVoxels).toBeGreaterThan(0)
  })
})

describe('isWatertight', () => {
  it('rejects an open surface (single triangle)', () => {
    expect(isWatertight(new Uint32Array([0, 1, 2]))).toBe(false)
  })
})
