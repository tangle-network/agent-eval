/**
 * The smallest complete evaluation: one surface, one judge, two scores.
 *
 * Run with: pnpm tsx examples/evaluate-a-change/index.ts
 *
 * Everything here is offline. Replace `agent` with your product call and
 * `judge` with your real scoring function to point this at production.
 */

import { defineAgentEval } from '../../src/contract'

interface SupportCase {
  id: string
  kind: 'support'
}

const evalKit = defineAgentEval<SupportCase, string>({
  scenarios: [
    { id: 'refund', kind: 'support' },
    { id: 'shipping', kind: 'support' },
    { id: 'cancel', kind: 'support' },
  ],
  agent: async (prompt, scenario) =>
    String(prompt).includes('ticket') ? `Ticket ${scenario.id}: on it.` : 'On it.',
  judge: {
    name: 'ticket-id',
    dimensions: [{ key: 'present', description: 'The answer includes the ticket id' }],
    score: ({ artifact, scenario }) => {
      const present = artifact.includes(scenario.id) ? 1 : 0
      return { dimensions: { present }, composite: present, notes: '' }
    },
  },
  baselineSurface: 'Answer politely.',
  // This agent makes no paid calls, so no usage receipt can exist.
  expectUsage: 'off',
})

const baseline = await evalKit.evaluate()
const candidate = await evalKit.evaluate({
  surface: 'Answer politely and cite the ticket id.',
})

console.log('baseline: ', baseline.aggregates.byJudge)
console.log('candidate:', candidate.aggregates.byJudge)
