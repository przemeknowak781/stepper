import { create } from 'zustand'
import type { MainMeshData } from '@/types/project'
import {
  DEFAULT_CONVERT_SETTINGS,
  type ConvertReport,
  type ConvertSettings,
} from '@/lib/geometry/convert'
import type { SolidMesh } from '@/lib/geometry/slicedSolid'

interface ConverterState {
  /** The loaded input mesh (null until a file is dropped). */
  input: MainMeshData | null
  /** Original file name, used for export naming. */
  inputName: string

  settings: ConvertSettings

  /** Latest conversion output (null until the first run finishes). */
  solid: SolidMesh | null
  report: ConvertReport | null
  converting: boolean
  error: string | null

  /** Viewport toggles. */
  showInput: boolean
  showSolid: boolean
  showGrid: boolean

  setInput: (mesh: MainMeshData, name: string) => void
  updateSettings: (patch: Partial<ConvertSettings>) => void
  setResult: (solid: SolidMesh, report: ConvertReport) => void
  setConverting: (v: boolean) => void
  setError: (e: string | null) => void
  toggle: (key: 'showInput' | 'showSolid' | 'showGrid') => void
  reset: () => void
}

export const useConverterStore = create<ConverterState>((set) => ({
  input: null,
  inputName: '',
  settings: { ...DEFAULT_CONVERT_SETTINGS },
  solid: null,
  report: null,
  converting: false,
  error: null,
  showInput: true,
  showSolid: true,
  showGrid: true,

  setInput: (mesh, name) =>
    set({ input: mesh, inputName: name, solid: null, report: null, error: null }),
  updateSettings: (patch) =>
    set((s) => ({ settings: { ...s.settings, ...patch } })),
  setResult: (solid, report) => set({ solid, report, converting: false, error: null }),
  setConverting: (v) => set({ converting: v }),
  setError: (e) => set({ error: e, converting: false }),
  toggle: (key) => set((s) => ({ [key]: !s[key] } as Partial<ConverterState>)),
  reset: () =>
    set({
      input: null,
      inputName: '',
      solid: null,
      report: null,
      error: null,
      converting: false,
    }),
}))
