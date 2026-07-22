import type { Vector3Tuple } from 'three'

export interface AABB {
  min: Vector3Tuple
  max: Vector3Tuple
}

export function computeAABB(vertices: Float32Array): AABB {
  if (vertices.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] }
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
}

export function expandAABB(box: AABB, margin: number): AABB {
  return {
    min: [box.min[0] - margin, box.min[1] - margin, box.min[2] - margin],
    max: [box.max[0] + margin, box.max[1] + margin, box.max[2] + margin],
  }
}

export function aabbCenter(box: AABB): Vector3Tuple {
  return [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ]
}

export function aabbSize(box: AABB): Vector3Tuple {
  return [
    box.max[0] - box.min[0],
    box.max[1] - box.min[1],
    box.max[2] - box.min[2],
  ]
}

/** Longest edge of the box — handy for scaling tolerances to model size. */
export function aabbMaxExtent(box: AABB): number {
  const [sx, sy, sz] = aabbSize(box)
  return Math.max(sx, sy, sz)
}
