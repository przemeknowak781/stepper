"""Command line entry point and orchestration (SPEC 3, 6).

Exit codes are part of the contract:

* ``0`` accepted
* ``1`` a hard criterion failed after the fallback chain was exhausted
* ``2`` bad input, unsupported format, or contradictory arguments
* ``3`` a required dependency is missing
"""

from __future__ import annotations

import logging
import tempfile
from enum import Enum
from pathlib import Path
from typing import Optional

import typer

from .backends import RunContext
from .diagnose import SHELL_SCORE_THRESHOLD, analyze
from .io import EmptyMeshError, UnsupportedFormatError, load_mesh, save_mesh, sha256_file
from .orchestrate import build_chain, run_chain, write_result
from .postprocess import thicken_shell
from .report import Report
from .validate import validate

EXIT_OK = 0
EXIT_REJECTED = 1
EXIT_INPUT = 2
EXIT_DEPENDENCY = 3

log = logging.getLogger("meshfix")


class BackendChoice(str, Enum):
    auto = "auto"
    alphawrap = "alphawrap"
    voxel = "voxel"
    ftetwild = "ftetwild"
    poisson = "poisson"


class Units(str, Enum):
    mm = "mm"
    cm = "cm"
    m = "m"
    inch = "in"


app = typer.Typer(add_completion=False, help=__doc__)


@app.command("serve")
def serve_command(
    port: int = typer.Option(8787, "--port"),
    app_dir: Optional[Path] = typer.Option(
        None, "--serve-app",
        help="also serve a built Stepper app from this directory, at the same origin",
    ),
    allow_origin: list[str] = typer.Option([], "--allow-origin", help="extra CORS origin"),
    verbose: int = typer.Option(0, "-v", count=True),
) -> None:
    """Run the local repair service that Stepper can call (loopback only)."""
    logging.basicConfig(
        level={0: logging.WARNING, 1: logging.INFO}.get(verbose, logging.DEBUG),
        format="%(levelname)s %(message)s",
    )
    from .serve import DEFAULT_ALLOWED_ORIGINS, serve

    serve(
        port,
        allowed_origins=tuple(DEFAULT_ALLOWED_ORIGINS) + tuple(allow_origin),
        app_dir=app_dir,
    )


@app.command("fix")
def run(
    input_path: Path = typer.Argument(..., metavar="INPUT", help="input mesh"),
    output: Optional[Path] = typer.Option(None, "-o", "--output"),
    report_path: Optional[Path] = typer.Option(None, "--report"),
    keep_intermediates: Optional[Path] = typer.Option(None, "--keep-intermediates"),
    backend: BackendChoice = typer.Option(BackendChoice.auto, "--backend"),
    fallback_chain: Optional[str] = typer.Option(None, "--fallback-chain"),
    alpha: Optional[float] = typer.Option(None, "--alpha"),
    offset: Optional[float] = typer.Option(None, "--offset"),
    voxel_resolution: int = typer.Option(256, "--voxel-resolution"),
    voxel_size: Optional[float] = typer.Option(None, "--voxel-size"),
    seal: int = typer.Option(1, "--seal", help="crack-bridging radius in voxels"),
    max_deviation: Optional[float] = typer.Option(None, "--max-deviation"),
    min_wall: Optional[float] = typer.Option(None, "--min-wall"),
    units: Optional[Units] = typer.Option(None, "--units"),
    shell_thickness: Optional[float] = typer.Option(None, "--shell-thickness"),
    target_faces: int = typer.Option(0, "--target-faces"),
    expected_components: int = typer.Option(1, "--expected-components"),
    strict: bool = typer.Option(False, "--strict"),
    dry_run: bool = typer.Option(False, "--dry-run"),
    seed: int = typer.Option(0, "--seed"),
    verbose: int = typer.Option(0, "-v", count=True),
) -> None:
    """Repair INPUT into a printable solid, or explain exactly why it could not."""
    logging.basicConfig(
        level={0: logging.WARNING, 1: logging.INFO}.get(verbose, logging.DEBUG),
        format="%(levelname)s %(message)s",
    )

    # --- argument consistency (change C13) --------------------------------
    if backend is not BackendChoice.auto and fallback_chain:
        typer.echo(
            "error: --backend and --fallback-chain are mutually exclusive; "
            "--backend pins a single backend while --fallback-chain lists several",
            err=True,
        )
        raise typer.Exit(EXIT_INPUT)
    if min_wall is not None and units is None:
        typer.echo(
            "error: --min-wall requires --units, because mesh files carry no unit "
            "and a wall threshold is a physical quantity",
            err=True,
        )
        raise typer.Exit(EXIT_INPUT)

    # --- load --------------------------------------------------------------
    try:
        mesh = load_mesh(input_path)
    except (UnsupportedFormatError, EmptyMeshError, FileNotFoundError) as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(EXIT_INPUT) from exc

    log.info("loaded %s (%d faces)", input_path, len(mesh.faces))
    diagnosis = analyze(mesh)
    log.info("verdict=%s shell_score=%.2f", diagnosis.verdict, diagnosis.shell_score)

    if max_deviation is None:
        max_deviation = 0.005 * diagnosis.bbox_diagonal

    report = Report(
        input_path=str(input_path),
        input_sha256=sha256_file(input_path),
        input_diagnosis=diagnosis,
        dry_run=dry_run,
    )

    # --- dry run: diagnosis only -------------------------------------------
    if dry_run:
        report.validation = validate(
            diagnosis,
            expected_components=expected_components,
            min_wall=min_wall,
            shell_thickness=shell_thickness,
            check_shell=True,
            strict=strict,
        )
        report.accepted = report.validation.accepted
        _emit(report, report_path, output, input_path)
        raise typer.Exit(EXIT_OK if report.accepted else EXIT_REJECTED)

    # --- A10: refuse an open shell rather than inventing a thickness -------
    input_validation = validate(
        diagnosis,
        expected_components=expected_components,
        min_wall=min_wall,
        shell_thickness=shell_thickness,
        check_shell=True,
        strict=strict,
    )
    a10 = input_validation.criteria["A10"]
    if a10.active and a10.passed is False:
        report.validation = input_validation
        report.accepted = False
        typer.echo(a10.reason, err=True)
        _emit(report, report_path, output, input_path)
        raise typer.Exit(EXIT_REJECTED)

    if diagnosis.n_components != expected_components:
        # Told early so the user does not wait for the whole chain to discover it.
        log.warning(
            "input has %d connected components but --expected-components is %d; "
            "A7 will fail unless a backend merges them",
            diagnosis.n_components,
            expected_components,
        )

    output_path = output or input_path.with_name(f"{input_path.stem}_fixed.stl")

    # --- printable input: nothing to repair --------------------------------
    if diagnosis.verdict == "printable" and target_faces == 0:
        log.info("input is already printable; skipping repair")
        save_mesh(mesh, output_path)
        out_diag = analyze(load_mesh(output_path))
        report.output_path = str(output_path)
        report.output_sha256 = sha256_file(output_path)
        report.output_diagnosis = out_diag
        report.backend_selected = None
        report.validation = validate(
            out_diag,
            expected_components=expected_components,
            max_deviation=max_deviation,
            hausdorff_two_sided=0.0,
            min_wall=min_wall,
            strict=strict,
        )
        report.metrics = {
            "hausdorff_two_sided": 0.0,
            "hausdorff_in_to_out": 0.0,
            "hausdorff_out_to_in": 0.0,
            "hausdorff_approximate": False,
        }
        report.accepted = report.validation.accepted
        _emit(report, report_path, output_path, input_path)
        raise typer.Exit(EXIT_OK if report.accepted else EXIT_REJECTED)

    # --- repair path --------------------------------------------------------
    if shell_thickness is not None and diagnosis.shell_score >= SHELL_SCORE_THRESHOLD:
        mesh = thicken_shell(mesh, shell_thickness)
        report.warnings.append(f"shell_thickened (thickness={shell_thickness})")
        log.info("thickened open shell by %.4g before repair", shell_thickness)

    ctx = RunContext(
        seed=seed,
        max_deviation=max_deviation,
        bbox_diagonal=diagnosis.bbox_diagonal,
        voxel_resolution=voxel_resolution,
        voxel_size=voxel_size,
        seal=seal,
        alpha=alpha,
        offset=offset,
    )
    chain = build_chain(diagnosis.verdict, backend.value, fallback_chain)
    log.info("backend chain: %s", ", ".join(chain))

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(keep_intermediates) if keep_intermediates else Path(tmp)
        source_path = workdir / "source.stl"
        save_mesh(mesh, source_path)

        outcome = run_chain(
            source=mesh,
            source_path=source_path,
            chain=chain,
            workdir=workdir,
            ctx=ctx,
            expected_components=expected_components,
            max_deviation=max_deviation,
            min_wall=min_wall,
            strict=strict,
            seed=seed,
        )
        report.warnings.extend(outcome.warnings)
        report.backend_attempts = [a.to_dict() for a in outcome.attempts]

        if outcome.best is None:
            typer.echo(
                "error: no backend produced a mesh. "
                + "; ".join(outcome.warnings or ["chain was empty"]),
                err=True,
            )
            report.validation = input_validation
            report.accepted = False
            _emit(report, report_path, output, input_path)
            raise typer.Exit(EXIT_DEPENDENCY if outcome.warnings else EXIT_REJECTED)

        write_result(outcome.best, output_path)
        report.backend_selected = outcome.best.name
        report.output_path = str(output_path)
        report.output_sha256 = sha256_file(output_path)
        report.output_diagnosis = outcome.best.diagnosis
        report.validation = outcome.best.validation
        report.metrics = outcome.best.metrics
        report.accepted = outcome.best.passed

    _emit(report, report_path, output_path, input_path)
    raise typer.Exit(EXIT_OK if report.accepted else EXIT_REJECTED)


def _emit(report: Report, report_path: Path | None, output: Path | None, input_path: Path) -> None:
    target = report_path or (output or input_path).with_suffix(".report.json")
    report.write(target)
    typer.echo(report.summary())


def main() -> None:  # pragma: no cover - thin console-script wrapper
    app()


if __name__ == "__main__":  # pragma: no cover
    main()
