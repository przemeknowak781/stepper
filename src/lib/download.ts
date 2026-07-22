import { saveAs } from 'file-saver'
import { exportSTEP, exportSTEPFromFaces } from './step/exportSTEP'
import { writeBinarySTL } from './stl/exportSTL'
import type { SolidMesh } from './geometry/slicedSolid'
import type { PlanarBrep } from './geometry/planarize'
import { aabbMaxExtent, computeAABB } from './geometry/boundingBox'

/** Sanitise a user string into a safe file base name. */
export function safeBaseName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_')
  return base.length > 0 ? base : 'part'
}

/**
 * Download a converted solid as a STEP AP214 file.  When an economical planar
 * B-rep is available (faithful/voxel methods), export from it — few large
 * faces; otherwise fall back to one planar face per triangle.
 */
export function downloadSTEP(solid: SolidMesh, brep: PlanarBrep | null, name: string): void {
  const base = safeBaseName(name)
  // Weld tolerance ~ 1e-6 of the model's size keeps genuinely distinct
  // vertices apart while collapsing float scatter from reconstruction.
  const tol = Math.max(1e-5, aabbMaxExtent(computeAABB(solid.vertices)) * 1e-6)
  const text = brep
    ? exportSTEPFromFaces(brep.vertices, brep.faces, { name: base, weldTolerance: tol })
    : exportSTEP(solid.vertices, solid.indices, { name: base, weldTolerance: tol })
  saveAs(new Blob([text], { type: 'application/step' }), `${base}.step`)
}

/** Download a converted solid as a binary STL file. */
export function downloadSTL(solid: SolidMesh, name: string): void {
  const base = safeBaseName(name)
  const buf = writeBinarySTL(solid.vertices, solid.indices)
  saveAs(new Blob([buf], { type: 'model/stl' }), `${base}.stl`)
}
