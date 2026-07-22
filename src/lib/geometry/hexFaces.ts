/**
 * The 6 faces of a unit grid cell, each as a neighbour direction plus the 4
 * corner offsets in CCW winding (seen from outside the cell) — so triangulated
 * quads get outward-pointing right-hand normals.  Shared by {@link
 * occupancyToSolid} (surface reconstruction / STL export) and the FEM hex mesh
 * builder (boundary-face detection for BC application), so both agree on
 * exactly the same face geometry.
 */
export interface HexFace {
  d: [number, number, number]
  quad: [number, number, number][]
}

export const HEX_FACES: HexFace[] = [
  { d: [-1, 0, 0], quad: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { d: [1, 0, 0], quad: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { d: [0, -1, 0], quad: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { d: [0, 1, 0], quad: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { d: [0, 0, -1], quad: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  { d: [0, 0, 1], quad: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
]
