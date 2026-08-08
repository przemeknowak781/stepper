import { useCallback, useEffect, useRef, useState } from 'react'
import { Wrench, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useConverterStore } from '@/state/converterStore'
import { writeBinarySTL, writeBinarySTLNonIndexed } from '@/lib/stl/exportSTL'
import { parseSTL } from '@/lib/stl/parseSTL'
import { failedCriteria, type MeshfixReport } from '@/lib/meshfix/client'
import {
  createBrowserMeshfix,
  isSupported,
  type BrowserMeshfix,
  type RuntimeStatus,
} from '@/lib/meshfix/browser'

/**
 * Optional deep repair, run in the browser.
 *
 * Stepper's own pipeline handles most inputs. This is for the ones it cannot:
 * meshes whose defects are structural rather than topological — heavy
 * self-intersection, dozens of loose components, windings that disagree — where
 * a guaranteed watertight, 2-manifold, intersection-free solid is worth several
 * seconds and a one-time download.
 *
 * Opt-in on purpose: booting the Python runtime costs ~16 MB and a few
 * seconds, which nobody should pay for a model that converts fine without it.
 */

const STATUS_LABEL: Record<RuntimeStatus, string> = {
  idle: '',
  'loading-runtime': 'Loading the repair runtime (one-time, ~16 MB)…',
  ready: 'Runtime ready.',
  working: 'Repairing…',
  failed: '',
}

export function RepairPanel() {
  const input = useConverterStore((s) => s.input)
  const inputName = useConverterStore((s) => s.inputName)
  const setInput = useConverterStore((s) => s.setInput)
  const settings = useConverterStore((s) => s.settings)

  const [status, setStatus] = useState<RuntimeStatus>('idle')
  const [report, setReport] = useState<MeshfixReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [timing, setTiming] = useState<{ ms: number; resolution: number } | null>(null)
  const runtime = useRef<BrowserMeshfix | null>(null)

  useEffect(() => () => runtime.current?.dispose(), [])

  const meshfix = useCallback((): BrowserMeshfix => {
    if (!runtime.current) runtime.current = createBrowserMeshfix(setStatus)
    return runtime.current
  }, [])

  const run = useCallback(
    async (mode: 'repair' | 'diagnose') => {
      if (!input) return
      setError(null)
      setTiming(null)
      try {
        // A fresh buffer each time: the worker takes ownership of what it is
        // given, and the store's mesh must survive a repair that gets refused.
        const stl = input.indices
          ? writeBinarySTL(input.vertices, input.indices)
          : writeBinarySTLNonIndexed(input.vertices)

        // The conversion grid as-is, not a multiple of it. Verifying the result
        // costs far more than producing it here — the self-intersection census
        // runs over the *output*, and a cuberille's face count grows with the
        // cube of the resolution: measured under Pyodide, 17k faces verify in
        // 15 s and 114k in 99 s, while the backend itself never exceeds 1.4 s.
        // Quietly raising the grid would turn an opt-in click into two minutes.
        const started = Date.now()
        const response = await meshfix().run(mode, stl, {
          voxelResolution: settings.resolution,
          seal: settings.seal,
          shellThickness: settings.shellThickness > 0 ? settings.shellThickness : undefined,
        })
        setTiming({ ms: Date.now() - started, resolution: settings.resolution })
        setReport(response.report)

        if (response.refused) {
          setError(response.refused)
          return
        }
        if (mode === 'repair' && response.stl) {
          const parsed = parseSTL(response.stl)
          setInput(
            { vertices: parsed.vertices, indices: null, triangleCount: parsed.triangleCount },
            inputName,
          )
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setStatus('failed')
      }
    },
    [input, inputName, meshfix, setInput, settings.resolution, settings.seal, settings.shellThickness],
  )

  if (!isSupported()) {
    return (
      <p className="text-2xs leading-4 text-ink-4">
        Deep repair needs WebAssembly and module workers, which this browser does not have.
      </p>
    )
  }

  const busy = status === 'loading-runtime' || status === 'working'
  const failures = report ? failedCriteria(report) : []

  return (
    <div className="space-y-2">
      <h3 className="text-eyebrow">Deep repair (optional)</h3>
      <p className="text-2xs leading-4 text-ink-4">
        Runs the full <span className="font-mono">meshfix</span> criteria in the browser and
        rebuilds a guaranteed watertight, 2-manifold solid. Downloads a ~16 MB runtime the first
        time.
      </p>

      <div className="flex gap-2">
        <Button
          variant="secondary"
          className="flex-1"
          disabled={!input || busy}
          onClick={() => void run('diagnose')}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
          Diagnose
        </Button>
        <Button
          variant="secondary"
          className="flex-1"
          disabled={!input || busy}
          onClick={() => void run('repair')}
        >
          Repair
        </Button>
      </div>

      {busy && <p className="animate-pulse text-2xs text-ink-4">{STATUS_LABEL[status]}</p>}

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-warning-500/30 bg-warning-500/10 p-2 text-2xs leading-4 text-warning-500">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {report && (
        <div className="space-y-1 rounded-md border border-line bg-surface-2 p-2">
          <div className="flex items-center gap-1.5">
            {report.accepted ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 text-success-500" />
                <span className="text-2xs text-success-500">
                  {/* A8 is advisory unless --strict, so it can be listed below
                      while the result is still accepted. Saying "every
                      criterion satisfied" over a visible failure id reads as a
                      bug in the report. */}
                  {failures.length > 0
                    ? `Accepted — ${failures.join(', ')} outside tolerance but not blocking`
                    : 'Every criterion satisfied'}
                </span>
              </>
            ) : (
              <>
                <AlertTriangle className="h-3.5 w-3.5 text-warning-500" />
                <span className="text-2xs text-warning-500">
                  {failures.length} criteri{failures.length === 1 ? 'on' : 'a'} not met
                </span>
              </>
            )}
          </div>
          <Diagnosis report={report} />
          {timing && (
            <p className="text-2xs leading-4 text-ink-5">
              Took {(timing.ms / 1000).toFixed(1)} s at grid {timing.resolution}; verifying the
              result is the expensive part, and it climbs steeply with that slider.
            </p>
          )}
          {!report.accepted && failures.length > 0 && (
            // Naming them matters: "not repairable" alone leaves the user with
            // nothing to act on.
            <p className="font-mono text-2xs leading-4 text-ink-4">{failures.join(', ')}</p>
          )}
        </div>
      )}
    </div>
  )
}

function Diagnosis({ report }: { report: MeshfixReport }) {
  const d = report.input.diagnosis
  const defects: string[] = []
  if (!d.is_watertight) defects.push(`${d.n_boundary_edges} open edge(s)`)
  if (d.n_nonmanifold_edges) defects.push(`${d.n_nonmanifold_edges} non-manifold edge(s)`)
  if (d.n_selfintersecting_faces) defects.push(`${d.n_selfintersecting_faces} self-intersecting`)
  if (d.n_degenerate_faces) defects.push(`${d.n_degenerate_faces} degenerate`)
  if (d.n_components > 1) defects.push(`${d.n_components} components`)

  return (
    <p className="text-2xs leading-4 text-ink-4">
      Input read as <span className="font-mono">{d.verdict}</span>
      {defects.length > 0 ? `: ${defects.join(', ')}.` : ' — nothing to fix.'}
    </p>
  )
}
