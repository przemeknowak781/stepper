import { useEffect } from 'react'
import { useConverterStore } from '@/state/converterStore'
import { convertMeshToSolid } from '@/lib/geometry/convert'

/**
 * Recompute the converted solid whenever the input mesh or the conversion
 * settings change.  Debounced so dragging a slider doesn't fire a heavy
 * voxelisation on every intermediate value, and deferred via `setTimeout` so
 * the "converting…" flag paints before the (synchronous) pipeline blocks the
 * main thread.
 */
export function useConversion(): void {
  const input = useConverterStore((s) => s.input)
  const settings = useConverterStore((s) => s.settings)

  useEffect(() => {
    if (!input) return
    const store = useConverterStore.getState()
    store.setConverting(true)

    const debounce = window.setTimeout(() => {
      try {
        const { solid, report } = convertMeshToSolid(input.vertices, input.indices, settings)
        useConverterStore.getState().setResult(solid, report)
      } catch (err) {
        useConverterStore.getState().setError(
          err instanceof Error ? err.message : 'Conversion failed',
        )
      }
    }, 180)

    return () => window.clearTimeout(debounce)
  }, [input, settings])
}
