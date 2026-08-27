/**
 * `decideNextUserTurn` — the reactive, adversarial turn-generation core
 * exposed standalone so any harness can drive a simulated multi-turn
 * conversation against an in-process agent.
 *
 * The driver is the "user side" of an agent eval: an LLM persona that
 * interrogates the product agent until either its `completionCriteria`
 * are met or `maxTurns` is reached. The driver signals completion with
 * the literal `DONE` token.
 *
 * This example wires it offline by injecting a scripted `TCloud` mock in
 * place of a real LLM. Swap the mock for a real client (e.g.
 * `@tangle-network/tcloud`) and the loop runs against the real driver.
 *
 * Run with:
 *   pnpm tsx examples/user-simulation-driver/index.ts
 */

import { decideNextUserTurn } from '../../src/index'
import type { DriverState, PersonaConfig } from '../../src/types'

// ── Scripted simulated-user replies — what the driver LLM would
//    produce. The fourth one signs off with DONE. ──────────────────────
const userReplies = [
  'I need to file my 2026 return — where should I start?',
  "I've got a W-2 and freelance income. Walk me through both.",
  "What about the missing Schedule B you mentioned — that's the interest income, right?",
  'DONE',
]
let scriptIndex = 0

// Minimal TCloud mock. Real wiring imports `TCloud` from
// `@tangle-network/tcloud` and constructs a real client.
const tc = {
  async chat() {
    const content = userReplies[scriptIndex++] ?? 'DONE'
    return { choices: [{ message: { content } }] }
  },
} as unknown as Parameters<typeof decideNextUserTurn>[0]

// ── The persona the simulated user inhabits ────────────────────────────
const persona: PersonaConfig = {
  id: 'self-employed-taxpayer',
  role: 'Self-employed taxpayer filing a US return',
  goal: 'File a complete 2026 return with every required schedule',
  completionCriteria: [
    {
      name: 'return-complete',
      // Real harnesses inspect side effects (proposals approved, vault
      // contents, generations). Offline we just gate on history length so
      // the driver runs end-to-end without product wiring.
      check: (state) => state.generations >= 3,
      progress: (state) => Math.min(1, state.generations / 3),
    },
  ],
  maxTurns: 5,
  rigor: 'demanding',
}

// ── DriverState — `AgentDriver` keeps this updated from product side
//    effects; in this offline demo we hold it constant. ────────────────
const state: DriverState = {
  tasks: 0,
  events: 0,
  proposals: { pending: 0, approved: 0, rejected: 0 },
  vaultFiles: [],
  codeBlocks: 0,
  generations: 0,
}

// ── Scripted "agent" replies — what the product agent under test would
//    produce. Real wiring drives the actual agent each turn. ───────────
const agentReplies = [
  "Let's begin. I'll set up your 2026 return scaffold and walk you through it.",
  'Upload your W-2 here. For freelance, I need 1099-NECs and the totals from each client.',
  'Yes — Schedule B for any interest > $1,500. Please attach your 1099-INT.',
]

async function main() {
  const history: { role: string; content: string }[] = []
  for (let turn = 0; turn < persona.maxTurns; turn++) {
    const userMsg = await decideNextUserTurn(tc, { persona, state, history })
    console.log(`[turn ${turn}] user:  ${userMsg}`)
    if (userMsg.toUpperCase().includes('DONE')) {
      console.log('\nuser signed off — completion criteria satisfied')
      break
    }
    history.push({ role: 'user', content: userMsg })

    const agentMsg = agentReplies[turn] ?? '(out of scripted agent replies)'
    console.log(`[turn ${turn}] agent: ${agentMsg}\n`)
    history.push({ role: 'assistant', content: agentMsg })
  }

  console.log(`\nfinal history: ${history.length} messages over ${history.length / 2} agent turns`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
