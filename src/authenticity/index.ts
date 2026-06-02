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

  return {
    realness,
    requiredArtifactPresent,
    requiredArtifactCount: required.length,
    usesRealImpl,
    realInfra,
    wired,
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
  opts: { floor?: number; requireArtifact?: boolean } = {},
): RealnessGate {
  const floor = opts.floor ?? 30
  if ((opts.requireArtifact ?? true) && !r.requiredArtifactPresent) {
    return { gated: true, reason: 'required artifact missing' }
  }
  if (r.fakeShim && !r.usesRealImpl) {
    return { gated: true, reason: 'fake shim with no real implementation' }
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

// Domain `AuthenticitySignals` (e.g. a Solidity/Fhenix preset) live in the
// CONSUMER, not the substrate — this module stays domain-agnostic.
