from __future__ import annotations

import json
import os
import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from agent_eval_rpc import DspyJudgeMetric, JudgeResult

dspy = pytest.importorskip("dspy")
DummyLM = pytest.importorskip("dspy.utils").DummyLM
dotdict = pytest.importorskip("dspy.utils.dummies").dotdict

_DSPY_CACHE_ENV = ("DSPY_CACHEDIR", "DSPY_CACHE_LIMIT")
_UNSAFE_CACHE_MESSAGE = r"dspy\.configure_cache\(restrict_pickle=True\)"


def _close_disk_cache(cache: Any) -> None:
    close = getattr(getattr(cache, "disk_cache", None), "close", None)
    if callable(close):
        close()


@contextmanager
def _configured_dspy_cache(cache_dir: Path, **options: Any) -> Iterator[None]:
    original_cache = dspy.cache
    original_env = {name: os.environ.get(name) for name in _DSPY_CACHE_ENV}
    dspy.configure_cache(
        enable_memory_cache=False,
        disk_cache_dir=str(cache_dir),
        **options,
    )
    configured_cache = dspy.cache
    try:
        yield
    finally:
        dspy.cache = original_cache
        _close_disk_cache(configured_cache)
        for name, value in original_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


@pytest.fixture(autouse=True)
def _use_safe_dspy_cache(tmp_path: Path) -> Iterator[None]:
    with _configured_dspy_cache(
        tmp_path / "disabled-default",
        enable_disk_cache=False,
    ):
        yield


class _JudgeClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def judge(self, **kwargs: Any) -> JudgeResult:
        self.calls.append(kwargs)
        return JudgeResult(
            composite=0.75,
            dimensions={"correctness": 0.5, "format": 1.0},
            failureModes=["missing-citation"],
            wins=["valid-json"],
            rationale="The answer is valid JSON but does not cite its source.",
            rubricVersion="sha256:rubric",
            model="judge-model",
            durationMs=12,
        )


class _BlockingJudgeClient(_JudgeClient):
    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()

    def judge(self, **kwargs: Any) -> JudgeResult:
        self.started.set()
        assert self.release.wait(timeout=5)
        return super().judge(**kwargs)


class _InstructionAwareLM(DummyLM):
    def __init__(self) -> None:
        super().__init__([{"answer": "BAD"}])

    def forward(
        self,
        prompt: str | None = None,
        messages: list[dict[str, Any]] | None = None,
        **_kwargs: Any,
    ) -> Any:
        messages = messages or [{"role": "user", "content": prompt or ""}]
        answer = "READY" if "Return READY" in json.dumps(messages) else "BAD"
        content = self._format_answer_fields({"answer": answer})
        return dotdict(
            choices=[
                dotdict(
                    message=dotdict(content=content, tool_calls=None),
                    finish_reason="stop",
                )
            ],
            usage=dotdict(prompt_tokens=0, completion_tokens=0, total_tokens=0),
            model="dummy",
        )


class _OutcomeJudgeClient:
    def __init__(self) -> None:
        self.calls = 0

    def judge(self, **kwargs: Any) -> JudgeResult:
        self.calls += 1
        succeeds = "READY" in kwargs["content"]
        score = 1.0 if succeeds else 0.0
        return JudgeResult(
            composite=score,
            dimensions={"correctness": score},
            failureModes=[] if succeeds else ["incorrect-answer"],
            wins=["correct-answer"] if succeeds else [],
            rationale="The answer is correct." if succeeds else "The answer is incorrect.",
            rubricVersion="sha256:test",
            model="judge-model",
            durationMs=1,
        )


def _write_marker(path: str) -> None:
    Path(path).write_text("unsafe pickle executed", encoding="utf-8")


class _PicklePayload:
    def __init__(self, marker: Path) -> None:
        self.marker = marker

    def __reduce__(self) -> tuple[Any, tuple[str]]:
        return _write_marker, (str(self.marker),)


def test_unsafe_default_disk_cache_is_rejected(tmp_path: Path) -> None:
    with _configured_dspy_cache(tmp_path / "unsafe-default", enable_disk_cache=True):
        with pytest.raises(RuntimeError, match=_UNSAFE_CACHE_MESSAGE) as error:
            DspyJudgeMetric(rubric_name="answer-quality", client=_JudgeClient())

    assert "dspy.configure_cache(enable_disk_cache=False)" in str(error.value)


def test_official_restricted_disk_cache_is_accepted(tmp_path: Path) -> None:
    client = _JudgeClient()
    with _configured_dspy_cache(
        tmp_path / "restricted",
        enable_disk_cache=True,
        restrict_pickle=True,
    ):
        metric = DspyJudgeMetric(rubric_name="answer-quality", client=client)
        score = metric(dspy.Example(answer="Denver"), dspy.Prediction(answer="Denver"))

    assert score == 0.75
    assert len(client.calls) == 1


def test_disabled_disk_cache_is_accepted(tmp_path: Path) -> None:
    with _configured_dspy_cache(tmp_path / "disabled", enable_disk_cache=False):
        metric = DspyJudgeMetric(rubric_name="answer-quality", client=_JudgeClient())

    assert isinstance(metric, DspyJudgeMetric)


def test_metric_rechecks_global_cache_before_use(tmp_path: Path) -> None:
    client = _JudgeClient()
    metric = DspyJudgeMetric(rubric_name="answer-quality", client=client)

    with _configured_dspy_cache(tmp_path / "unsafe-after-construction", enable_disk_cache=True):
        with pytest.raises(RuntimeError, match=_UNSAFE_CACHE_MESSAGE):
            metric(dspy.Example(answer="Denver"), dspy.Prediction(answer="Denver"))

    assert client.calls == []


def test_restricted_upstream_cache_rejects_an_executable_pickle(tmp_path: Path) -> None:
    marker = tmp_path / "pickle-executed"
    request = {"model": "test", "prompt": "adversarial cache entry"}

    with _configured_dspy_cache(
        tmp_path / "restricted-adversarial",
        enable_disk_cache=True,
        restrict_pickle=True,
    ):
        key = dspy.cache.cache_key(request)
        dspy.cache.put(request, _PicklePayload(marker), enable_memory_cache=False)

        assert key in dspy.cache.disk_cache
        assert dspy.cache.get(request) is None
        assert key not in dspy.cache.disk_cache
    assert not marker.exists()


def test_cache_scenario_restores_global_cache_and_environment(tmp_path: Path) -> None:
    original_cache = dspy.cache
    original_env = {name: os.environ.get(name) for name in _DSPY_CACHE_ENV}

    with _configured_dspy_cache(tmp_path / "isolated", enable_disk_cache=False):
        assert dspy.cache is not original_cache
        os.environ["DSPY_CACHEDIR"] = str(tmp_path / "changed")
        os.environ["DSPY_CACHE_LIMIT"] = "1"

    assert dspy.cache is original_cache
    assert {name: os.environ.get(name) for name in _DSPY_CACHE_ENV} == original_env


def test_numeric_metric_works_with_dspy_examples_and_predictions() -> None:
    client = _JudgeClient()
    metric = DspyJudgeMetric(rubric_name="answer-quality", client=client)
    gold = dspy.Example(question="Where?", answer="Denver").with_inputs("question")
    prediction = dspy.Prediction(answer="Denver")

    assert metric(gold, prediction) == 0.75
    assert client.calls == [
        {
            "content": '{"answer":"Denver"}',
            "rubric_name": "answer-quality",
            "rubric": None,
            "context": {"gold": {"answer": "Denver", "question": "Where?"}},
            "model": None,
        }
    ]


def test_gepa_feedback_has_official_prediction_shape_and_reuses_judgment() -> None:
    client = _JudgeClient()
    metric = DspyJudgeMetric(rubric_name="answer-quality", client=client)
    gold = dspy.Example(question="Where?", answer="Denver").with_inputs("question")
    prediction = dspy.Prediction(answer="Denver")

    score = metric(gold, prediction)
    feedback = metric.feedback(gold, prediction)

    assert score == 0.75
    assert isinstance(feedback, dspy.Prediction)
    assert feedback.score == 0.75
    assert json.loads(feedback.feedback) == {
        "dimensions": {"correctness": 0.5, "format": 1.0},
        "failureModes": ["missing-citation"],
        "rationale": "The answer is valid JSON but does not cite its source.",
        "wins": ["valid-json"],
    }
    assert len(client.calls) == 1


def test_predictor_specific_context_is_cached_separately() -> None:
    client = _JudgeClient()
    metric = DspyJudgeMetric(rubric_name="answer-quality", client=client)
    gold = dspy.Example(question="Where?", answer="Denver").with_inputs("question")
    prediction = dspy.Prediction(answer="Denver")

    first = metric.feedback(gold, prediction, pred_name="first")
    second = metric.feedback(gold, prediction, pred_name="second")

    assert first.score == second.score == 0.75
    assert [call["context"]["targetPredictor"] for call in client.calls] == [
        "first",
        "second",
    ]


def test_concurrent_identical_calls_share_one_judgment() -> None:
    client = _BlockingJudgeClient()
    metric = DspyJudgeMetric(rubric_name="answer-quality", client=client)
    gold = dspy.Example(question="Where?", answer="Denver").with_inputs("question")
    prediction = dspy.Prediction(answer="Denver")

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(metric, gold, prediction)
        assert client.started.wait(timeout=5)
        second = pool.submit(metric, gold, prediction)
        client.release.set()
        assert first.result(timeout=5) == second.result(timeout=5) == 0.75

    assert len(client.calls) == 1


def test_custom_builders_can_supply_bounded_trace_context() -> None:
    client = _JudgeClient()
    metric = DspyJudgeMetric(
        rubric_name="answer-quality",
        client=client,
        content_builder=lambda prediction: prediction.answer,
        context_builder=lambda gold, _prediction, trace, pred_name, pred_trace: {
            "expected": gold.answer,
            "trace": trace,
            "target": pred_name,
            "targetTrace": pred_trace,
        },
    )

    result = metric.feedback(
        dspy.Example(answer="Denver"),
        dspy.Prediction(answer="Denver"),
        trace=["whole-program"],
        pred_name="respond",
        pred_trace=["respond-step"],
    )

    assert result.score == 0.75
    assert client.calls[0]["content"] == "Denver"
    assert client.calls[0]["context"] == {
        "expected": "Denver",
        "trace": ["whole-program"],
        "target": "respond",
        "targetTrace": ["respond-step"],
    }


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({}, "exactly one"),
        ({"rubric_name": "a", "rubric": {"name": "b"}}, "exactly one"),
        ({"rubric_name": " a "}, "trimmed"),
        ({"rubric_name": "a", "cache_size": 0}, "positive integer"),
    ],
)
def test_invalid_configuration_fails_before_any_judge_call(
    kwargs: dict[str, Any],
    message: str,
) -> None:
    with pytest.raises((ValueError, TypeError), match=message):
        DspyJudgeMetric(client=_JudgeClient(), **kwargs)


def test_oversized_inputs_and_unserializable_values_fail_closed() -> None:
    client = _JudgeClient()
    metric = DspyJudgeMetric(
        rubric_name="answer-quality",
        client=client,
        max_content_chars=4,
    )
    with pytest.raises(ValueError, match="max_content_chars"):
        metric(dspy.Example(answer="x"), dspy.Prediction(answer="Denver"))

    metric = DspyJudgeMetric(rubric_name="answer-quality", client=client)
    with pytest.raises(ValueError, match="cannot serialize"):
        metric(dspy.Example(answer=object()), dspy.Prediction(answer="x"))
    assert client.calls == []


def test_metric_drives_an_official_dspy_gepa_compile() -> None:
    class Answer(dspy.Signature):
        """Return BAD."""

        question: str = dspy.InputField()
        answer: str = dspy.OutputField()

    class Program(dspy.Module):
        def __init__(self) -> None:
            super().__init__()
            self.respond = dspy.Predict(Answer)

        def forward(self, question: str) -> Any:
            return self.respond(question=question)

    proposal_calls = 0

    def propose(
        candidate: dict[str, str],
        reflective_dataset: dict[str, list[dict[str, Any]]],
        components_to_update: list[str],
    ) -> dict[str, str]:
        nonlocal proposal_calls
        assert candidate
        assert reflective_dataset
        proposal_calls += 1
        return {name: "Return READY" for name in components_to_update}

    judge = _OutcomeJudgeClient()
    metric = DspyJudgeMetric(rubric_name="answer-quality", client=judge)
    optimizer = dspy.GEPA(
        metric.feedback,
        max_metric_calls=6,
        reflection_minibatch_size=1,
        instruction_proposer=propose,
        use_merge=False,
        num_threads=1,
        track_stats=True,
        seed=0,
    )
    train = [dspy.Example(question="Say ready.", answer="READY").with_inputs("question")]
    selection = [dspy.Example(question="Also say ready.", answer="READY").with_inputs("question")]

    with dspy.context(lm=_InstructionAwareLM()):
        optimized = optimizer.compile(Program(), trainset=train, valset=selection)
        assert optimized(question="Fresh input.").answer == "READY"

    assert optimized.respond.signature.instructions == "Return READY"
    assert proposal_calls == 1
    assert judge.calls == 5


def test_documented_gepa_constructor_supplies_a_reflection_model() -> None:
    metric = DspyJudgeMetric(rubric_name="answer-quality", client=_JudgeClient())

    optimizer = dspy.GEPA(
        metric=metric.feedback,
        reflection_lm=_InstructionAwareLM(),
        max_metric_calls=1,
    )

    assert optimizer.reflection_lm is not None
