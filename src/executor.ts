import type { TCloud } from '@tangle-network/tcloud'
import { JudgeParseError } from './judges'
import { normalizeScores, weightedMean } from './statistics'
import type {
  CollectedArtifacts,
  JudgeFn,
  JudgeScore,
  Scenario,
  ScenarioResult,
  TurnResult,
} from './types'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ExecutorConfig {
  /** System prompt for the agent under test */
  systemPrompt: string
  /** Model to use for the agent */
  model?: string
  /** Judges to run after execution */
  judges: JudgeFn[]
  /** Regex patterns for detecting tool/API calls in responses */
  toolCallPatterns?: RegExp[]
  /** Block delimiter pattern (default: :::type\n...\n:::) */
  blockPattern?: RegExp
  /** Custom artifact checker for domain-specific checks */
  artifactChecker?: (
    check: Scenario['artifactChecks'][0],
    artifacts: CollectedArtifacts,
  ) => { passed: boolean; detail: string } | null
}

/**
 * Execute a scenario against an LLM via tcloud.
 *
 * Runs multi-turn conversation, extracts artifacts, runs judges.
 */
export async function executeScenario(
  tc: TCloud,
  scenario: Scenario,
  config: ExecutorConfig,
): Promise<ScenarioResult> {
  const startTime = Date.now()
  const model = config.model ?? 'gpt-4o'

  const systemPrompt = [config.systemPrompt, scenario.systemPromptAppend ?? '']
    .filter(Boolean)
    .join('\n\n')

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]

  const turns: TurnResult[] = []
  const allCodeBlocks: { language: string; code: string }[] = []
  const allBlocks: { type: string; fields: Record<string, string> }[] = []
  const allToolCalls: string[] = []

  const blockRe = config.blockPattern ?? /:::(\w+)\s*\n([\s\S]*?)\n\s*:::/g

  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i]!
    const turnStart = Date.now()

    messages.push({ role: 'user', content: turn.user })

    const resp = await tc.chat({
      model,
      messages,
      temperature: 0.4,
      maxTokens: 3000,
    })

    const content =
      (resp as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ??
      ''

    messages.push({ role: 'assistant', content })

    // Extract code blocks
    const codeRe = /```(\w+)?\n([\s\S]*?)```/g
    let codeMatch: RegExpExecArray | null = codeRe.exec(content)
    while (codeMatch !== null) {
      allCodeBlocks.push({ language: codeMatch[1] ?? 'text', code: codeMatch[2] ?? '' })
      codeMatch = codeRe.exec(content)
    }

    // Extract structured blocks
    const turnBlocks: { type: string; title: string }[] = []
    const blockReLocal = new RegExp(blockRe.source, blockRe.flags)
    let blockMatch: RegExpExecArray | null = blockReLocal.exec(content)
    while (blockMatch !== null) {
      const fields: Record<string, string> = {}
      for (const line of (blockMatch[2] ?? '').split('\n')) {
        const idx = line.indexOf(':')
        if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
      const blockType = blockMatch[1] ?? ''
      allBlocks.push({ type: blockType, fields })
      turnBlocks.push({ type: blockType, title: fields.title ?? '' })
      blockMatch = blockReLocal.exec(content)
    }

    // Detect tool calls via configurable patterns
    let hasToolCall = false
    if (config.toolCallPatterns) {
      for (const pattern of config.toolCallPatterns) {
        const re = new RegExp(pattern.source, pattern.flags)
        let toolMatch: RegExpExecArray | null = re.exec(content)
        while (toolMatch !== null) {
          allToolCalls.push(toolMatch[0])
          hasToolCall = true
          toolMatch = re.exec(content)
        }
      }
    }

    turns.push({
      turnIndex: i,
      userMessage: turn.user,
      agentResponse: content,
      durationMs: Date.now() - turnStart,
      blocksExtracted: turnBlocks,
      containsCode: allCodeBlocks.length > 0,
      containsToolCall: hasToolCall,
    })
  }

  const artifacts: CollectedArtifacts = {
    vaultFiles: [],
    blocksExtracted: allBlocks,
    codeBlocks: allCodeBlocks,
    toolCalls: allToolCalls,
  }

  // Run artifact checks
  const artifactResults = scenario.artifactChecks.map((check) => {
    // Try custom checker first
    if (config.artifactChecker) {
      const custom = config.artifactChecker(check, artifacts)
      if (custom) return { check, ...custom }
    }

    switch (check.type) {
      case 'block_extracted': {
        const count = allBlocks.filter((b) => b.type === check.target).length
        return {
          check,
          passed: count >= (check.minCount ?? 1),
          detail: `Found ${count} ${check.target} blocks (need ${check.minCount ?? 1})`,
        }
      }
      case 'code_valid': {
        const hasCode = allCodeBlocks.some(
          (b) => b.language === check.target || b.code.includes(check.target),
        )
        return { check, passed: hasCode, detail: hasCode ? 'Code block found' : 'No matching code' }
      }
      default:
        return {
          check,
          passed: false,
          detail: `Check type "${check.type}" requires live environment`,
        }
    }
  })

  // Run judges sequentially with retry. A judge that fails — unparseable
  // output (JudgeParseError, non-retryable) or errors across every attempt —
  // is COUNTED as a failed judge, never folded into the scores as a fake
  // zero row: a synthetic zero is indistinguishable from a real low score.
  const judgeInput = { scenario, turns, artifacts }
  const judgeResults: JudgeScore[][] = []
  let failedJudges = 0

  for (const judge of config.judges) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) {
          const wait = attempt * 10_000
          console.log(`    judge retry ${attempt}/2 (waiting ${wait / 1000}s)`)
          await new Promise((r) => setTimeout(r, wait))
        }
        const scores = await judge(tc, judgeInput)
        judgeResults.push(scores)
        await new Promise((r) => setTimeout(r, 3000))
        break
      } catch (err) {
        if (err instanceof JudgeParseError) {
          // The model answered but unparseably — another identical prompt
          // won't fix it. Record the failure and move to the next judge.
          failedJudges++
          break
        }
        if (attempt === 2) failedJudges++
      }
    }
  }

  const allScores = judgeResults.flat()
  // Defensive: custom JudgeFns may still emit error-shaped rows.
  const errorScores = allScores.filter(
    (s) => s.dimension === 'parse_error' || s.dimension === 'error',
  )
  const validScores = allScores.filter(
    (s) => s.dimension !== 'parse_error' && s.dimension !== 'error',
  )
  const normalized = normalizeScores(validScores)

  // Build weight map from scenario rubric dimensions
  const weightMap = new Map<string, number>()
  for (const dim of scenario.dimensions) {
    weightMap.set(dim, 1)
  }

  const overallScore = weightedMean(
    normalized.map((s) => ({
      score: s.score,
      weight: weightMap.get(s.dimension) ?? 1,
    })),
  )

  return {
    scenarioId: scenario.id,
    persona: scenario.persona,
    turns,
    artifactResults,
    judgeScores: allScores,
    judgeErrors: errorScores.length + failedJudges,
    overallScore,
    totalDurationMs: Date.now() - startTime,
    artifacts,
  }
}
