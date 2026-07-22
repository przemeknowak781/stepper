import { BufferGeometry, Mesh } from 'three'
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast,
} from 'three-mesh-bvh'

/**
 * Monkey-patch three's raycasting once at module load.  Without this,
 * `three-mesh-bvh` is inert and selection on >10k-triangle meshes degrades
 * to O(n) per ray (spec §6.2).  Importing this module is the contract — every
 * file that needs accelerated raycasting must import it for the side effect.
 *
 * Idempotent: if the function references are already in place, this is a no-op.
 */
let installed = false
export function ensureBVHInstalled(): void {
  if (installed) return
  // three-mesh-bvh extends BufferGeometry/Mesh prototypes with its own typings,
  // so we just assign without redeclaring the module.
  ;(BufferGeometry.prototype as unknown as {
    computeBoundsTree: typeof computeBoundsTree
    disposeBoundsTree: typeof disposeBoundsTree
  }).computeBoundsTree = computeBoundsTree
  ;(BufferGeometry.prototype as unknown as {
    disposeBoundsTree: typeof disposeBoundsTree
  }).disposeBoundsTree = disposeBoundsTree
  Mesh.prototype.raycast = acceleratedRaycast
  installed = true
}

ensureBVHInstalled()
