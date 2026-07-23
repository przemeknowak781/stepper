import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, GizmoHelper, GizmoViewport, Grid, Bounds } from '@react-three/drei'
import {
  BufferGeometry,
  BufferAttribute,
  DoubleSide,
  type Vector3Tuple,
} from 'three'
import { useConverterStore } from '@/state/converterStore'
import { aabbCenter, aabbSize, computeAABB } from '@/lib/geometry/boundingBox'
import './bvh'

/** Build a three geometry from a flat position buffer (+ optional index). */
function useGeometry(
  vertices: Float32Array | undefined,
  indices: Uint32Array | null | undefined,
): BufferGeometry | null {
  return useMemo(() => {
    if (!vertices || vertices.length === 0) return null
    const geom = new BufferGeometry()
    geom.setAttribute('position', new BufferAttribute(vertices, 3))
    if (indices && indices.length > 0) geom.setIndex(new BufferAttribute(indices, 1))
    geom.computeVertexNormals()
    geom.computeBoundingSphere()
    return geom
  }, [vertices, indices])
}

function SceneContents() {
  const input = useConverterStore((s) => s.input)
  const solid = useConverterStore((s) => s.solid)
  const brep = useConverterStore((s) => s.brep)
  const showInput = useConverterStore((s) => s.showInput)
  const showSolid = useConverterStore((s) => s.showSolid)
  // Faceted (flat) shading for planar-face solids (faithful/voxel); smooth
  // shading only for the marching-cubes organic method (brep === null).
  const flatShaded = brep !== null

  const inputGeom = useGeometry(input?.vertices, input?.indices)
  const solidGeom = useGeometry(solid?.vertices, solid?.indices)

  const center = useMemo<Vector3Tuple>(() => {
    const verts = solid?.vertices ?? input?.vertices
    if (!verts) return [0, 0, 0]
    return aabbCenter(computeAABB(verts))
  }, [solid, input])

  const size = useMemo(() => {
    const verts = solid?.vertices ?? input?.vertices
    if (!verts) return 100
    const [sx, sy, sz] = aabbSize(computeAABB(verts))
    return Math.max(sx, sy, sz, 1)
  }, [solid, input])

  return (
    <>
      <hemisphereLight args={['#dfe7ff', '#0a0a0f', 1.1]} />
      <directionalLight position={[1, 2, 3]} intensity={1.6} />
      <directionalLight position={[-2, -1, -2]} intensity={0.5} />

      <group position={[-center[0], -center[1], -center[2]]}>
        {showInput && inputGeom && (
          // Ghost wireframe of the original. Pulled toward the camera with a
          // negative polygon offset and depthWrite off so its lines never
          // z-fight against the (in faithful mode, coincident) solid surface.
          <mesh geometry={inputGeom} renderOrder={2}>
            <meshBasicMaterial
              color="#5b8def"
              wireframe
              transparent
              opacity={solid ? 0.14 : 0.55}
              side={DoubleSide}
              depthWrite={false}
              polygonOffset
              polygonOffsetFactor={-2}
              polygonOffsetUnits={-2}
            />
          </mesh>
        )}
        {showSolid && solidGeom && (
          <mesh key={flatShaded ? 'flat' : 'smooth'} geometry={solidGeom} renderOrder={1}>
            <meshStandardMaterial
              color="#c9d3e6"
              metalness={0.05}
              roughness={0.6}
              side={DoubleSide}
              flatShading={flatShaded}
              polygonOffset
              polygonOffsetFactor={1}
              polygonOffsetUnits={1}
            />
          </mesh>
        )}
      </group>

      <ShowGrid size={size} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
      <GizmoHelper alignment="bottom-right" margin={[70, 70]}>
        <GizmoViewport axisColors={['#ef4444', '#22c55e', '#3b82f6']} labelColor="#e5e7eb" />
      </GizmoHelper>
    </>
  )
}

function ShowGrid({ size }: { size: number }) {
  const showGrid = useConverterStore((s) => s.showGrid)
  if (!showGrid) return null
  const cell = Math.max(1, Math.round(size / 20))
  return (
    <Grid
      position={[0, 0, -size * 0.6]}
      args={[size * 4, size * 4]}
      cellSize={cell}
      sectionSize={cell * 5}
      cellColor="#1c1c22"
      sectionColor="#33333d"
      fadeDistance={size * 8}
      fadeStrength={1.2}
      infiniteGrid
      rotation={[Math.PI / 2, 0, 0]}
    />
  )
}

export function Viewer() {
  const hasContent = useConverterStore((s) => Boolean(s.input))
  return (
    <div className="relative h-full w-full">
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [80, 60, 80], fov: 45, near: 0.1, far: 100000 }}
        gl={{ antialias: true }}
      >
        {hasContent ? (
          <Bounds fit clip observe margin={1.2}>
            <SceneContents />
          </Bounds>
        ) : (
          <SceneContents />
        )}
      </Canvas>
    </div>
  )
}
