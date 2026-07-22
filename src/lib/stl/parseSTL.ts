export interface ParsedSTL {
  vertices: Float32Array
  triangleCount: number
}

const BINARY_HEADER_BYTES = 80
const BINARY_COUNT_BYTES = 4
const BINARY_TRI_BYTES = 50

function looksBinary(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < BINARY_HEADER_BYTES + BINARY_COUNT_BYTES) return false
  const dv = new DataView(buffer)
  const count = dv.getUint32(BINARY_HEADER_BYTES, true)
  const expected = BINARY_HEADER_BYTES + BINARY_COUNT_BYTES + count * BINARY_TRI_BYTES
  if (expected === buffer.byteLength) return true
  // Heuristic: ASCII STL starts with "solid"
  const head = new Uint8Array(buffer, 0, Math.min(5, buffer.byteLength))
  const sig = String.fromCharCode(...head)
  return sig.toLowerCase() !== 'solid'
}

export function parseBinarySTL(buffer: ArrayBuffer): ParsedSTL {
  const dv = new DataView(buffer)
  const triCount = dv.getUint32(BINARY_HEADER_BYTES, true)
  const vertices = new Float32Array(triCount * 9)
  let offset = BINARY_HEADER_BYTES + BINARY_COUNT_BYTES
  for (let i = 0; i < triCount; i++) {
    // Skip normal (12 bytes)
    offset += 12
    for (let v = 0; v < 9; v++) {
      vertices[i * 9 + v] = dv.getFloat32(offset, true)
      offset += 4
    }
    // Skip attribute byte count (2 bytes)
    offset += 2
  }
  return { vertices, triangleCount: triCount }
}

export function parseAsciiSTL(text: string): ParsedSTL {
  const verts: number[] = []
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    verts.push(parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]))
  }
  if (verts.length % 9 !== 0) {
    throw new Error('ASCII STL parse error: vertex count not divisible by 9')
  }
  return {
    vertices: new Float32Array(verts),
    triangleCount: verts.length / 9,
  }
}

export function parseSTL(buffer: ArrayBuffer): ParsedSTL {
  if (looksBinary(buffer)) {
    return parseBinarySTL(buffer)
  }
  const text = new TextDecoder().decode(buffer)
  return parseAsciiSTL(text)
}
