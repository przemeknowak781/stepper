import { Download, FileBox, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useConverterStore } from '@/state/converterStore'
import { downloadSTEP, downloadSTL } from '@/lib/download'

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-xs text-ink-4">{label}</span>
      <span className="font-mono text-xs text-ink-2">{value}</span>
    </div>
  )
}

export function ExportPanel() {
  const report = useConverterStore((s) => s.report)
  const solid = useConverterStore((s) => s.solid)
  const name = useConverterStore((s) => s.inputName)
  const converting = useConverterStore((s) => s.converting)
  const error = useConverterStore((s) => s.error)

  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <h3 className="text-eyebrow">Result</h3>
        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-danger-500/30 bg-danger-500/10 p-2 text-xs text-danger-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : converting ? (
          <p className="animate-pulse text-xs text-ink-4">Converting…</p>
        ) : report ? (
          <div className="rounded-md border border-line bg-surface-2 p-3">
            <Stat label="Input triangles" value={report.inputTriangles.toLocaleString()} />
            <Stat label="Output triangles" value={report.outputTriangles.toLocaleString()} />
            <Stat label="Output vertices" value={report.outputVertices.toLocaleString()} />
            <Stat
              label="Voxel grid"
              value={`${report.grid.nx}×${report.grid.ny}×${report.grid.nz}`}
            />
            <div className="mt-2 flex items-center gap-1.5 border-t border-line-subtle pt-2">
              {report.watertight ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-success-500" />
                  <span className="text-xs text-success-500">Watertight manifold</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3.5 w-3.5 text-warning-500" />
                  <span className="text-xs text-warning-500">Non-manifold output</span>
                </>
              )}
            </div>
            {report.openRowFraction > 0.001 && (
              <p className="mt-1.5 text-2xs leading-4 text-warning-500">
                Input had open regions ({(report.openRowFraction * 100).toFixed(1)}% of scan rows);
                the solid was sealed during reconstruction.
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-ink-4">Load a model to convert.</p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-eyebrow">Export</h3>
        <Button
          variant="primary"
          className="w-full"
          disabled={!solid || converting}
          onClick={() => solid && downloadSTEP(solid, name)}
        >
          <FileBox className="h-4 w-4" />
          Download STEP
        </Button>
        <Button
          variant="secondary"
          className="w-full"
          disabled={!solid || converting}
          onClick={() => solid && downloadSTL(solid, name)}
        >
          <Download className="h-4 w-4" />
          Download STL
        </Button>
      </section>
    </div>
  )
}
