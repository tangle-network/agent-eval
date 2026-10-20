from __future__ import annotations

import pytest

from agent_eval_rpc import dspy_rlm_bridge

CODETRACE_INSTRUCTIONS = (
    "Analyze exactly one coding-agent trajectory.\n"
    "Set the finding's subject to incorrect-steps-<first_step>-<last_step>"
    "-<escape_status>-consequence-<consequence_step>.\n"
    "Cite the block's first step and its last step."
)
VALID_BLOCK = {
    "first_step": 2,
    "last_step": 3,
    "consequence_step": 4,
    "escape_status": "unescaped",
    "severity": "high",
    "claim": "Steps 2-3 corrupt the configuration the loader depends on.",
    "confidence": 0.9,
    "rationale": "Step 4's test run fails on the missing configuration.",
}


def test_codetrace_contract_detection_matches_only_the_subject_grammar_token() -> None:
    assert dspy_rlm_bridge._uses_codetrace_contract(CODETRACE_INSTRUCTIONS) is True
    assert (
        dspy_rlm_bridge._uses_codetrace_contract(
            "Find the first unrecoverable critical failure and cite step-<n>."
        )
        is False
    )


def test_incorrect_block_model_enforces_cross_field_rules() -> None:
    with pytest.raises(Exception, match="precedes first_step"):
        dspy_rlm_bridge.IncorrectBlock.model_validate({**VALID_BLOCK, "last_step": 1})
    with pytest.raises(Exception, match="consequence_step 1 precedes"):
        dspy_rlm_bridge.IncorrectBlock.model_validate({**VALID_BLOCK, "consequence_step": 1})
    with pytest.raises(Exception, match="spans 13 steps"):
        dspy_rlm_bridge.IncorrectBlock.model_validate(
            {**VALID_BLOCK, "first_step": 1, "last_step": 13, "consequence_step": 13}
        )
