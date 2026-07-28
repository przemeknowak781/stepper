import { useDropzone } from 'react-dropzone'
import clsx from 'clsx'
import { UploadCloud } from 'lucide-react'
import { useUpload } from '@/hooks/useUpload'
import { useLoadSample } from '@/hooks/useLoadSample'
import { Button } from '@/components/ui/Button'

/**
 * Full-viewport welcome dropzone shown until the first mesh loads.
 */
export function UploadZone() {
  const upload = useUpload()
  const loadSample = useLoadSample()
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    multiple: false,
    accept: {
      'model/stl': ['.stl'],
      'model/obj': ['.obj'],
      'model/gltf+json': ['.gltf'],
      'model/gltf-binary': ['.glb'],
      'model/step': ['.step', '.stp'],
    },
    onDrop: (files) => files[0] && upload(files[0]),
  })

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div
        {...getRootProps()}
        className={clsx(
          'flex w-full max-w-xl cursor-pointer flex-col items-center gap-4 rounded-2xl border-2 border-dashed p-12 text-center',
          'surface-gradient bg-surface-1 transition-all duration-normal ease-out',
          isDragActive ? 'border-accent-400 shadow-glow' : 'border-line hover:border-line-strong',
        )}
      >
        <input {...getInputProps()} />
        <div className="rounded-xl bg-surface-3 p-4">
          <UploadCloud className="h-8 w-8 text-accent-400" strokeWidth={1.5} />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-ink-1">Drop a 3D model to convert</h2>
          <p className="mt-1 text-sm text-ink-3">
            STL, OBJ, GLTF, GLB or STEP — converted into a watertight solid and exported back to
            STEP or STL, either direction.
          </p>
        </div>
        <p className="text-xs text-ink-4">or click to browse</p>
        <Button
          variant="secondary"
          onClick={(e) => {
            e.stopPropagation()
            loadSample()
          }}
        >
          Load sample part
        </Button>
      </div>
    </div>
  )
}
