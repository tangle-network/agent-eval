import { MAX_ASSISTANT_STEP_EVIDENCE_EXCERPT_CHARACTERS } from './benchmark-evidence-validation'
import type { PublicAnalystBenchmarkDataset } from './benchmark-public-types'
import { sha256Digest } from './benchmark-verification-artifacts'

/** Widest contiguous failure block a model may report. The published corpus's
 * widest labeled block is 8 steps and its widest stage span is 9, so this bound
 * never binds honest enumeration; it caps how far one over-wide block can push
 * unlabeled steps into the precision denominator. */
export const MAX_INCORRECT_BLOCK_STEPS = 12

/** Most blocks a model may report for one trajectory. The published corpus's
 * densest case carries 4 disjoint labeled blocks. Together with the per-block
 * cap this bounds one case at 192 predicted steps without a second ceiling. */
export const MAX_INCORRECT_BLOCKS = 16

export const TRACE_PROJECTION_ATTRIBUTE_BYTE_CAPS = [
  4_096, 2_048, 1_024, 512, 256, 128, 64,
] as const

export const CODE_TRACE_BENCH_ANALYST_PROMPT = `Analyze exactly one coding-agent trajectory and its attached final verification.
Your task is the CodeTraceBench incorrect-step task: identify every incorrect step, defined as a wrong state-changing intervention given the evidence — a mislocalized edit, a wrong hypothesis that drives an action, a regression, an irrelevant change, or an incorrect dependency or configuration choice.
Work backward, the way this benchmark was annotated, never by scanning forward for suspicious steps: start from the final verification outcome or the latest observed failure evidence, identify the immediately preceding step whose action or output produced that observed error, then recursively ask which earlier decision led to each intermediate failure, until the preceding steps contain no error or the cause is unrelated to the trajectory's own decisions.
Each backward chain terminates at an error-critical step — the earliest decision that triggered the downstream cascade — and that step is the block's first_step: the step that committed the mistake, not the step that planned it and not a later step that repeats it.
The chain you traced is the block: it holds the error-critical decision plus every consecutive later step that produced, propagated, or reworked that error, so a command that failed because of the mistake and a repair attempt that is itself wrong, partial, or later superseded sit inside the block, not after it.
A partially correct or ambiguous fix still counts as incorrect; the block ends only at the first fully correct step — a clean diagnostic read, or the corrective action that closes the issue and needs no further rework.
A one-step block is the most common correct answer.
Report each failure block as exactly one finding whose first_step is the block's first incorrect step and whose last_step is its last, covering every consecutive step between them.
Every step inside a block is scored on its own: naming a correct step costs exactly as much as missing an incorrect one, and naming only the first step of a longer block forfeits every unnamed step.
Report blocks separated by at least one correct step as separate findings, and never let two blocks overlap.
Every block needs an anchor: observed failure evidence its chain traces back from — a failing command or verification, an error observation, a regression — or, on a solved trajectory, a later step that reverts or supersedes it.
A slip that forced no observed failure, no revert, and no rework is not labeled in this benchmark; do not report it.
Annotation draws one chain per observed failure: expect one or two blocks per trajectory, more only when each extra block traces back from its own independent failure evidence.
A solved trajectory still carries every mistake made along the way: inspect its final patching and verification stages for a state-changing action that a later step reverted, superseded, or corrected — a wrong edit just before the final fix is incorrect even when every test ends green.
Before emitting a candidate block, run two checks.
Neighbor check: ask whether the accusation fits one step earlier (the decision rather than its consequence) or one step later (the next step still acts on or reworks the same error) better than where you placed it, and move the boundary when it does; a boundary off by one step scores zero at that step.
Counterfactual check: if the block's first step had been done correctly, would the failure or rework it allegedly caused disappear? When the damage would remain anyway, the block accuses the wrong step; drop it.
For each block you keep, name as consequence_step the step number whose action or observation shows the damage — a failing command, a wrong file state, a repeated failure, or rework the agent had to do because of this block; that step is the block's own last step when its observation already shows the damage, and a later step otherwise.
When you cannot name that step number from the trace you were given, drop the block; a plausible story about why a step looks wrong is not evidence that it was.
A passing final verification is not evidence that a block caused nothing, and a failing final verification is not evidence that any particular block caused it.
For every block, decide whether the agent escaped the failure.
Mark escape_status "escaped" only when you can name the single later step that fully reversed the block, the agent needed no other step to recover, and nothing after that step revisits the same file, command, or hypothesis; write that step number in the rationale.
Mark escape_status "unescaped" in every other case, including whenever you are unsure.
A passing final verification never makes a block escaped.
Do not label a diagnostic probe or test run merely because its output exposes an earlier defect.
Do not label a redundant but correct read or search; CodeTraceBench scores unuseful steps separately, and this run scores incorrect steps only.
Do not label a step solely because final verification failed.
When final verification is unavailable, trace backward from the latest failure evidence inside the trajectory itself.
Every step in a reported block MUST be the positive integer n from an existing assistant LLM span named step-<n>.
Never select an EVALUATOR, TOOL, CHAIN, final-verification, benchmark-verification, or message-<n> span.
Before emitting a finding, inspect every covered span's attributes.content and describe only the actions shown there.
Report at most ${MAX_INCORRECT_BLOCKS} blocks and at most ${MAX_INCORRECT_BLOCK_STEPS} steps in one block; when more candidates than that exist, report the ones whose chains carry the clearest downstream evidence.
When the trajectory has no incorrect steps, return an empty findings array.`

const AGENT_RX_PROMPT = `Analyze exactly one failed agent trajectory.
Find the first unrecoverable critical failure, not every later symptom.
Inspect the complete supplied trace data.
Emit zero findings only when the trace does not contain enough evidence.
Otherwise emit exactly one finding.
Its category MUST be exactly one of:
instruction-plan-adherence-failure
invention-of-new-information
invalid-invocation
misinterpretation-of-tool-output-handoff-failure
intent-plan-misalignment
underspecified-user-intent
intent-not-supported
guardrails-triggered
system-failure
inconclusive
Its step is the positive integer n from the first unrecoverable assistant span named step-<n>.`

const AGENT_RX_JSON_CONTRACT = `Each finding must contain only:
- "step": a positive integer matching an existing assistant LLM span named step-<n>
- "severity": "critical", "high", "medium", "low", or "info"
- "claim": one sentence
- "confidence": a number from 0 through 1
- optional "rationale" and "recommended_action" strings
- "category": one allowed failure category listed above`

const CODE_TRACE_JSON_CONTRACT = `Each finding is one contiguous failure block and must contain only:
- "first_step": a positive integer, the block's first incorrect step, matching an existing assistant LLM span named step-<n>
- "last_step": a positive integer >= first_step, the block's last incorrect step; every step from first_step through last_step must be an existing assistant LLM span, and a block spans at most ${MAX_INCORRECT_BLOCK_STEPS} steps
- "consequence_step": a positive integer >= first_step, the step whose action or following observation shows the damage this block caused; it may sit inside the block when the damage is already visible there
- "escape_status": "escaped" only when one single later step fully reversed the block and nothing afterwards revisits it, "unescaped" otherwise and whenever you are unsure
- "severity": "critical", "high", "medium", "low", or "info"
- "claim": one sentence describing the block's failure
- "confidence": a number from 0 through 1
- optional "rationale" and "recommended_action" strings`

const AGENT_RX_RLM_CONTRACT = `Use the trace tools to inspect the action and its following observation.
Emit exactly one finding whose subject is exactly one of the allowed failure categories.
Cite exactly one assistant span named step-<n> as trace://<URL-encoded-trace-id>/span/step-<n>.
The excerpt must quote the assistant action exactly.`

const CODE_TRACE_RLM_CONTRACT = `Use the trace tools rather than asking for the whole trajectory in the prompt.
Keep retrieved trace objects in Python variables.
Never print an entire trace, full source file, or more than 12000 characters in one iteration.
Read the final verification and the latest failure evidence first, then build a compact table of assistant step ids, actions, and following observations.
Trace backward from that evidence with viewSpans or searchSpan, confirming each candidate step's own action content, instead of repeatedly printing the table.
This runner emits no JSON fields, so the block is encoded in the finding's subject.
Only findings_json is scored; your prose answer is ignored, so every incorrect block you identify must appear as a finding, never only in the answer.
Emit exactly one finding per contiguous failure block.
Set the finding's subject to incorrect-steps-<first_step>-<last_step>-<escape_status>-consequence-<consequence_step>, using the same four values the task defines; for a block covering only step 7 that the agent never escaped and whose damage shows at step 9, the subject is incorrect-steps-7-7-unescaped-consequence-9.
The runner expands the block to one scored step per member and builds every scored citation itself.
Cite the block's first step and its last step as trace://<URL-encoded-trace-id>/span/step-<n>, each excerpt an exact quote from that step's own action content.
Give the rationale as the concrete downstream evidence visible at the consequence step.
Submit as soon as every candidate failure block has a supported verdict.
Return no finding for a clean trajectory.`

/** One-shot JSON transport prompt for the direct runner. */
export function publicBenchmarkSystemPrompt(dataset: PublicAnalystBenchmarkDataset): string {
  const fieldContract = dataset === 'agentrx' ? AGENT_RX_JSON_CONTRACT : CODE_TRACE_JSON_CONTRACT
  return `${publicBenchmarkTaskPrompt(dataset)}

${fieldContract}

Return exactly one JSON object with:
- "report": a concise evidence-based explanation, at most 4000 characters
- "findings": the strict finding array
Use an empty findings array when the trace does not support a finding.
Do not return a bare array, markdown, trace URIs, copied excerpts, or fields not listed above.
The runner constructs exact trace URIs and action previews from each selected step.`
}

/** Tool-loop prompt for the recursive runner. Same task, subject-encoded block. */
export function publicBenchmarkRlmInstructions(dataset: PublicAnalystBenchmarkDataset): string {
  const outputContract = dataset === 'agentrx' ? AGENT_RX_RLM_CONTRACT : CODE_TRACE_RLM_CONTRACT
  return `${publicBenchmarkTaskPrompt(dataset)}
${outputContract}`
}

function publicBenchmarkTaskPrompt(dataset: PublicAnalystBenchmarkDataset): string {
  return dataset === 'agentrx' ? AGENT_RX_PROMPT : CODE_TRACE_BENCH_ANALYST_PROMPT
}

/** Digest of every prompt a runner can send plus the shared transport limits.
 * Both runner contracts are hashed so an edit to either one changes the digest
 * a run records, whichever runner executed. */
export function publicBenchmarkProtocolSha256(dataset: PublicAnalystBenchmarkDataset): string {
  return sha256Digest(
    JSON.stringify({
      dataset,
      systemPrompt: publicBenchmarkSystemPrompt(dataset),
      rlmInstructions: publicBenchmarkRlmInstructions(dataset),
      transport: {
        attempts: 1,
        jsonMode: true,
        thinking: 'disabled',
      },
      blockLimits:
        dataset === 'agentrx'
          ? null
          : {
              maxBlocks: MAX_INCORRECT_BLOCKS,
              maxBlockSteps: MAX_INCORRECT_BLOCK_STEPS,
            },
      traceProjectionAttributeByteCaps: TRACE_PROJECTION_ATTRIBUTE_BYTE_CAPS,
      evidence: {
        location: 'model-selected-positive-integer-assistant-step',
        uri: 'deterministic-trace-uri',
        excerpt: `exact-action-prefix-${MAX_ASSISTANT_STEP_EVIDENCE_EXCERPT_CHARACTERS}`,
      },
    }),
  )
}
