// Optional application recipe. These questions and thresholds are not library defaults.
import type { JudgeConfig, Scenario } from '../src/campaign/types'
import type { JevJudgeOptions, JevQuestions } from '../src/jev'
import { jevJudge } from '../src/jev'

export interface ProductIntegrityArtifact {
  intent: string
  claims: Array<{ dimension: string; claim: string; evidence: string[] }>
  sources: Array<{ path: string; content: string }>
  tests: Array<{ path: string; content: string }>
  measurements?: Array<{ claim: string; code: string; harness?: string }>
  walkthrough?: { transcript?: string; frames?: number; seconds?: number }
  inventory?: { sourceLines?: number; vendoredLines?: number; fileCount?: number }
}

/** An application may replace this object with its own validated JSON configuration. */
export const productQuestions = {
  measurementHonesty: {
    type: 'score',
    instructions: 'Compare measurement claims with the code and recorded evidence that produced them.',
    criteria: [
      'the number contradicts what the code measures, or the timed region excludes the named work',
      'the measurement code is absent or does not show where timing starts and stops',
      'the timed region covers the operation, but the figure is not reproduced in the evidence',
      'the evidence reproduces the measurement and its timed region covers the claim',
    ],
  },
  testsExerciseTheProduct: {
    type: 'score',
    instructions: 'Compare tests with the real implementation paths that the product claims depend on.',
    criteria: [
      'the tests assert constants, mirror the implementation, or assert only that a mock was called',
      'the tests replace all dependencies with mocks',
      'some tests exercise real integration paths, but important claimed paths are missing',
      'the tests exercise claimed integration paths and relevant failure cases',
    ],
  },
  productMaturity: {
    type: 'score',
    instructions: 'Assess the operational evidence, not the author description of maturity.',
    criteria: [
      'demonstration only; persistence and error handling are absent',
      'main path exists, but recovery and malformed inputs are unhandled',
      'deployment, persistence, and input rejection are implemented',
      'deployment, authorization, integrity, and recovery are supported by evidence',
    ],
  },
  intentCoverage: {
    type: 'score',
    instructions: 'Compare the artifact with the supplied intent.',
    criteria: ['different problem', 'part of the requested scope', 'requested scope', 'scope and implied operational needs'],
  },
  operatorWalkthrough: {
    type: 'score',
    instructions: 'Assess what the supplied operator walkthrough actually demonstrates.',
    criteria: ['no working interface shown', 'static page only', 'partial task shown', 'whole task and result shown'],
  },
  claimsSupportedByEvidence: {
    type: 'noul',
    instructions: 'Does each claim cite evidence that establishes that specific claim?',
  },
  deliverablesAreFinished: {
    type: 'noul',
    instructions: 'Are the deliverables complete, without unfilled content placeholders?',
  },
  sizeIsAuthored: {
    type: 'noul',
    instructions: 'Do reported code counts exclude vendored dependencies and generated code?',
  },
} satisfies JevQuestions

type IntegrityOptions<S extends Scenario> = Omit<
  JevJudgeOptions<ProductIntegrityArtifact, S>,
  'questions' | 'renderState'
>

export function productIntegrityJudge<S extends Scenario = Scenario>(
  name: string,
  options: IntegrityOptions<S>,
): JudgeConfig<ProductIntegrityArtifact, S> {
  return jevJudge<ProductIntegrityArtifact, S>(name, {
    ...options,
    questions: productQuestions,
    renderState: ({ artifact }) => ({
      intent: artifact.intent,
      claims: artifact.claims,
      sources: artifact.sources,
      tests: artifact.tests,
      ...(artifact.measurements ? { measurements: artifact.measurements } : {}),
      ...(artifact.walkthrough ? { walkthrough: artifact.walkthrough } : {}),
      ...(artifact.inventory ? { inventory: artifact.inventory } : {}),
    }),
  })
}

export interface SourceFileArtifact {
  path: string
  content: string
  expectation?: string
}

export function sourceFileJudge<S extends Scenario = Scenario>(
  name: string,
  options: Omit<JevJudgeOptions<SourceFileArtifact, S>, 'questions' | 'renderState'>,
): JudgeConfig<SourceFileArtifact, S> {
  return jevJudge<SourceFileArtifact, S>(name, {
    ...options,
    renderState: ({ artifact }) => ({
      path: artifact.path,
      content: artifact.content,
      ...(artifact.expectation ? { expectation: artifact.expectation } : {}),
    }),
    questions: {
      completeness: {
        type: 'score',
        instructions: 'Assess this file against its stated responsibility.',
        criteria: ['stub', 'unfinished', 'main path complete', 'main and failure paths complete'],
      },
      leftoverScaffolding: {
        type: 'noul',
        instructions: 'Does this file contain temporary scaffolding or placeholder behavior?',
      },
    },
  })
}
