"""Acceptance criteria A1..A10 (SPEC 2).

The rule that shapes this module: a criterion is either **passed**, **failed**
or **inactive**, and an inactive criterion never counts as passed. There is no
"close enough" state, and success is decided here — never by a backend's exit
code (SPEC 15).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .diagnose import Diagnosis, SHELL_SCORE_THRESHOLD

HARD_CRITERIA = ("A1", "A2", "A3", "A4", "A5", "A6", "A7", "A10")
SOFT_CRITERIA = ("A8", "A9")


@dataclass
class Criterion:
    id: str
    name: str
    passed: bool | None          # None = inactive
    value: object
    threshold: object = None
    hard: bool = True
    active: bool = True
    reason: str = ""

    def to_dict(self) -> dict:
        out: dict = {"active": self.active}
        if self.active:
            out["passed"] = self.passed
            out["value"] = self.value
            if self.threshold is not None:
                out["threshold"] = self.threshold
        if self.reason:
            out["reason"] = self.reason
        return out


@dataclass
class ValidationResult:
    criteria: dict[str, Criterion] = field(default_factory=dict)
    strict: bool = False

    @property
    def hard_failures(self) -> list[str]:
        return [
            f"{c.id}_{c.name}"
            for c in self.criteria.values()
            if c.hard and c.active and c.passed is False
        ]

    @property
    def soft_failures(self) -> list[str]:
        return [
            f"{c.id}_{c.name}"
            for c in self.criteria.values()
            if not c.hard and c.active and c.passed is False
        ]

    @property
    def accepted(self) -> bool:
        """Hard criteria always bind; soft ones bind only under --strict."""
        if self.hard_failures:
            return False
        if self.strict and self.soft_failures:
            return False
        return True

    @property
    def violations(self) -> list[str]:
        out = list(self.hard_failures)
        if self.strict:
            out += self.soft_failures
        return out

    def to_dict(self) -> dict:
        return {f"{c.id}_{c.name}": c.to_dict() for c in self.criteria.values()}


def validate(
    diag: Diagnosis,
    *,
    expected_components: int = 1,
    max_deviation: float | None = None,
    hausdorff_two_sided: float | None = None,
    min_wall: float | None = None,
    min_wall_estimate: float | None = None,
    shell_thickness: float | None = None,
    check_shell: bool = False,
    strict: bool = False,
) -> ValidationResult:
    """Evaluate every criterion against a diagnosis.

    ``check_shell`` selects A10, which is a property of the *input* (SPEC 5.3):
    asking whether an already-wrapped output is a shell is meaningless, because
    every backend produces a closed solid by construction.
    """
    result = ValidationResult(strict=strict)

    def add(c: Criterion) -> None:
        result.criteria[c.id] = c

    add(Criterion("A1", "watertight", diag.is_watertight, diag.is_watertight))
    add(
        Criterion(
            "A2",
            "manifold",
            diag.n_nonmanifold_edges == 0 and diag.n_nonmanifold_vertices == 0,
            {
                "nonmanifold_edges": diag.n_nonmanifold_edges,
                "nonmanifold_vertices": diag.n_nonmanifold_vertices,
            },
        )
    )
    add(Criterion("A3", "winding", diag.is_winding_consistent, diag.is_winding_consistent))
    add(
        Criterion(
            "A4",
            "positive_volume",
            diag.volume is not None and diag.volume > 0,
            diag.volume,
        )
    )
    add(
        Criterion(
            "A5",
            "no_selfintersection",
            diag.n_selfintersecting_faces == 0,
            diag.n_selfintersecting_faces,
        )
    )
    add(Criterion("A6", "no_degenerate", diag.n_degenerate_faces == 0, diag.n_degenerate_faces))
    add(
        Criterion(
            "A7",
            "components",
            diag.n_components == expected_components,
            diag.n_components,
            threshold=expected_components,
        )
    )

    # A8 — fidelity, two-sided (SPEC 2, change C1).
    if hausdorff_two_sided is None or max_deviation is None:
        add(
            Criterion(
                "A8", "hausdorff", None, None, hard=False, active=False,
                reason="no reference mesh to compare against",
            )
        )
    else:
        add(
            Criterion(
                "A8",
                "hausdorff",
                hausdorff_two_sided <= max_deviation,
                hausdorff_two_sided,
                threshold=max_deviation,
                hard=False,
            )
        )

    # A9 — wall thickness, inactive without an explicit --min-wall (change C3).
    if min_wall is None:
        add(
            Criterion(
                "A9", "min_wall", None, min_wall_estimate, hard=False, active=False,
                reason="--min-wall not supplied; wall thickness reported as a metric only",
            )
        )
    elif min_wall_estimate is None:
        add(
            Criterion(
                "A9", "min_wall", None, None, hard=False, active=False,
                reason="wall thickness could not be estimated",
            )
        )
    else:
        add(
            Criterion(
                "A9",
                "min_wall",
                min_wall_estimate >= min_wall,
                min_wall_estimate,
                threshold=min_wall,
                hard=False,
            )
        )

    # A10 — the input must be a solid, or the user must say how thick to make it.
    if not check_shell:
        add(
            Criterion(
                "A10", "is_solid", None, diag.shell_score, active=False,
                reason="only evaluated on the input mesh",
            )
        )
    else:
        is_solid = diag.shell_score < SHELL_SCORE_THRESHOLD
        add(
            Criterion(
                "A10",
                "is_solid",
                is_solid or shell_thickness is not None,
                diag.shell_score,
                threshold=SHELL_SCORE_THRESHOLD,
                reason=(
                    ""
                    if is_solid
                    else (
                        "input is an open shell, not a solid; re-run with "
                        "--shell-thickness T to give it a wall"
                    )
                ),
            )
        )

    return result
