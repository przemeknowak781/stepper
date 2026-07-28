# meshfix

Deterministic mesh repair for 3D printing, with quantified fidelity loss.
Doubles as the optional **local repair backend for Stepper** (SPEC §16).

Full contract in [`SPEC.md`](SPEC.md); implementation decisions, deviations and
measured gaps in [`NOTES.md`](NOTES.md).

## Install

```bash
python3 -m venv .venv
./.venv/bin/pip install -e ".[dev]"
```

## Use as a CLI

```bash
meshfix fix model.stl -o model_fixed.stl        # repair
meshfix fix model.stl --dry-run                 # diagnose only, nothing written
meshfix fix model.stl --strict --max-deviation 0.2
meshfix fix shell.stl --shell-thickness 1.2     # an open shell needs a wall
```

Exit codes: `0` accepted, `1` a hard criterion failed, `2` bad arguments/input,
`3` a missing dependency. Success is decided by validating the produced mesh,
never by a backend's exit status.

## Use as Stepper's local backend

```bash
meshfix serve --serve-app ../../dist
```

Then open <http://127.0.0.1:8787>. Stepper detects the service and routes meshes
through it before its own STEP conversion; if the service is not running the app
falls back to its in-browser pipeline with no change in behaviour.

Serving the app from the same origin is recommended because a page loaded over
**https** may call `http://localhost` only in Chromium — Firefox and Safari
have historically blocked it as mixed content. `pnpm dev` (http://localhost:5173)
also works.

The service binds to **loopback only**, checks request origins against an
allowlist, and requires `Content-Type: application/octet-stream` so that
cross-origin calls must pass a preflight.

## What it guarantees

A mesh is accepted only when every hard criterion holds: watertight, 2-manifold
(edges *and* vertices), consistent winding, positive volume, no
self-intersections, no degenerate faces, the expected component count, and a
solid — not an open shell — on input. Fidelity (two-sided Hausdorff) and wall
thickness are reported always and enforced under `--strict`.

## Status

| Milestone | Scope | State |
|---|---|---|
| M0 | package, IO, procedural fixtures | done |
| M1 | diagnosis, validation, report, `--dry-run` | done |
| M2 | two-sided Hausdorff, Chamfer, SDF wall thickness | done |
| M3 | voxel backend, orchestration, CLI, local service | done |
| M4 | CGAL alpha wrapping (`aw3`) + alpha ladder | not started |
| M5 | decimation with revert-on-violation | not started |
| M6 | Poisson backend with density trimming | not started |

Until M4 lands, `--backend auto` reports `alphawrap_unavailable` in the report
warnings and falls through to the voxel backend, which is robust but blockier.

## Tests

```bash
./.venv/bin/python -m pytest -q
```
