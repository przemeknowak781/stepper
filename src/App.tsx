import { useRef } from 'react'
import { Boxes, FilePlus2 } from 'lucide-react'
import { useConverterStore } from '@/state/converterStore'
import { useConversion } from '@/hooks/useConversion'
import { useUpload } from '@/hooks/useUpload'
import { Viewer } from '@/components/viewer/Viewer'
import { UploadZone } from '@/components/panels/UploadZone'
import { ControlsPanel } from '@/components/panels/ControlsPanel'
import { ExportPanel } from '@/components/panels/ExportPanel'
import { Button } from '@/components/ui/Button'

function Header() {
  const hasInput = useConverterStore((s) => Boolean(s.input))
  const name = useConverterStore((s) => s.inputName)
  const reset = useConverterStore((s) => s.reset)
  const upload = useUpload()
  const fileInput = useRef<HTMLInputElement>(null)

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-line bg-surface-1 px-4">
      <div className="flex items-center gap-2.5">
        <div className="rounded-md bg-accent-500/15 p-1.5">
          <Boxes className="h-4 w-4 text-accent-400" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-ink-1">Stepper</div>
          <div className="text-2xs text-ink-4">3D → STEP converter</div>
        </div>
        {hasInput && (
          <span className="ml-2 max-w-[220px] truncate rounded bg-surface-3 px-2 py-0.5 font-mono text-xs text-ink-3">
            {name}
          </span>
        )}
      </div>
      {hasInput && (
        <>
          <input
            ref={fileInput}
            type="file"
            accept=".stl,.obj,.gltf,.glb"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) {
                reset()
                upload(f)
              }
              e.target.value = ''
            }}
          />
          <Button variant="secondary" onClick={() => fileInput.current?.click()}>
            <FilePlus2 className="h-4 w-4" />
            New file
          </Button>
        </>
      )}
    </header>
  )
}

export function App() {
  useConversion()
  const hasInput = useConverterStore((s) => Boolean(s.input))

  return (
    <div className="flex h-full flex-col bg-surface-0">
      <Header />
      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1">
          {hasInput ? <Viewer /> : <UploadZone />}
        </main>
        {hasInput && (
          <aside className="w-72 shrink-0 overflow-y-auto border-l border-line bg-surface-1 p-4">
            <div className="space-y-6">
              <ControlsPanel />
              <ExportPanel />
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
