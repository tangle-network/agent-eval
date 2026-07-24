"""DSPy metrics backed by Agent Eval rubrics.

DSPy owns program compilation and optimization. Agent Eval supplies the
measurement function so DSPy programs can use the same rubric as TypeScript
agents without copying optimizer algorithms into this package.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import OrderedDict
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Future
from dataclasses import asdict, is_dataclass
from threading import Lock
from typing import Any

from .client import Client
from .models import JudgeResult, Rubric

DspyContentBuilder = Callable[[Any], str]
DspyContextBuilder = Callable[
    [Any, Any, Any | None, str | None, Any | None],
    dict[str, Any] | None,
]


class DspyJudgeMetric:
    """Use one Agent Eval rubric as a native DSPy metric.

    Call the object itself for DSPy optimizers that expect a numeric score.
    Pass ``metric.feedback`` to ``dspy.GEPA`` so GEPA also receives the
    dimension scores, failure modes, wins, and rationale.
    """

    def __init__(
        self,
        *,
        rubric_name: str | None = None,
        rubric: Rubric | dict[str, Any] | None = None,
        client: Client | None = None,
        model: str | None = None,
        content_builder: DspyContentBuilder | None = None,
        context_builder: DspyContextBuilder | None = None,
        max_content_chars: int = 100_000,
        max_context_chars: int = 200_000,
        max_feedback_chars: int = 100_000,
        cache_size: int = 1_024,
    ) -> None:
        if (rubric_name is None) == (rubric is None):
            raise ValueError("Provide exactly one of `rubric_name` or `rubric`.")
        if rubric_name is not None and (
            not rubric_name.strip() or rubric_name.strip() != rubric_name
        ):
            raise ValueError("`rubric_name` must be trimmed and non-empty.")
        if model is not None and (not model.strip() or model.strip() != model):
            raise ValueError("`model` must be trimmed and non-empty.")
        for label, value in (
            ("max_content_chars", max_content_chars),
            ("max_context_chars", max_context_chars),
            ("max_feedback_chars", max_feedback_chars),
            ("cache_size", cache_size),
        ):
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                raise ValueError(f"`{label}` must be a positive integer.")

        self._rubric_name = rubric_name
        self._rubric = Rubric.model_validate(rubric) if isinstance(rubric, dict) else rubric
        self._client = client or Client()
        self._model = model
        self._content_builder = content_builder or _default_content
        self._context_builder = context_builder or _default_context
        self._max_content_chars = max_content_chars
        self._max_context_chars = max_context_chars
        self._max_feedback_chars = max_feedback_chars
        self._cache_size = cache_size
        self._cache: OrderedDict[str, JudgeResult] = OrderedDict()
        self._inflight: dict[str, Future[JudgeResult]] = {}
        self._cache_lock = Lock()

    def __call__(
        self,
        gold: Any,
        prediction: Any,
        trace: Any | None = None,
    ) -> float:
        """Return a 0..1 score for standard DSPy optimizers and evaluation."""
        return self._judge(gold, prediction, trace, None, None).composite

    def feedback(
        self,
        gold: Any,
        prediction: Any,
        trace: Any | None = None,
        pred_name: str | None = None,
        pred_trace: Any | None = None,
    ) -> Any:
        """Return ``dspy.Prediction(score=..., feedback=...)`` for DSPy GEPA."""
        dspy = _require_dspy()
        result = self._judge(gold, prediction, trace, pred_name, pred_trace)
        feedback = json.dumps(
            {
                "dimensions": result.dimensions,
                "failureModes": result.failure_modes,
                "wins": result.wins,
                "rationale": result.rationale,
            },
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        )
        if len(feedback) > self._max_feedback_chars:
            raise ValueError(
                "Agent Eval feedback exceeds "
                f"`max_feedback_chars` ({len(feedback)} > {self._max_feedback_chars})."
            )
        return dspy.Prediction(score=result.composite, feedback=feedback)

    def clear_cache(self) -> None:
        """Discard cached rubric results."""
        with self._cache_lock:
            self._cache.clear()

    def _judge(
        self,
        gold: Any,
        prediction: Any,
        trace: Any | None,
        pred_name: str | None,
        pred_trace: Any | None,
    ) -> JudgeResult:
        content = self._content_builder(prediction)
        if not isinstance(content, str) or not content:
            raise ValueError("`content_builder` must return a non-empty string.")
        if len(content) > self._max_content_chars:
            raise ValueError(
                "DSPy prediction exceeds "
                f"`max_content_chars` ({len(content)} > {self._max_content_chars})."
            )

        context = self._context_builder(gold, prediction, trace, pred_name, pred_trace)
        normalized_context, context_json = _normalize_context(context)
        if len(context_json) > self._max_context_chars:
            raise ValueError(
                "DSPy metric context exceeds "
                f"`max_context_chars` ({len(context_json)} > {self._max_context_chars})."
            )

        cache_key = hashlib.sha256(
            json.dumps(
                {
                    "content": content,
                    "context": normalized_context,
                    "model": self._model,
                    "rubric": (
                        self._rubric.model_dump(by_alias=True)
                        if self._rubric is not None
                        else self._rubric_name
                    ),
                },
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
                allow_nan=False,
            ).encode("utf-8")
        ).hexdigest()

        with self._cache_lock:
            cached = self._cache.get(cache_key)
            if cached is not None:
                self._cache.move_to_end(cache_key)
                return cached
            inflight = self._inflight.get(cache_key)
            if inflight is None:
                inflight = Future()
                self._inflight[cache_key] = inflight
                owns_call = True
            else:
                owns_call = False

        if not owns_call:
            return inflight.result()

        try:
            result = self._client.judge(
                content=content,
                rubric_name=self._rubric_name,
                rubric=self._rubric,
                context=normalized_context,
                model=self._model,
            )
        except BaseException as error:
            with self._cache_lock:
                self._inflight.pop(cache_key, None)
            inflight.set_exception(error)
            raise
        with self._cache_lock:
            self._cache[cache_key] = result
            self._cache.move_to_end(cache_key)
            while len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)
            self._inflight.pop(cache_key, None)
        inflight.set_result(result)
        return result


def _default_content(prediction: Any) -> str:
    if isinstance(prediction, str):
        return prediction
    return json.dumps(
        _json_value(prediction),
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    )


def _default_context(
    gold: Any,
    _prediction: Any,
    _trace: Any | None,
    pred_name: str | None,
    _pred_trace: Any | None,
) -> dict[str, Any]:
    context = {"gold": _json_value(gold)}
    if pred_name is not None:
        context["targetPredictor"] = pred_name
    return context


def _normalize_context(
    context: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, str]:
    if context is None:
        return None, "null"
    if not isinstance(context, dict):
        raise ValueError("`context_builder` must return a dict or None.")
    encoded = json.dumps(
        _json_value(context),
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    )
    normalized = json.loads(encoded)
    if not isinstance(normalized, dict):
        raise ValueError("`context_builder` must return a JSON object or None.")
    return normalized, encoded


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("DSPy metric values must not contain NaN or infinity.")
        return value
    if hasattr(value, "model_dump") and callable(value.model_dump):
        return _json_value(value.model_dump(by_alias=True))
    if hasattr(value, "toDict") and callable(value.toDict):
        return _json_value(value.toDict())
    if is_dataclass(value) and not isinstance(value, type):
        return _json_value(asdict(value))
    if isinstance(value, Mapping):
        normalized: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("DSPy metric objects must use string keys.")
            normalized[key] = _json_value(item)
        return normalized
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_json_value(item) for item in value]
    raise ValueError(
        f"DSPy metric cannot serialize {type(value).__name__}; "
        "provide `content_builder` or `context_builder`."
    )


def _require_dspy() -> Any:
    try:
        import dspy
    except ImportError as error:
        raise ImportError(
            "DSPy is required for rich GEPA feedback. Install `agent-eval-rpc[dspy]`."
        ) from error
    return dspy
