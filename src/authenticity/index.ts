/**
 * Authenticity — "is this real, or convincing BS?"
 *
 * Pass/build-style scoring rewards anything that compiles and renders, so an
 * agent can ship a polished frontend with a FAKE in-browser engine and zero of
 * the required on-chain/contract work, and outscore a half-finished real
 * implementation. This module scores what buildability does not: did the agent
 * actually build the intended thing on the intended infra, or fake it.
 *
 * Two layers:
 *   - DETERMINISTIC `scoreAuthenticity` — calibrated by construction (no LLM,
 *     trustworthy today). Structural signals over the produced files, driven by
 *     a domain `AuthenticitySignals` config: required artifact present, real
 *     implementation of the hard part, real infra calls, wiring, fake-shim
 *     detection, mock/stub density.
 *   - LLM NUANCE `scoreAuthenticityNuance` — mocked% / fake% / unique% for the
 *     "looks real but is hollow" cases structure can't see.
 *
 * `gateRealness` is the anti-Goodhart gate: a submission missing the required
 * artifact (or faking it) is capped and cannot rank high regardless of how
 * buildable it is. Domain-agnostic; ships a Solidity/Fhenix preset.
 *
 * Input is the produced-state currency: `{ path, content }[]` — exactly what
 * `extractProducedState(...).artifacts` yields, so any consumer can feed a run's
 * produced state straight in.
 */

export interface ProducedFile {
  path: string
  content?: string
}

export interface AuthenticitySignals {
  /** Human label for the domain (e.g. 'fhenix-fhe'). */
  label: string
  /** A file the task REQUIRES (e.g. /\.sol$/ for an on-chain task). */
  requiredArtifact?: RegExp
  /** Vendored/3rd-party paths to exclude from required-artifact detection. */
  vendored?: RegExp
  /** Real implementation of the hard part, inside the required artifact
   *  (e.g. Fhenix encrypted types + FHE.* ops). Matched against content, so it
   *  fails on comments/strings only if the regex is written tightly. */
  realImpl: RegExp
  /** Real use of the intended client infra (e.g. cofhejs.encrypt() calls). */
  realInfra: RegExp
  /** Evidence the artifact is actually wired/used (e.g. contract writes). */
  wiring?: RegExp
  /** A fake shim standing in for the real thing — matched on file path AND body. */
  fakeShim: RegExp
  /** Mock/stub/TODO markers. Defaults to a generic set. */
  mock?: RegExp
  /** Score weights (default 40/25/20/15). */
  weights?: { artifact?: number; impl?: number; infra?: number; wiring?: number }
}

export interface AuthenticityResult {
  /** Deterministic realness, 0 (BS) … 100 (real on real infra). */
  realness: number
  requiredArtifactPresent: boolean
  requiredArtifactCount: number
  usesRealImpl: boolean
  realInfra: boolean
  wired: boolean
  /** The required artifact is actually referenced/imported by other (non-artifact)
   *  files — i.e. wired into the rest of the system, not dead code. Domain-agnostic:
   *  a deliverable nothing else uses is suspect in any vertical. */
  artifactReferenced: boolean
  /** Convenience: the artifact is connected to the running system, via either the
   *  domain wiring signal OR a structural reference. */
  artifactWired: boolean
  fakeShim: boolean
  /** mock/stub markers per 1000 LOC, capped at 100. */
  mockDensity: number
  /** Human-readable BS flags — what's missing or faked. */
  flags: string[]
}

const DEFAULT_MOCK =
  /\bmock|\bfake|\bdummy|\bstub\b|simulat|hardcoded|placeholder|TODO|not\s+implemented|FIXME/i

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Top-level symbols a source file declares (contract/library/class/etc.), used to
 *  test whether other files reference the artifact. Language-agnostic keyword set. */
function declaredNames(content: string): string[] {
  const names = new Set<string>()
  const re =
    /\b(?:contract|library|interface|abstract\s+contract|class|enum|struct|module|package)\s+([A-Za-z_]\w*)/g
  let m = re.exec(content)
  while (m) {
    const name = m[1]
    if (name && name.length >= 4) names.add(name)
    m = re.exec(content)
  }
  return [...names]
}

/** Is a required artifact referenced/imported by any non-artifact file? Catches the
 *  "decorative / dead-code artifact" facade (a real-looking deliverable nothing in
 *  the running system imports, deploys, or calls). Purely structural — no domain. */
function isArtifactReferenced(
  required: readonly ProducedFile[],
  others: readonly ProducedFile[],
): boolean {
  if (!required.length || !others.length) return false
  return required.some((rf) => {
    const stem = rf.path.replace(/\.[^.]+$/, '') // import-path stem (no ext)
    const base = basename(rf.path) // filename incl. ext
    const names = declaredNames(rf.content ?? '')
    return others.some((o) => {
      const c = o.content ?? ''
      if (!c) return false
      if (c.includes(base) || c.includes(stem)) return true // import of the path
      return names.some((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(c)) // symbol reference
    })
  })
}

/** Deterministic authenticity scan of produced files. Pure — same files in,
 *  same score out. No LLM, no IO. */
export function scoreAuthenticity(
  files: readonly ProducedFile[],
  signals: AuthenticitySignals,
): AuthenticityResult {
  const w = {
    artifact: signals.weights?.artifact ?? 40,
    impl: signals.weights?.impl ?? 25,
    infra: signals.weights?.infra ?? 20,
    wiring: signals.weights?.wiring ?? 15,
  }
  const mockRe = signals.mock ?? DEFAULT_MOCK

  const required = signals.requiredArtifact
    ? files.filter(
        (f) => signals.requiredArtifact!.test(f.path) && !(signals.vendored?.test(f.path) ?? false),
      )
    : []
  const others = signals.requiredArtifact ? files.filter((f) => !required.includes(f)) : files

  const requiredText = required.map((f) => f.content ?? '').join('\n')
  const otherText = others.map((f) => f.content ?? '').join('\n')
  const allText = files.map((f) => f.content ?? '').join('\n')

  const requiredArtifactPresent = signals.requiredArtifact ? required.length > 0 : true
  // Real impl looked for in the required artifact when there is one, else anywhere.
  const usesRealImpl = signals.realImpl.test(signals.requiredArtifact ? requiredText : allText)
  const realInfra = signals.realInfra.test(allText)
  const wired = signals.wiring ? signals.wiring.test(otherText || allText) : false
  // Structural: is the required artifact actually used by the rest of the system?
  const artifactReferenced = isArtifactReferenced(required, others)
  const artifactWired = wired || artifactReferenced
  const fakeShim = files.some(
    (f) => signals.fakeShim.test(basename(f.path)) || signals.fakeShim.test(f.content ?? ''),
  )

  const mockHits = (
    allText.match(
      new RegExp(mockRe.source, mockRe.flags.includes('g') ? mockRe.flags : `${mockRe.flags}g`),
    ) ?? []
  ).length
  const loc = Math.max(1, allText.split('\n').length)
  const mockDensity = Math.min(100, Math.round((mockHits / loc) * 1000))

  // A real-looking artifact that nothing in the system imports/deploys/calls is
  // decorative (dead code) — a common facade. We REPORT this (flag + signal) but do
  // NOT auto-penalize the score: structural reference detection is noisy (an ABI or
  // placeholder-address file makes a dead contract look "referenced", while a strong
  // contract-only submission looks "dead"), so a score penalty manufactures false
  // negatives on legitimately-partial work. Gate on it only via opts.requireArtifactWired,
  // and let the LLM-nuance layer resolve the ambiguous middle band.
  const decorativeArtifact = requiredArtifactPresent && usesRealImpl && !artifactWired

  let realness = 0
  if (requiredArtifactPresent) realness += w.artifact
  if (usesRealImpl) realness += w.impl
  if (realInfra) realness += w.infra
  if (wired) realness += w.wiring
  if (fakeShim) realness -= 25
  realness -= Math.min(20, mockDensity)
  realness = Math.max(0, Math.min(100, realness))

  const flags: string[] = []
  if (signals.requiredArtifact && !requiredArtifactPresent) {
    flags.push(
      `NO_REQUIRED_ARTIFACT: task needs ${signals.label} artifact (${signals.requiredArtifact}); none produced`,
    )
  }
  if (requiredArtifactPresent && signals.requiredArtifact && !usesRealImpl) {
    flags.push('ARTIFACT_NO_REAL_IMPL: required artifact exists but lacks the real implementation')
  }
  if (fakeShim) flags.push('FAKE_SHIM: ships a client-side stand-in simulating the real infra')
  if (!realInfra && !requiredArtifactPresent)
    flags.push('NO_REAL_INFRA: no real infra calls — cosmetic at best')
  if (mockDensity >= 8)
    flags.push(`HIGH_MOCK_DENSITY: ${mockDensity} mock/stub markers per 1000 LOC`)
  if (signals.wiring && requiredArtifactPresent && !wired)
    flags.push('NOT_WIRED: artifact exists but is never used by the client')
  if (decorativeArtifact)
    flags.push(
      'DEAD_ARTIFACT: required artifact is not referenced/imported anywhere — decorative or dead code',
    )

  return {
    realness,
    requiredArtifactPresent,
    requiredArtifactCount: required.length,
    usesRealImpl,
    realInfra,
    wired,
    artifactReferenced,
    artifactWired,
    fakeShim,
    mockDensity,
    flags,
  }
}

export interface RealnessGate {
  gated: boolean
  reason?: string
}

/** Anti-Goodhart gate: a required-artifact-missing or faked submission is
 *  capped and cannot rank high regardless of buildability. */
export function gateRealness(
  r: AuthenticityResult,
  opts: { floor?: number; requireArtifact?: boolean; requireArtifactWired?: boolean } = {},
): RealnessGate {
  const floor = opts.floor ?? 30
  if ((opts.requireArtifact ?? true) && !r.requiredArtifactPresent) {
    return { gated: true, reason: 'required artifact missing' }
  }
  if (r.fakeShim && !r.usesRealImpl) {
    return { gated: true, reason: 'fake shim with no real implementation' }
  }
  // Opt-in (default off): a vertical where the deliverable MUST be wired into the
  // running system can reject a decorative/dead artifact. Off by default because a
  // contract-only (incomplete-but-real) submission is legitimately partial, not fake.
  if (
    opts.requireArtifactWired &&
    r.requiredArtifactPresent &&
    r.usesRealImpl &&
    !r.artifactWired
  ) {
    return { gated: true, reason: 'required artifact present but never wired into the system' }
  }
  if (r.realness < floor)
    return { gated: true, reason: `realness ${r.realness} below floor ${floor}` }
  return { gated: false }
}

// ── LLM nuance layer ─────────────────────────────────────────────────────────

export interface AuthenticityNuance {
  /** 0 (nothing mocked) … 100 (entirely mocked). */
  mockedPct: number
  /** 0 (genuine) … 100 (a hollow facade / cargo-culted). */
  fakePct: number
  /** 0 (boilerplate/template clone) … 100 (distinctive real work). */
  uniquePct: number
  verdict: string
}

/** A minimal completion fn — inject your model caller (router/tcloud). Keeps
 *  this module free of any specific LLM client. */
export type CompleteFn = (system: string, user: string) => Promise<string>

function fileDigest(
  files: readonly ProducedFile[],
  opts: { maxFiles?: number; perFile?: number; prioritize?: RegExp } = {},
): string {
  const maxFiles = opts.maxFiles ?? 14
  const perFile = opts.perFile ?? 1200
  // Lead with the required-artifact files (e.g. .sol) so a truncated digest
  // never hides the very thing the judge must assess.
  const ordered = opts.prioritize
    ? [...files].sort(
        (a, b) => Number(opts.prioritize!.test(b.path)) - Number(opts.prioritize!.test(a.path)),
      )
    : files
  return ordered
    .slice(0, maxFiles)
    .map((f) => `// ${f.path}\n${(f.content ?? '').slice(0, perFile)}`)
    .join('\n\n')
}

function clampPct(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0
}

/**
 * LLM nuance scoring — judges the "looks real but is hollow" axis structure
 * misses. Inject a `complete` caller; returns mocked/fake/unique % + a verdict.
 * Fail-soft: a bad/unparseable response yields a worst-case (fully-fake) read,
 * never a false pass.
 */
export async function scoreAuthenticityNuance(
  files: readonly ProducedFile[],
  complete: CompleteFn,
  opts: { intent?: string; prioritize?: RegExp } = {},
): Promise<AuthenticityNuance> {
  const system =
    'You audit whether an agent BUILT THE REAL THING or faked it. Be skeptical: ' +
    'a pretty UI, cosmetic labels, simulated/in-memory stand-ins for real infra, ' +
    'and cargo-culted imports do NOT count as real. Respond with ONLY JSON: ' +
    '{"mockedPct":0-100,"fakePct":0-100,"uniquePct":0-100,"verdict":"one sentence"}. ' +
    'mockedPct = how much is mocked/stubbed; fakePct = how hollow/facade it is; ' +
    'uniquePct = how distinctive vs boilerplate.'
  const user =
    (opts.intent ? `Intended deliverable: ${opts.intent}\n\n` : '') +
    `Produced files:\n${fileDigest(files, { prioritize: opts.prioritize })}`
  try {
    const raw = await complete(system, user)
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m)
      return { mockedPct: 100, fakePct: 100, uniquePct: 0, verdict: 'unparseable judge response' }
    const j = JSON.parse(m[0]) as Record<string, unknown>
    return {
      mockedPct: clampPct(j.mockedPct),
      fakePct: clampPct(j.fakePct),
      uniquePct: clampPct(j.uniquePct),
      verdict: typeof j.verdict === 'string' ? j.verdict : '',
    }
  } catch (err) {
    return {
      mockedPct: 100,
      fakePct: 100,
      uniquePct: 0,
      verdict: `judge error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ── Realness-direct LLM judge ─────────────────────────────────────────────────

export interface RealnessJudgment {
  /** 0 (facade/simulator) … 100 (real implementation on the intended infra). */
  isReal: number
  rationale: string
}

/**
 * Ask an LLM to rate realness DIRECTLY on a 0-100 scale — the axis that matched
 * human blind-labels in validation (F1 0.80→0.88 on the gray band; a fakePct/
 * hollowness proxy over-penalized "real core + stubbed periphery" partials, and a
 * weak judge model over-flagged — use a strong one). Domain-agnostic skeleton; the
 * consumer supplies `intent` (what the deliverable should be) and `rubric` (domain
 * specifics of real-vs-fake). Fail-closed: a bad response reads as fully fake.
 */
export async function judgeRealnessLlm(
  files: readonly ProducedFile[],
  complete: CompleteFn,
  opts: { intent?: string; rubric?: string; prioritize?: RegExp } = {},
): Promise<RealnessJudgment> {
  const system =
    "You are a skeptical auditor. Rate how REAL an agent's build is vs the intended " +
    'deliverable, 0-100. A genuine implementation of the HARD part on the intended ' +
    'infrastructure is SUBSTANTIALLY REAL (>=50) even if peripheral layers are stubbed; ' +
    'a pure simulator / facade / branded-type stand-in / no-op-stubbed dependency with ' +
    'no real implementation is FAKE (<=25). Judge the core on its merits and note the ' +
    'runtime. ' +
    (opts.rubric ? `Domain rubric: ${opts.rubric} ` : '') +
    'Respond with ONLY JSON: {"isReal":0-100,"why":"one sentence"}.'
  const user =
    (opts.intent ? `Intended deliverable: ${opts.intent}\n\n` : '') +
    `Produced files:\n${fileDigest(files, { prioritize: opts.prioritize })}`
  try {
    const raw = await complete(system, user)
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return { isReal: 0, rationale: 'unparseable judge response' }
    const j = JSON.parse(m[0]) as Record<string, unknown>
    return {
      isReal: clampPct(j.isReal),
      rationale: typeof j.why === 'string' ? j.why : '',
    }
  } catch (err) {
    return {
      isReal: 0,
      rationale: `judge error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ── Blended pipeline: deterministic for the clean extremes, LLM for the gray band ─

export type RealnessBand = 'clean-real' | 'clean-fake' | 'gray'

export interface BlendedRealness extends AuthenticityResult {
  /** Final realness after (only-when-needed) LLM adjudication, 0…100. */
  blendedRealness: number
  band: RealnessBand
  /** True iff the LLM judge was actually consulted (gray band only). */
  consultedLlm: boolean
  /** Present iff the LLM was consulted. */
  judgment?: RealnessJudgment
}

/**
 * Score realness using the cheapest sufficient signal: trust the deterministic
 * scorer on the CLEAN extremes (obvious fakes / obviously-real-and-wired), and only
 * spend an LLM call on the GRAY band — cells that look real structurally but carry
 * fakeness markers (a fake shim, an unwired/dead artifact, high mock density) or land
 * mid-range. This caps LLM cost at the fraction of cells static analysis can't
 * resolve, which matters at multi-vertical / multi-partner scale.
 *
 * Domain-agnostic: the gray-band TRIGGER is structural; the LLM judges via the
 * consumer-supplied `intent`. Fail-closed (a bad LLM response reads as fully fake).
 */
export async function scoreRealnessBlended(
  files: readonly ProducedFile[],
  signals: AuthenticitySignals,
  complete: CompleteFn,
  opts: {
    intent?: string
    rubric?: string
    grayBand?: [number, number]
    mockGrayThreshold?: number
  } = {},
): Promise<BlendedRealness> {
  const det = scoreAuthenticity(files, signals)
  const [lo, hi] = opts.grayBand ?? [30, 70]
  const mockGray = opts.mockGrayThreshold ?? 8

  // Structural conflict: a real artifact whose RUNTIME authenticity static analysis
  // can't settle — a fake shim is present, or it isn't wired to a real client (could
  // be a decorative contract next to a simulator, OR an incomplete-but-real build),
  // or mock density is high. Empirically (21 labeled cells) this routes 100% of the
  // deterministic errors to the LLM while leaving an error-free clean band.
  const conflict =
    det.requiredArtifactPresent &&
    det.usesRealImpl &&
    (det.fakeShim || !det.wired || det.mockDensity >= mockGray)
  const midRange = det.realness >= lo && det.realness <= hi

  let band: RealnessBand
  if (conflict || midRange) band = 'gray'
  else if (det.realness < lo) band = 'clean-fake'
  else band = 'clean-real'

  if (band !== 'gray') {
    return { ...det, blendedRealness: det.realness, band, consultedLlm: false }
  }

  // In the gray band the LLM read dominates (that's why we paid for it), with the
  // deterministic score as a light anchor. Weights 0.25/0.75 validated against blind
  // human labels (F1 0.88 vs 0.80 deterministic-only).
  const judgment = await judgeRealnessLlm(files, complete, {
    intent: opts.intent,
    rubric: opts.rubric,
    prioritize: signals.requiredArtifact,
  })
  const blendedRealness = Math.max(
    0,
    Math.min(100, Math.round(0.25 * det.realness + 0.75 * judgment.isReal)),
  )
  return { ...det, blendedRealness, band, consultedLlm: true, judgment }
}

// Domain `AuthenticitySignals` (e.g. a Solidity/Fhenix preset) live in the
// CONSUMER, not the substrate — this module stays domain-agnostic.
