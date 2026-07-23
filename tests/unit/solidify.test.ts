import { describe, it, expect } from 'vitest'
import { solidifyToOccupancy, paddedGridFor } from '@/lib/geometry/solidify'
import { occupancyToSolid } from '@/lib/geometry/slicedSolid'
import { isWatertight } from '@/lib/geometry/convert'
import { cubeSoup } from './fixtures'

describe('solidifyToOccupancy', () => {
  it('fills the interior of a cube (flood-fill volume) → watertight cuberille', () => {
    const verts = cubeSoup(20)
    const grid = paddedGridFor(verts, 'z', 24, 24)
    const { occupancy, occupiedVoxels } = solidifyToOccupancy(verts, null, grid, 1)
    expect(occupiedVoxels).toBeGreaterThan(0)
    // Interior voxels must be filled, not just a hollow shell — a centre voxel is solid.
    const cx = (grid.nx / 2) | 0, cy = (grid.ny / 2) | 0, cz = (grid.nz / 2) | 0
    expect(occupancy[cz * grid.nx * grid.ny + cy * grid.nx + cx]).toBe(1)
    expect(isWatertight(occupancyToSolid(occupancy, grid).indices)).toBe(true)
  })

  it('seals a torn cube into a watertight solid despite the hole', () => {
    const full = cubeSoup(20)
    const torn = full.slice(0, full.length - 9)
    const grid = paddedGridFor(torn, 'z', 28, 28)
    const { occupancy, occupiedVoxels } = solidifyToOccupancy(torn, null, grid, 1)
    expect(occupiedVoxels).toBeGreaterThan(0)
    expect(isWatertight(occupancyToSolid(occupancy, grid).indices)).toBe(true)
  })
})
