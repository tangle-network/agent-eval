/**
 * Built-in rubrics shipped with agent-eval.
 *
 * A rubric is a set of scoring axes plus a system prompt that tells the
 * judging LLM how to grade against those axes. Built-in rubrics are
 * curated for use cases that recur across Tangle projects — call them
 * by name from any client.
 *
 * Adding a rubric:
 *   1. Define the Rubric object below with a clear `description` and
 *      named `dimensions`.
 *   2. Register it in `BUILTIN_RUBRICS` at the bottom.
 *   3. Add a test in `tests/wire/rubrics.test.ts`.
 *
 * Custom rubrics: callers pass `rubric` inline to /v1/judge instead of
 * `rubricName` — see schemas.ts.
 */
import type { Rubric } from './schemas'
import { hashRubric } from './schemas'

// ── anti-slop ───────────────────────────────────────────────────────
// Voice/style judge tuned for technical-buyer audiences. Used by the
// Postiz autoresearch loop and any content-quality gate.

const ANTI_SLOP: Rubric = {
  name: 'anti-slop',
  description:
    'Voice and signal quality for content aimed at senior engineers. Catches AI cadence, marketing tone, and engagement-bait shapes.',
  systemPrompt: `You are evaluating a piece of content written for senior engineers and technical founders.

You score three things:
- buyer_quality (0..1): would a senior engineer in the target ICP find this worth their attention? High = specific, earned, technically interesting. Low = generic, hyped, off-target.
- voice (0..1): does it read like a person who built the thing, or like AI/marketing copy?
- signal (0..1): does it contain a non-obvious detail, constraint, or claim a reader couldn't get from the public docs?

Detect failure modes (return ids matching):
- ai-cadence: rule-of-three openings, em-dash flourish, "Let me explain", "Here's the thing", AI rhythm
- marketing-tone: "We're excited to announce", "thrilled", "delighted", "game-changer", buzzword stack
- vague-claim: technical claim without a specific component, file, or measurement
- no-hook: opening doesn't earn attention from the target reader
- engagement-bait: "agree?", "thoughts?", listicles, controversy-fishing, hook-detail-pitch
- off-icp: content shape would attract motivational/grift/hype audiences instead of buyers
- stale-claim: repeats a positioning line we've used many times this month

Detect wins (return ids matching):
- specific-component: names a real file, component, or measurement
- earned-detail: shares a non-obvious detail not derivable from public docs
- constraint-articulated: names a real tradeoff and the side chosen
- honest-failure: describes a real failure mode and what was done about it

Return ONLY JSON matching the response schema. Be conservative — most content has 0-1 wins and 1-2 failure modes, not many of each.`,
  dimensions: [
    {
      id: 'buyer_quality',
      description: 'Would the target buyer find this worth attention?',
      weight: 0.5,
      min: 0,
      max: 1,
    },
    {
      id: 'voice',
      description: 'Does it sound like a builder, not AI or marketing?',
      weight: 0.3,
      min: 0,
      max: 1,
    },
    {
      id: 'signal',
      description: 'Non-obvious detail, constraint, or claim?',
      weight: 0.2,
      min: 0,
      max: 1,
    },
  ],
  failureModes: [
    { id: 'ai-cadence', description: 'AI-rhythm openings and transitions' },
    { id: 'marketing-tone', description: 'Buzzwords, hype, corporate-PR voice' },
    { id: 'vague-claim', description: 'Technical claim without specifics' },
    { id: 'no-hook', description: 'Opening fails to earn attention' },
    { id: 'engagement-bait', description: 'Listicle/controversy/agree-pattern' },
    { id: 'off-icp', description: 'Voice attracts the wrong audience' },
    { id: 'stale-claim', description: 'Reuses an over-used positioning line' },
  ],
  wins: [
    { id: 'specific-component', description: 'Names a real file/component/number' },
    { id: 'earned-detail', description: 'Detail not in public docs' },
    { id: 'constraint-articulated', description: 'Names a real tradeoff' },
    { id: 'honest-failure', description: 'Describes a real failure honestly' },
  ],
}

// ── Registry ────────────────────────────────────────────────────────

export const BUILTIN_RUBRICS: Record<string, Rubric> = {
  'anti-slop': ANTI_SLOP,
}

/** Get a built-in rubric by name, or undefined. */
export function getBuiltinRubric(name: string): Rubric | undefined {
  return BUILTIN_RUBRICS[name]
}

/** List built-in rubrics with their stable versions. */
export function listBuiltinRubrics() {
  return Object.values(BUILTIN_RUBRICS).map((r) => ({
    name: r.name,
    description: r.description,
    dimensions: r.dimensions.map((d) => ({
      id: d.id,
      description: d.description,
      weight: d.weight,
    })),
    failureModes: r.failureModes.map((f) => f.id),
    rubricVersion: hashRubric(r),
  }))
}
