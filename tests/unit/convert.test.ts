import { describe, it, expect } from 'vitest'
import { convertMeshToSolid, isWatertight, DEFAULT_CONVERT_SETTINGS } from '@/lib/geometry/convert'
import { cubeSoup } from './fixtures'

describe('convertMeshToSolid', () => {
  it('faithful: a clean cube stays an exact 6-face box', () => {
    const verts = cubeSoup(20)
    const { solid, brep, report } = convertMeshToSolid(verts, null, {
      ...DEFAULT_CONVERT_SETTINGS,
      method: 'faithful',
    })
    expect(report.faithful).toBe(true)
    expect(report.reconstructed).toBe(false)
    expect(report.brepFaces).toBe(6)
    expect(report.brepVertices).toBe(8)
    expect(report.brepEdges).toBe(12)
    expect(brep).not.toBeNull()
    // Display solid is the exact box triangulated (2 tris per face).
    expect(solid.indices.length / 3).toBe(12)
  })

  it('faithful: a torn cube auto-falls back to voxel reconstruction', () => {
    const full = cubeSoup(20)
    const torn = full.slice(0, full.length - 9) // drop a face → not manifold
    const { report } = convertMeshToSolid(torn, null, {
      ...DEFAULT_CONVERT_SETTINGS,
      method: 'faithful',
      resolution: 24,
      slices: 24,
    })
    expect(report.reconstructed).toBe(true)
    expect(report.watertight).toBe(true)
  })

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
    // The blocky shell's flat sides merge into few planar faces.
    expect(report.brepFaces).toBe(6)
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
