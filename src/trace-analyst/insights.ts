export interface TraceInsightTask {
  id: string
  name: string
  prompt?: string
  difficulty?: string
  tags?: string[]
  outcome?: string
  score?: number
  gaps?: string[]
}

export interface TraceInsightSuite {
  name: string
  collectionId?: string
  tasks: TraceInsightTask[]
}

export interface TraceInsightFinding {
  kind: string
  severity?: string
  taskIds: string[]
  evidence?: string
  proposedFixClass?: string
}

export interface TraceInsightQuestion {
  id: string
  question: string
  why: string
}

export interface TraceInsightPanelRole {
  id: string
  name: string
  responsibility: string
}

export interface TraceInsightPromptInput {
  suite: TraceInsightSuite
  findings?: TraceInsightFinding[]
  agent?: Record<string, unknown>
  totals?: Record<string, unknown>
  maxRepresentativeTraces?: number
}

const DOMAIN_STOP_WORDS = new Set([
  'and',
  'app',
  'build',
  'create',
  'for',
  'from',
  'implementation',
  'integrate',
  'project',
  'task',
  'the',
  'this',
  'with',
  'workflow',
])

export function tokenizeDomainWords(value: string): string[] {
  return [...value.matchAll(/[A-Za-z][A-Za-z0-9.+#-]{2,}/g)]
    .map((match) => match[0].toLowerCase())
    .filter((word) => !DOMAIN_STOP_WORDS.has(word))
}

export function inferDomainKeywords(suite: TraceInsightSuite): string[] {
  const suiteWords = new Set(tokenizeDomainWords(`${suite.name} ${suite.collectionId ?? ''}`))
  const source = [
    suite.name,
    suite.collectionId ?? '',
    ...suite.tasks.flatMap((task) => [
      task.id,
      task.name,
      task.prompt ?? '',
      task.difficulty ?? '',
      ...(task.tags ?? []),
      ...(task.gaps ?? []),
    ]),
  ].join(' ')
  const counts = new Map<string, number>()
  for (const word of tokenizeDomainWords(source)) counts.set(word, (counts.get(word) ?? 0) + 1)
  return [...counts.entries()]
    .filter(([word, count]) => count >= 2 || suiteWords.has(word))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word)
    .slice(0, 18)
}

export function domainEvidencePattern(keywords: string[]): RegExp {
  const escaped = keywords
    .filter((keyword) => keyword.length >= 3)
    .map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return escaped.length > 0
    ? new RegExp(`(?<![A-Za-z0-9])(?:${escaped.join('|')})(?![A-Za-z0-9])`, 'i')
    : /(?<![A-Za-z0-9])(?:sdk|api|css|dns|xml|provider|client|service|integration|webhook|transaction|auth|oauth|graphql|rest)(?![A-Za-z0-9])/i
}

export function describeTraceInsightScope(suite: TraceInsightSuite): string {
  const taskLabel = suite.tasks.length === 1 ? '1 implementation task' : `${suite.tasks.length} implementation tasks`
  const tags = new Map<string, number>()
  for (const task of suite.tasks) {
    for (const tag of task.tags ?? []) tags.set(tag, (tags.get(tag) ?? 0) + 1)
  }
  const topTags = [...tags.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([tag]) => tag)
  if (topTags.length > 0) return `${taskLabel} across ${topTags.join(', ')}.`
  const difficulties = [...new Set(suite.tasks.map((task) => task.difficulty).filter((value): value is string => Boolean(value)))].join(', ')
  return `${taskLabel} across ${difficulties || 'the selected benchmark scope'}.`
}

export function planTraceInsightQuestions(input: TraceInsightPromptInput): TraceInsightQuestion[] {
  const hasFailures = input.suite.tasks.some((task) => task.outcome && task.outcome !== 'satisfied')
  const hasMultipleShots = input.suite.tasks.some((task) => (task.gaps ?? []).some((gap) => /shot|review|retry|continue/i.test(gap)))
  const questions: TraceInsightQuestion[] = [
    {
      id: 'execution-path',
      question: 'What did the worker actually do before the first meaningful implementation edit?',
      why: 'Separates grounded execution from polished but shallow output.',
    },
    {
      id: 'research-grounding',
      question: 'Did the worker inspect docs, source, examples, or package references before committing to an implementation path?',
      why: 'Identifies whether failures came from weak retrieval, weak examples, or premature coding.',
    },
    {
      id: 'domain-proof',
      question: 'Which tasks produced executable domain proof versus UI copy, placeholders, or inferred behavior?',
      why: 'Keeps product-quality claims tied to concrete evidence.',
    },
    {
      id: 'root-cause',
      question: 'For each major failure cluster, is the likely root cause prompt/scaffold, docs/examples, SDK/API ergonomics, evaluator, runtime, or model behavior?',
      why: 'Turns trace observations into actionable ownership.',
    },
    {
      id: 'evidence-quality',
      question: 'Which external-facing claims are directly supported by trace ids, span ids, verifier findings, reviewer notes, or generated code?',
      why: 'Prevents unsupported customer-report conclusions.',
    },
  ]
  if (hasMultipleShots) {
    questions.push({
      id: 'reviewer-lift',
      question: 'Where did reviewer feedback improve score, stall, or regress across shots?',
      why: 'Shows whether the driver loop is learning or merely repeating work.',
    })
  }
  if (hasFailures) {
    questions.push({
      id: 'optimization-targets',
      question: 'Which prompt, evaluator, scaffold, or workflow changes should feed the next GEPA/autoresearch optimization run?',
      why: 'Connects benchmark evidence to the optimization loop.',
    })
  }
  return questions
}

export function defaultTraceInsightPanel(): TraceInsightPanelRole[] {
  return [
    {
      id: 'trace-forensics',
      name: 'Trace Forensics',
      responsibility: 'Reconstruct what the worker did in order, including research, edits, reviewer interventions, verifier feedback, and stop reason.',
    },
    {
      id: 'root-cause',
      name: 'Root Cause',
      responsibility: 'Map failures to prompt/scaffold, docs/examples, SDK/API/product ergonomics, evaluator, runtime, or model behavior.',
    },
    {
      id: 'optimization',
      name: 'Optimization',
      responsibility: 'Identify prompt, reviewer, evaluator, scaffold, and GEPA/autoresearch changes that should be tested next.',
    },
    {
      id: 'external-evidence',
      name: 'External Evidence',
      responsibility: 'Separate customer-safe claims from internal harness findings and reject conclusions without task, trace, span, code, reviewer, or verifier evidence.',
    },
  ]
}

export function buildTraceInsightPrompt(input: TraceInsightPromptInput): string {
  const questions = planTraceInsightQuestions(input)
  const keywords = inferDomainKeywords(input.suite)
  const maxRepresentativeTraces = input.maxRepresentativeTraces ?? 6
  return `Analyze this benchmark run and produce evidence-backed trace intelligence.

Audience:
- internal AI/product leadership
- possible customer-facing report for ${input.suite.name}

Investigation plan:
${questions.map((item, index) => `${index + 1}. ${item.question} (${item.why})`).join('\n')}

Analyst panel:
${defaultTraceInsightPanel().map((role) => `- ${role.name}: ${role.responsibility}`).join('\n')}

If the task branches are independent, use subagents for the panel roles above and aggregate their findings. Do not run a panel role unless its answer will change the final report.

Required output:
1. Executive verdict: what this run proves and does not prove.
2. The investigation questions you answered and the evidence used.
3. Failure taxonomy: agent prompting, evaluator/harness, docs/examples, SDK/API/product integration, infra.
4. Evidence-backed examples with trace ids/task ids and concrete verifier findings.
5. Highest-ROI fixes for the benchmark harness, prompt/GEPA optimization, and customer-facing product/docs surface.
6. What is safe for an external report versus what must stay internal.
7. One rerun plan that would validate lift after optimization.

Budget:
- Inspect the dataset overview, the failure summary, and at most ${maxRepresentativeTraces} representative traces.
- Prefer traces named in the failure summary over broad exploration.
- Do not do exhaustive trace sweeps.
- Return the final report as soon as the taxonomy and examples are supported.

Run summary:
${JSON.stringify({
  suite: input.suite.name,
  scope: describeTraceInsightScope(input.suite),
  inferredKeywords: keywords,
  agent: input.agent ?? null,
  totals: input.totals ?? null,
  findings: (input.findings ?? []).map((finding) => ({
    kind: finding.kind,
    severity: finding.severity,
    taskCount: finding.taskIds.length,
    proposedFixClass: finding.proposedFixClass,
  })),
  failures: input.suite.tasks
    .filter((task) => task.outcome && task.outcome !== 'satisfied')
    .map((task) => ({
      task: task.id,
      difficulty: task.difficulty,
      outcome: task.outcome,
      score: task.score,
      gaps: task.gaps ?? [],
    })),
}, null, 2)}

Use the trace tools. Do not invent facts. Cite task ids. Separate customer-facing claims from internal harness/model findings.`
}
