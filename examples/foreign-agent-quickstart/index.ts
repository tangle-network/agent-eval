/**
 * Adapt an existing agent's input and output to one evaluation.
 * Run after building: pnpm exec tsx examples/foreign-agent-quickstart/index.ts
 */

import { defineAgentEval, type Scenario } from '@tangle-network/agent-eval/contract'

interface SupportCase extends Scenario {
  question: string
  expectedAnswer: string
  policyUrl: string
}

interface SupportAnswer {
  text: string
}

const scenarios: SupportCase[] = [
  {
    id: 'refund',
    kind: 'support',
    question: 'How long do I have to request a refund?',
    expectedAnswer: '30 days',
    policyUrl: 'https://support.example/refunds',
  },
  {
    id: 'cancel',
    kind: 'support',
    question: 'When does cancellation take effect?',
    expectedAnswer: 'end of the billing period',
    policyUrl: 'https://support.example/cancellation',
  },
]

// This local fixture stands in for your existing SDK or service.
// Its interface has no dependency on Agent Eval or the answer-key fields.
async function existingAgent(input: {
  instructions: string
  question: string
  signal: AbortSignal
}): Promise<{ message: string }> {
  input.signal.throwIfAborted()
  const refund = input.question.toLowerCase().includes('refund')
  const answer = refund
    ? 'Request a refund within 30 days.'
    : 'Cancellation takes effect at the end of the billing period.'
  const url = refund ? 'https://support.example/refunds' : 'https://support.example/cancellation'
  return {
    message: input.instructions.includes('cite') ? `${answer} Policy: ${url}` : answer,
  }
}

const evalKit = defineAgentEval<SupportCase, SupportAnswer>({
  scenarios,
  baselineSurface: 'Answer the support question.',
  agent: async (surface, scenario, ctx) => {
    const result = await existingAgent({
      instructions: String(surface),
      question: scenario.question,
      signal: ctx.signal,
    })
    return { text: result.message }
  },
  judge: {
    name: 'support-answer',
    dimensions: [
      { key: 'correct', description: 'The answer contains the expected policy fact' },
      { key: 'cited', description: 'The answer links to the relevant policy' },
    ],
    score: ({ artifact, scenario }) => {
      const correct = artifact.text.includes(scenario.expectedAnswer) ? 1 : 0
      const cited = artifact.text.includes(scenario.policyUrl) ? 1 : 0
      return { dimensions: { correct, cited }, composite: (correct + cited) / 2, notes: '' }
    },
  },
  // The local fixture makes no paid calls. Meter real calls and set 'assert'.
  expectUsage: 'off',
})

const baseline = await evalKit.evaluate()
const candidate = await evalKit.evaluate({
  surface: 'Answer the support question and cite the relevant policy.',
})

console.log('baseline:', baseline.aggregates.byJudge['support-answer']?.mean)
console.log('candidate:', candidate.aggregates.byJudge['support-answer']?.mean)
