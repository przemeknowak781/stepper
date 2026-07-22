/** Build a closed axis-aligned cube as a non-indexed triangle soup (12 tris). */
export function cubeSoup(size = 10, origin: [number, number, number] = [0, 0, 0]): Float32Array {
  const [ox, oy, oz] = origin
  const c = [
    [ox, oy, oz],
    [ox + size, oy, oz],
    [ox + size, oy + size, oz],
    [ox, oy + size, oz],
    [ox, oy, oz + size],
    [ox + size, oy, oz + size],
    [ox + size, oy + size, oz + size],
    [ox, oy + size, oz + size],
  ]
  // Outward-facing (CCW) triangles.
  const quads = [
    [0, 3, 2, 1], // bottom (-z)
    [4, 5, 6, 7], // top (+z)
    [0, 1, 5, 4], // -y
    [1, 2, 6, 5], // +x
    [2, 3, 7, 6], // +y
    [3, 0, 4, 7], // -x
  ]
  const out: number[] = []
  for (const [a, b, cc, d] of quads) {
    for (const v of [a, b, cc, a, cc, d]) out.push(c[v][0], c[v][1], c[v][2])
  }
  return Float32Array.from(out)
}
