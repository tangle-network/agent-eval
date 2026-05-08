"""Data models that mirror the wire-protocol Zod schemas.

These pydantic models are kept in sync by hand for now — the surface is
small (six classes). When the wire surface grows past ~10 endpoints,
swap this file for `datamodel-code-generator -i openapi.json -o models.py`.

Every field name and type matches `src/wire/schemas.ts` exactly. If you
change one without changing the other, the dual-publish CI will fail.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


class _StrictModel(BaseModel):
    """Reject unknown fields — drift between TS and Python should fail loudly."""

    model_config = ConfigDict(extra="forbid")


class RubricDimension(_StrictModel):
    """A scoring axis within a rubric.

    Composite scores combine each dimension by `weight`. The `min`/`max`
    bounds are used to normalize raw scores into 0..1 before weighting.
    """

    id: str = Field(..., description="Stable id like 'buyer_quality'.")
    description: str = Field(..., description="One-line plain-English meaning.")
    weight: float = Field(1.0, ge=0, description="Relative weight in composite. 0 disables.")
    min: float = 0.0
    max: float = 1.0


class FailureMode(_StrictModel):
    """A negative pattern the judge looks for. Detected ones appear in result.failure_modes."""

    id: str
    description: str


class Rubric(_StrictModel):
    """A complete rubric — what's being scored and how.

    Pass this inline to `Client.judge(rubric=...)` or register a built-in
    rubric server-side and use `Client.judge(rubric_name=...)`.
    """

    name: str
    description: str
    system_prompt: str = Field(..., alias="systemPrompt")
    dimensions: list[RubricDimension]
    failure_modes: list[FailureMode] = Field(default_factory=list, alias="failureModes")
    wins: list[FailureMode] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class JudgeRequest(_StrictModel):
    """Input to /v1/judge. Provide either rubric_name or rubric (not both)."""

    rubric_name: str | None = Field(None, alias="rubricName")
    rubric: Rubric | None = None
    content: str = Field(..., min_length=1, description="The text being judged.")
    context: dict[str, Any] | None = Field(
        None,
        description="Free-form metadata surfaced to the judging LLM.",
    )
    model: str | None = Field(None, description="Override the judge model.")

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @model_validator(mode="after")
    def _exactly_one_rubric(self) -> JudgeRequest:
        if (self.rubric_name is None) == (self.rubric is None):
            raise ValueError("Provide exactly one of `rubric_name` or `rubric`.")
        return self


class JudgeResult(_StrictModel):
    """Output of /v1/judge. The `composite` is the 0..1 score to gate on."""

    composite: float = Field(..., ge=0, le=1)
    dimensions: dict[str, float]
    failure_modes: list[str] = Field(default_factory=list, alias="failureModes")
    wins: list[str] = Field(default_factory=list)
    rationale: str
    rubric_version: str = Field(..., alias="rubricVersion")
    model: str
    duration_ms: int = Field(..., alias="durationMs")

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class RubricInfo(_StrictModel):
    """One entry in /v1/rubrics."""

    name: str
    description: str
    dimensions: list[dict[str, Any]]
    failure_modes: list[str] = Field(default_factory=list, alias="failureModes")
    rubric_version: str = Field(..., alias="rubricVersion")

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ListRubricsResponse(_StrictModel):
    """Response from /v1/rubrics."""

    rubrics: list[RubricInfo]


class VersionResponse(_StrictModel):
    """Response from /v1/version. Match `version` to your installed pip package."""

    package: str
    version: str
    wire_version: str = Field(..., alias="wireVersion")
    api_surface: list[str] = Field(..., alias="apiSurface")

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
