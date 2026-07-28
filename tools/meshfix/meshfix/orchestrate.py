"""Backend chain orchestration (SPEC 6).

Kept out of :mod:`meshfix.cli` so the HTTP service in :mod:`meshfix.serve` can
reuse the exact same decision logic rather than re-implementing it.

The contract: try backends in order, run the **full validation** after each,
and take the first that satisfies every hard criterion. If none does, return
the attempt with the fewest hard violations (ties broken by the smaller
two-sided Hausdorff), mark it ``accepted: false`` and let the caller exit
non-zero. A backend's own exit status never decides anything (SPEC 15).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import trimesh

from .backends import RunContext, get_backend
from .diagnose import Diagnosis, analyze
from .io import load_mesh, save_mesh
from .metrics import compare
from .validate import ValidationResult, validate

log = logging.getLogger("meshfix.orchestrate")

#: Below this ratio of output to input volume we assume the outside flood leaked
#: through an opening and hollowed the model out (see `_volume_warning`).
VOLUME_COLLAPSE_RATIO = 0.5


@dataclass
class Attempt:
    name: str
    params: dict
    wall_time_s: float
    passed: bool
    n_hard_violations: int
    hausdorff_two_sided: float | None
    n_faces: int | None
    output_path: Path | None
    diagnosis: Diagnosis | None
    validation: ValidationResult | None
    metrics: dict
    message: str = ""

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "params": self.params,
            "wall_time_s": round(self.wall_time_s, 3),
            "passed": self.passed,
            "hard_violations": self.n_hard_violations,
            "hausdorff_two_sided": self.hausdorff_two_sided,
            "n_faces": self.n_faces,
            "message": self.message,
        }


@dataclass
class Outcome:
    attempts: list[Attempt]
    best: Attempt | None
    warnings: list[str]

    @property
    def accepted(self) -> bool:
        return bool(self.best and self.best.passed)


def build_chain(verdict: str, backend: str, fallback_chain: str | None) -> list[str]:
    """Decide which backends to try, in order (SPEC 6)."""
    if backend != "auto":
        return [backend]
    if fallback_chain:
        return [name.strip() for name in fallback_chain.split(",") if name.strip()]
    if verdict in ("severe", "shell"):
        return ["alphawrap", "voxel"]
    return ["alphawrap", "voxel", "poisson"]


def run_chain(
    *,
    source: trimesh.Trimesh,
    source_path: Path,
    chain: list[str],
    workdir: Path,
    ctx: RunContext,
    expected_components: int,
    max_deviation: float,
    min_wall: float | None,
    strict: bool,
    seed: int,
) -> Outcome:
    """Try each backend, validate its output, and pick a winner."""
    attempts: list[Attempt] = []
    warnings: list[str] = []
    workdir.mkdir(parents=True, exist_ok=True)

    for name in chain:
        try:
            backend = get_backend(name)
        except KeyError:
            log.warning("unknown backend %r in chain; skipping", name)
            warnings.append(f"unknown_backend_{name}")
            continue

        ok, reason = backend.available()
        if not ok:
            log.warning("backend %s unavailable: %s", name, reason)
            warnings.append(f"{name}_unavailable")
            continue

        params = backend.suggest_params(source, ctx)
        target = workdir / f"{name}.stl"
        log.info("running backend %s with %s", name, params)
        result = backend.run(source_path, target, params, log)

        if not result.success or result.output_path is None:
            attempts.append(
                Attempt(
                    name=name, params=params, wall_time_s=result.wall_time_s, passed=False,
                    n_hard_violations=99, hausdorff_two_sided=None, n_faces=None,
                    output_path=None, diagnosis=None, validation=None, metrics={},
                    message=result.message or "backend reported failure",
                )
            )
            continue

        produced = load_mesh(result.output_path)
        diagnosis = analyze(produced)
        metrics = compare(source, produced, seed=seed)
        validation = validate(
            diagnosis,
            expected_components=expected_components,
            max_deviation=max_deviation,
            hausdorff_two_sided=metrics["hausdorff_two_sided"],
            min_wall=min_wall,
            strict=strict,
        )
        attempts.append(
            Attempt(
                name=name, params=result.params_used or params,
                wall_time_s=result.wall_time_s, passed=validation.accepted,
                n_hard_violations=len(validation.hard_failures),
                hausdorff_two_sided=metrics["hausdorff_two_sided"],
                n_faces=len(produced.faces), output_path=result.output_path,
                diagnosis=diagnosis, validation=validation, metrics=metrics,
            )
        )
        if validation.accepted:
            log.info("backend %s satisfied every criterion", name)
            break
        log.info("backend %s failed: %s", name, ", ".join(validation.violations))

    usable = [a for a in attempts if a.output_path is not None]
    best = None
    if usable:
        best = min(
            usable,
            key=lambda a: (a.n_hard_violations, a.hausdorff_two_sided or float("inf")),
        )
        warnings.extend(_quality_warnings(best, source))
    return Outcome(attempts=attempts, best=best, warnings=warnings)


def _quality_warnings(attempt: Attempt, source: trimesh.Trimesh) -> list[str]:
    """Defects that pass every criterion but still matter to the user."""
    out: list[str] = []
    ratio = attempt.metrics.get("volume_ratio")
    if ratio is not None and ratio < VOLUME_COLLAPSE_RATIO:
        # An opening wider than the seal lets the outside flood reach the
        # interior, so the "solid" comes back as a thin shell wrapped around
        # the original surface. A8 cannot see this: the shell hugs the input,
        # so both Hausdorff directions stay small. Volume is the signal.
        out.append(
            f"volume_collapsed (output is {ratio:.0%} of the input volume; an opening "
            f"was probably wider than --seal, so the result is hollow)"
        )
    floor = attempt.metrics.get("hausdorff_noise_floor")
    if floor and attempt.hausdorff_two_sided is not None:
        if attempt.hausdorff_two_sided <= floor:
            out.append(
                "hausdorff_at_noise_floor (deviation is within the sampling resolution; "
                "increase samples before trusting it)"
            )
    return out


def write_result(attempt: Attempt, output_path: Path) -> Path:
    """Copy the winning attempt to its final destination."""
    save_mesh(load_mesh(attempt.output_path), output_path)
    return output_path
