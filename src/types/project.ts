/**
 * Minimal mesh type shared by the loaders and the conversion pipeline.
 *
 * A mesh is a flat vertex buffer (`x,y,z` triples).  When `indices` is null the
 * buffer is a non-indexed triangle soup (9 floats per triangle); otherwise
 * `indices` holds 3 vertex offsets per triangle into `vertices`.
 */
export interface MainMeshData {
  vertices: Float32Array
  indices: Uint32Array | null
  triangleCount: number
}
