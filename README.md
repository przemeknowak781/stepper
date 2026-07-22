# Stepper — 3D → STEP converter

Stepper turns an arbitrary input mesh (**STL / OBJ / GLTF / GLB**) into a clean,
watertight **engineering solid** and exports it to **STEP (ISO 10303-21, AP214)**
— ready to open in FreeCAD, Fusion, SolidWorks, or any CAD package, and to STL.

It reuses the 3D environment, design system, mesh loaders and the
voxel *slicer* from the sibling **Optimizer** project.

## Why reconstruct instead of repair?

Meshes exported from scanners, sculpting tools or game pipelines are usually
**not** valid solids: open holes, non-manifold edges, self-intersections,
flipped normals, duplicated faces. CAD kernels reject those.

Stepper's conversion is **reconstruction-based**, not repair-based:

1. **Voxelise** — the input surface is rasterised into an occupancy grid by the
   Optimizer slicer (`sliceAndVoxelize`). An even–odd scanline fill marks which
   cells are inside the body.
2. **Reconstruct a fresh surface** from the filled volume:
   - **Voxel** (`occupancyToSolid`) — a cuberille shell; blocky but the most
     literal discretisation, few large planar facets.
   - **Smooth** (`marchingCubesFromVoxelDensity` + feature-preserving Taubin
     smoothing) — a rounded iso-surface that hugs the original silhouette.

Because the output surface is generated from scratch around the volume, the
result is **watertight and 2-manifold by construction** — every defect in the
input connectivity simply disappears. The grid **resolution** is the single
optimisation knob: coarse grids simplify (fewer faces, lighter STEP), fine grids
stay faithful.

The app reports whether the output is a closed manifold and warns when the input
had open regions that were sealed.

## STEP export

`src/lib/step/exportSTEP.ts` emits a full AP214 `ADVANCED_BREP_SHAPE_REPRESENTATION`:
a `MANIFOLD_SOLID_BREP` whose `CLOSED_SHELL` has one planar `ADVANCED_FACE` per
triangle. Vertices and edges are **shared** between adjacent faces (each edge is
one `EDGE_CURVE` referenced by two oppositely-oriented `ORIENTED_EDGE`s), so CAD
tools import it as a real solid body. Unit is millimetres.

## Stack

Vite 5 · React 19 · TypeScript 5 (strict) · @react-three/fiber + three r170 ·
three-mesh-bvh · zustand · Tailwind 3.

```
pnpm install
pnpm dev        # dev server
pnpm test       # vitest (STL round-trip, watertight conversion, STEP validity)
pnpm typecheck
pnpm build
```

## Layout

```
src/lib/geometry/   slicer + reconstruction (ported from Optimizer) + convert.ts
src/lib/step/       STEP AP214 exporter
src/lib/stl/        binary/ASCII STL parse + write
src/lib/loaders/    STL/OBJ/GLTF/GLB loading
src/state/          zustand converter store
src/hooks/          upload, sample, debounced conversion
src/components/     R3F viewer + control / export panels
```

## Deployment (GitHub Pages)

Pushing to `main` runs `.github/workflows/deploy.yml`, which builds with
`VITE_BASE=/stepper/` and publishes `dist/` to GitHub Pages. The app is fully
static — no server needed.

**One-time setup (repo admin, required once):** open
**Settings → Pages → Build and deployment → Source** and select
**GitHub Actions**. The Actions token cannot create the Pages site itself on
this account (it fails with *"Resource not accessible by integration"* until
Pages is turned on by hand). After enabling it, re-run the latest
*Deploy to GitHub Pages* workflow (Actions tab → Run workflow) or push any commit
to `main`.

Live URL after the first successful deploy:
**https://przemeknowak781.github.io/stepper/**

If the repository is ever renamed, update `VITE_BASE` in the workflow (and the
`base` fallback in `vite.config.ts`) to `/<new-name>/`.
