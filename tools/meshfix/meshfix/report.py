"""Report serialisation (SPEC 9).

The JSON schema is versioned and stable; the text summary is capped at 20
lines and always ends in an unambiguous ACCEPTED or REJECTED line, so a human
skimming stdout can never mistake a partial success for a success.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from . import __version__
from .diagnose import Diagnosis
from .validate import ValidationResult

SCHEMA_VERSION = "1.1"
MAX_SUMMARY_LINES = 20


@dataclass
class Report:
    input_path: str
    input_sha256: str
    input_diagnosis: Diagnosis
    output_path: str | None = None
    output_sha256: str | None = None
    output_diagnosis: Diagnosis | None = None
    accepted: bool = False
    validation: ValidationResult | None = None
    backend_selected: str | None = None
    backend_attempts: list[dict] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    dry_run: bool = False

    def to_dict(self) -> dict:
        return {
            "schema_version": SCHEMA_VERSION,
            "tool_version": __version__,
            "timestamp_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "dry_run": self.dry_run,
            "input": {
                "path": self.input_path,
                "sha256": self.input_sha256,
                "diagnosis": self.input_diagnosis.to_dict(),
            },
            "output": (
                None
                if self.output_diagnosis is None
                else {
                    "path": self.output_path,
                    "sha256": self.output_sha256,
                    "diagnosis": self.output_diagnosis.to_dict(),
                }
            ),
            "accepted": self.accepted,
            "criteria": self.validation.to_dict() if self.validation else {},
            "backend": {
                "selected": self.backend_selected,
                "attempts": self.backend_attempts,
            },
            "metrics": self.metrics,
            "warnings": self.warnings,
        }

    def write(self, path: str | Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        # sort_keys keeps the file byte-stable for a given content (SPEC 1.1).
        path.write_text(json.dumps(self.to_dict(), indent=2, sort_keys=True) + "\n")
        return path

    def summary(self) -> str:
        """At most 20 lines, ending in ACCEPTED or REJECTED."""
        d = self.input_diagnosis
        lines = [
            f"input   : {Path(self.input_path).name}  "
            f"({d.n_vertices} verts, {d.n_faces} faces, verdict={d.verdict})",
            f"topology: watertight={d.is_watertight} winding={d.is_winding_consistent} "
            f"components={d.n_components}",
            f"defects : boundary_edges={d.n_boundary_edges} nonmanifold_edges={d.n_nonmanifold_edges} "
            f"nonmanifold_verts={d.n_nonmanifold_vertices}",
            f"          self_intersecting_faces={d.n_selfintersecting_faces} "
            f"degenerate_faces={d.n_degenerate_faces} shell_score={d.shell_score:.2f}",
        ]

        if self.dry_run:
            lines.append("mode    : --dry-run (diagnosis only, no repair attempted)")

        if not self.dry_run and self.backend_attempts:
            lines.append("attempts:")
            for attempt in self.backend_attempts[: MAX_SUMMARY_LINES - 10]:
                lines.append(
                    f"  - {attempt.get('name')}: passed={attempt.get('passed')} "
                    f"{attempt.get('wall_time_s', 0):.1f}s {attempt.get('params', {})}"
                )
        if self.backend_selected:
            lines.append(f"backend : {self.backend_selected}")
        if self.output_diagnosis is not None:
            o = self.output_diagnosis
            lines.append(
                f"output  : {o.n_vertices} verts, {o.n_faces} faces, volume={o.volume:.4g}"
                if o.volume is not None
                else f"output  : {o.n_vertices} verts, {o.n_faces} faces"
            )
        if self.metrics:
            lines.append(
                "fidelity: hausdorff two_sided="
                f"{self.metrics.get('hausdorff_two_sided', float('nan')):.4g} "
                f"(in->out={self.metrics.get('hausdorff_in_to_out', float('nan')):.4g}, "
                f"out->in={self.metrics.get('hausdorff_out_to_in', float('nan')):.4g})"
            )
        for warning in self.warnings:
            lines.append(f"WARNING : {warning}")

        # A soft criterion that failed must be visible even though it does not
        # block acceptance, otherwise ACCEPTED would quietly mean "mostly".
        if self.validation and not self.validation.strict:
            for name in self.validation.soft_failures:
                criterion = self.validation.criteria[name.split("_", 1)[0]]
                lines.append(
                    f"SOFT FAIL: {name} = {criterion.value:.4g} exceeds "
                    f"{criterion.threshold:.4g} (not blocking; use --strict to enforce)"
                    if isinstance(criterion.value, (int, float))
                    else f"SOFT FAIL: {name} (not blocking; use --strict to enforce)"
                )

        # The verdict line is mandatory and must survive truncation.
        verdict = (
            "ACCEPTED"
            if self.accepted
            else f"REJECTED: {', '.join(self.validation.violations) if self.validation else 'unknown'}"
        )
        lines = lines[: MAX_SUMMARY_LINES - 1]
        lines.append(verdict)
        return "\n".join(lines)
