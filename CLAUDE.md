# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Stepper** is a single-page web app that converts an arbitrary input mesh
(STL/OBJ/GLTF/GLB) into a watertight engineering solid and exports it to **STEP
(ISO 10303-21, AP214)** and STL. It reuses the 3D environment, design system,
mesh loaders and voxel *slicer* from the sibling **Optimizer** repo.

See `README.md` for the user-facing overview.

## Core idea: reconstruction, not repair

Conversion is reconstruction-based so topology is **correct by construction**.
The pipeline lives in `src/lib/geometry/convert.ts::convertMeshToSolid`:

1. `computeGridFromVertices` → fit a voxel grid to the mesh AABB (resolution =
   in-plane cells across the longer extent, slices = layers along `axis`).
2. `sliceAndVoxelize` (ported from Optimizer) → even–odd scanline fill into an
   occupancy grid. `openRowFraction > 0` means the input had open regions.
3. Rebuild a fresh surface:
   - `method: 'voxel'` → `occupancyToSolid` (cuberille, welded corners).
   - `method: 'smooth'` → `marchingCubesFromVoxelDensity` (iso 0.5) then
     `taubinSmoothBounded` (feature-preserving; won't sever thin members).

Every output is watertight/2-manifold because it is generated around the filled
volume, not inherited from input connectivity. `isWatertight` (every undirected
edge used by exactly two triangles) is the honest check surfaced in the UI.

## Ported-from-Optimizer modules (do not diverge casually)

`src/lib/geometry/{sliceFrame,sliceVoxelize,slicedSolid,hexFaces,marchingCubes,marchingCubesTables}.ts`,
`src/lib/stl/{parseSTL,exportSTL}.ts`, `src/lib/loaders/*`, and
`src/components/viewer/bvh.ts` are copied from Optimizer with import paths
adjusted. `boundingBox.ts` is a slimmed local copy (AABB helpers only, no
project-type deps). Keep these in sync with Optimizer when fixing bugs.

## STEP exporter invariants (`src/lib/step/exportSTEP.ts`)

- Output is a full AP214 `ADVANCED_BREP_SHAPE_REPRESENTATION` → `MANIFOLD_SOLID_BREP`
  → `CLOSED_SHELL` of planar `ADVANCED_FACE`s (one per triangle), plus the
  product/context boilerplate so all CAD tools import it.
- **Vertices and edges are shared.** `weldMesh` collapses coincident vertices;
  each undirected edge becomes ONE `EDGE_CURVE`, referenced by exactly two
  `ORIENTED_EDGE`s with opposite sense. The test in `tests/unit/exportSTEP.test.ts`
  asserts this 2-per-edge invariant — it is what makes the shell closed.
- **Reals must not use lowercase-`e` exponent form** (invalid for strict STEP
  parsers). `num()` uses fixed 6-decimal notation; a test guards against `e`.
- Unit is hard-coded millimetres.

## State & UI

- One zustand store: `src/state/converterStore.ts` (input mesh, settings, result,
  view toggles).
- `useConversion` recomputes the solid (debounced, deferred) whenever the mesh or
  settings change. Conversion is synchronous — if it becomes a bottleneck on big
  grids, move `convertMeshToSolid` into a worker.
- Viewer (`src/components/viewer/Viewer.tsx`) is a lean R3F canvas showing the
  original (ghost wireframe) and the converted solid; it is NOT the heavy
  Optimizer Scene (which is tied to FEM/region/BC domain state).

## Conventions

- Design tokens in `tailwind.config.ts` + `src/index.css` (copied from Optimizer):
  `surface-0..5`, `ink-1..5`, `line`, semantic `accent/success/warning/danger`.
  Icons via `lucide-react`, never emoji.
- Path alias `@/` → `src/`.
- Gates: `pnpm typecheck`, `pnpm test`, `pnpm build` must stay green.

## Branching

Active branch: `claude/3d-to-step-converter-7borlp`. Remote `przemeknowak781/stepper`.
Push only to the assigned branch.
