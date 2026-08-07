import clsx from 'clsx'
import { Layers } from 'lucide-react'
import { useConverterStore } from '@/state/converterStore'
import type { ConvertMethod } from '@/lib/geometry/convert'
import type { SliceAxis } from '@/lib/geometry/sliceFrame'

function Row({ label, value, children }: { label: string; value?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-ink-3">{label}</span>
        {value !== undefined && <span className="font-mono text-xs text-ink-2">{value}</span>}
      </div>
      {children}
    </label>
  )
}

function Slider(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="range"
      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-4 accent-accent-400"
      {...props}
    />
  )
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded-md border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'flex-1 rounded px-2 py-1 text-xs font-medium transition-colors duration-fast',
            value === o.value ? 'bg-surface-4 text-ink-1 shadow-e1' : 'text-ink-4 hover:text-ink-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ControlsPanel() {
  const settings = useConverterStore((s) => s.settings)
  const update = useConverterStore((s) => s.updateSettings)
  const showInput = useConverterStore((s) => s.showInput)
  const showSolid = useConverterStore((s) => s.showSolid)
  const showGrid = useConverterStore((s) => s.showGrid)
  const toggle = useConverterStore((s) => s.toggle)

  const shell = useConverterStore((s) => s.report?.shell)

  return (
    <div className="space-y-5">
      {shell?.isShell && (
        <section className="space-y-2 rounded-md border border-warning-500/30 bg-warning-500/10 p-3">
          <div className="flex items-start gap-2">
            <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-500" />
            <div className="space-y-1">
              <h3 className="text-xs font-medium text-warning-500">This model is a surface</h3>
              <p className="text-2xs leading-4 text-ink-3">
                It has an open boundary and encloses almost no volume — an average of{' '}
                <span className="font-mono">{shell.impliedThickness.toFixed(4)}</span> across{' '}
                <span className="font-mono">{shell.area.toFixed(3)}</span> of area. There is no
                correct solid until you say how thick the wall should be.
              </p>
            </div>
          </div>

          <Row label="Wall thickness" value={settings.shellThickness.toFixed(4)}>
            <Slider
              min={0}
              max={shell.suggestedThickness * 4}
              step={shell.suggestedThickness / 100}
              value={settings.shellThickness}
              onChange={(e) => update({ shellThickness: Number(e.target.value) })}
            />
          </Row>

          {settings.shellThickness <= 0 && (
            <button
              onClick={() => update({ shellThickness: shell.suggestedThickness })}
              className="w-full rounded border border-line bg-surface-3 px-2 py-1 text-2xs font-medium text-ink-2 transition-colors duration-fast hover:bg-surface-4"
            >
              Use {shell.suggestedThickness.toFixed(4)} (1% of the model)
            </button>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h3 className="text-eyebrow">Conversion</h3>

        <Row label="Method">
          <Segmented<ConvertMethod>
            value={settings.method}
            onChange={(method) => update({ method })}
            options={[
              { value: 'faithful', label: 'Faithful (exact B-rep)' },
              { value: 'voxel', label: 'Voxel (repair)' },
              { value: 'smooth', label: 'Smooth (organic)' },
            ]}
          />
        </Row>

        <p className="text-2xs leading-4 text-ink-4">
          {settings.method === 'faithful'
            ? 'Repairs the mesh to a manifold (weld, re-orient, fill holes) and merges coplanar faces — exact & economical. Falls back to solidify if unrepairable.'
            : settings.method === 'voxel'
              ? 'Robustly solidifies any mesh (flood-fill volume, immune to holes/flipped normals), then merges flat faces.'
              : 'Solidifies then rebuilds a smooth rounded surface (fine triangle mesh in STEP).'}
        </p>

        {(settings.method === 'faithful' || settings.method === 'voxel') && (
          <Row label="Planar tolerance" value={`${settings.planarToleranceDeg}°`}>
            <Slider
              min={0}
              max={30}
              step={0.5}
              value={settings.planarToleranceDeg}
              onChange={(e) => update({ planarToleranceDeg: Number(e.target.value) })}
            />
          </Row>
        )}

        {settings.method !== 'faithful' && (
          <>
            <Row label="Grid resolution" value={`${settings.resolution}`}>
              <Slider
                min={8}
                max={128}
                step={1}
                value={settings.resolution}
                onChange={(e) => update({ resolution: Number(e.target.value) })}
              />
            </Row>

            <Row label="Layers" value={`${settings.slices}`}>
              <Slider
                min={4}
                max={128}
                step={1}
                value={settings.slices}
                onChange={(e) => update({ slices: Number(e.target.value) })}
              />
            </Row>

            <Row label="Crack seal" value={`${settings.seal} vx`}>
              <Slider
                min={0}
                max={3}
                step={1}
                value={settings.seal}
                onChange={(e) => update({ seal: Number(e.target.value) })}
              />
            </Row>
          </>
        )}

        {settings.method === 'smooth' && (
          <Row label="Smoothing" value={`${settings.smoothIterations} it`}>
            <Slider
              min={0}
              max={30}
              step={1}
              value={settings.smoothIterations}
              onChange={(e) => update({ smoothIterations: Number(e.target.value) })}
            />
          </Row>
        )}

        {settings.method !== 'faithful' && (
          <Row label="Slicing axis">
            <Segmented<SliceAxis>
              value={settings.axis}
              onChange={(axis) => update({ axis })}
              options={[
                { value: 'x', label: 'X' },
                { value: 'y', label: 'Y' },
                { value: 'z', label: 'Z' },
              ]}
            />
          </Row>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-eyebrow">Display</h3>
        <div className="flex flex-wrap gap-2">
          <ToggleChip active={showInput} onClick={() => toggle('showInput')} label="Original" />
          <ToggleChip active={showSolid} onClick={() => toggle('showSolid')} label="Solid" />
          <ToggleChip active={showGrid} onClick={() => toggle('showGrid')} label="Grid" />
        </div>
      </section>
    </div>
  )
}

function ToggleChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors duration-fast',
        active
          ? 'border-accent-500/40 bg-accent-500/15 text-accent-300'
          : 'border-line bg-surface-2 text-ink-4 hover:text-ink-2',
      )}
    >
      {label}
    </button>
  )
}
