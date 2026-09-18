/**
 * Judges for the question a software factory cannot answer about itself: is this real?
 *
 * A director that builds a product also grades it, and its grade is prose it wrote. Measured on
 * the DIU PROJ00716 campaign, 2026-09-17/18: a product whose own `independentReview` said
 * "verified" had four blocking defects a red team found in one pass, one of them a latency
 * figure about 6,500 times too fast because the timed region started after the durable write;
 * another packet reported 417,993 lines that were a vendored dependency tree; an earlier one
 * shipped `[PLACEHOLDER]` inside the deliverable brief. Every one of those passed a bar made of
 * predicates the director itself filled in.
 *
 * The same reading cuts the other way, which is why these judges read code rather than pattern
 * match on a number: a wave-j winner reporting a 0.122 ms median looked like the same defect and
 * was not. Its timed region covers normalisation, the durable write and a read-back that proves
 * the row is queryable, and it is named for exactly that. A judge that flagged it on the figure
 * alone would be wrong, which is the failure mode `measurementHonesty` is written to avoid.
 *
 * Jev answers a schema, not a prompt: each question returns a distribution over named levels,
 * so a gate reads a probability rather than parsing a paragraph. That is what makes these
 * usable as gates — `P(tautological) > 0.3` is a threshold, "the tests look thin" is not.
 *
 * Each judge here exists because a specific defect got through. The rubric levels are the
 * observations that would distinguish them, written so that the lowest level describes what we
 * actually found rather than a hypothetical.
 *
 * What these do NOT do: they read the artifact and its evidence, so they detect a claim
 * unsupported by what is in front of them. They do not run the product. A judge that says
 * `plausible` has not executed anything, and `verify_product` remains the thing that does.
 */

import type { JudgeConfig, Scenario } from './campaign/types'
import { type JevJudgeOptions, jevJudge } from './jev'

/**
 * What a judge is shown. Every field is evidence the run already retained, so nothing here
 * asks a director to write a new description of its own work.
 */
export interface ProductIntegrityArtifact {
  /** What was asked for, verbatim from the brief or idea, not the director's restatement. */
  intent: string
  /** Named claims the packet makes, with the evidence path each cites. */
  claims: Array<{ dimension: string; claim: string; evidence: string[] }>
  /** Source files under judgement: path, and the bytes a reader would see. */
  sources: Array<{ path: string; content: string }>
  /** Test files, separated so a judge can compare them against the sources. */
  tests: Array<{ path: string; content: string }>
  /** The measurement code behind a timing or throughput claim, when one is claimed. */
  measurements?: Array<{ claim: string; code: string; harness?: string }>
  /** Transcript of an operator walkthrough, and what the recordings show. */
  walkthrough?: { transcript?: string; frames?: number; seconds?: number }
  /** Counts the judge should not have to infer: vendored paths, generated paths. */
  inventory?: { sourceLines?: number; vendoredLines?: number; fileCount?: number }
}

type IntegrityOptions<TScenario extends Scenario = Scenario> = Omit<
  JevJudgeOptions<ProductIntegrityArtifact, TScenario>,
  'questions' | 'weights' | 'renderState'
> & { weights?: Record<string, number> }

/** Levels read bottom-up: index 0 is the failure we measured, the last is what we want. */
const MEASUREMENT_LEVELS = [
  'the number contradicts what the code measures, or the timed region excludes the work the claim names',
  'the measurement code is absent or does not show where timing starts and stops',
  'the timed region covers the claimed operation, but the figure is not reproduced in the evidence',
  'the evidence contains the measurement, its timed region covers the claim, and the figure follows from it',
]

const TEST_LEVELS = [
  'the tests assert constants, mirror the implementation, or assert only that a mock was called',
  'the tests exercise the implementation only through mocks of everything it depends on',
  'some tests drive the real implementation end to end, and the important paths are not among them',
  'the tests drive the real implementation over the paths the claims depend on, including failure paths',
]

const MATURITY_LEVELS = [
  'a script that demonstrates an idea; it holds no state, handles no error, and is not deployed',
  'a prototype: the main path works, and restart, malformed input, or concurrency are unhandled',
  'a deployable service: it persists state, rejects bad input, and has a deployment definition',
  'a service that would survive a hostile user: authenticated writes, integrity checks, and recovery',
]

const INTENT_LEVELS = [
  'it solves a different problem from the one the intent describes',
  'it solves a named part of the intent and omits the rest without saying so',
  'it covers what the intent asks for',
  'it covers the intent and the operational concerns the intent implies but does not list',
]

const WALKTHROUGH_LEVELS = [
  'the interface does not initialize, or the walkthrough never opens it',
  'the walkthrough shows a static page, with no task performed in it',
  'the walkthrough performs part of one task and stops before its result is visible',
  'the walkthrough performs a whole task a person came to do, and its result is visible afterwards',
]

/**
 * Rendering is deliberate: a judge sees the artifact's own bytes, not a summary of them, because
 * a summary is where a director's account of its work would re-enter and that is the thing being
 * checked. Long inputs cost input tokens, which is what Jev bills and it bills them cheaply.
 */
const renderIntegrityState = ({ artifact }: { artifact: ProductIntegrityArtifact }) => ({
  intent: artifact.intent,
  claims: artifact.claims,
  sources: artifact.sources,
  tests: artifact.tests,
  ...(artifact.measurements ? { measurements: artifact.measurements } : {}),
  ...(artifact.walkthrough ? { walkthrough: artifact.walkthrough } : {}),
  ...(artifact.inventory ? { inventory: artifact.inventory } : {}),
})

/**
 * The judge that grades a product against what it claims about itself.
 *
 * Weights are equal by default and deliberately not tuned here: a campaign that cares more about
 * one dimension says so at its call site, and a weight baked into this module would be a
 * preference presented as a measurement.
 */
export function productIntegrityJudge<TScenario extends Scenario = Scenario>(
  name: string,
  options: IntegrityOptions<TScenario>,
): JudgeConfig<ProductIntegrityArtifact, TScenario> {
  return jevJudge<ProductIntegrityArtifact, TScenario>(name, {
    ...options,
    renderState: renderIntegrityState,
    questions: {
      measurementHonesty: {
        type: 'score',
        instructions:
          'Read each measurement claim together with the code that produced it. Judge whether the timed or counted region actually covers the operation the claim names. A latency figure orders of magnitude below what the named operation physically costs is the signal that the region is wrong.',
        criteria: MEASUREMENT_LEVELS,
      },
      testsExerciseTheProduct: {
        type: 'score',
        instructions:
          'Compare the tests against the sources they import. Judge whether they drive the real implementation or assert around it. Counting test files is not the question; what the assertions touch is.',
        criteria: TEST_LEVELS,
      },
      productMaturity: {
        type: 'score',
        instructions:
          'Judge what this is, from the sources alone: a demonstration script, a prototype, a deployable service, or something that would survive a hostile user.',
        criteria: MATURITY_LEVELS,
      },
      intentCoverage: {
        type: 'score',
        instructions:
          'Compare the product against the stated intent. Judge coverage of what was asked for, not quality. A product that is excellent at a different problem scores at the bottom.',
        criteria: INTENT_LEVELS,
      },
      operatorWalkthrough: {
        type: 'score',
        instructions:
          'From the walkthrough transcript and recording facts, judge whether a person was shown completing a real task in the interface, or only that a page rendered.',
        criteria: WALKTHROUGH_LEVELS,
      },
      claimsSupportedByEvidence: {
        type: 'noul',
        instructions:
          'Does every claim cite evidence that, as shown here, supports that specific claim? Answer false if any claim cites a file that does not contain what the claim asserts.',
        criteria: {
          true: 'each claim is supported by the evidence it cites',
          false: 'at least one claim cites evidence that does not establish it',
        },
      },
      deliverablesAreFinished: {
        type: 'noul',
        instructions:
          'Do the deliverables read as finished? Answer false if any carries unfilled placeholder text, a TODO in place of content, or a section that describes what would be written rather than writing it. Bracketed fields a bidder is meant to complete, such as an offeror name, are deliberate and do not count.',
        criteria: {
          true: 'the deliverables are complete as written',
          false: 'at least one deliverable is unfinished in place',
        },
      },
      sizeIsAuthored: {
        type: 'noul',
        instructions:
          'Is the reported size the product the team wrote? Answer false if the line or file counts are dominated by a vendored dependency tree, generated code, or copied third-party sources.',
        criteria: {
          true: 'the size reflects authored source',
          false: 'the size is inflated by vendored, generated, or copied code',
        },
      },
    },
    ...(options.weights ? { weights: options.weights } : {}),
  })
}

/**
 * The per-file question, kept separate because it answers a different thing: not "is the product
 * real" but "where is the work". A campaign runs this over each changed file and ranks by
 * `P(unfinished) + P(stub)`, which is a work list ordered by evidence instead of by a director's
 * sense of what it should do next.
 */
export interface SourceFileArtifact {
  path: string
  content: string
  /** What this file is supposed to do, from the requirements matrix or the module's own contract. */
  expectation?: string
}

const FILE_LEVELS = [
  'a stub: it declares an interface and does not implement it, or returns a constant standing in for work',
  'unfinished: the main path exists and named responsibilities of this file are missing',
  'complete for its stated responsibility, with error handling or edge cases left out',
  'complete, including the failure paths its callers depend on',
]

export function sourceFileJudge<TScenario extends Scenario = Scenario>(
  name: string,
  options: Omit<JevJudgeOptions<SourceFileArtifact, TScenario>, 'questions' | 'renderState'>,
): JudgeConfig<SourceFileArtifact, TScenario> {
  return jevJudge<SourceFileArtifact, TScenario>(name, {
    ...options,
    renderState: ({ artifact: file }: { artifact: SourceFileArtifact }) => ({
      path: file.path,
      ...(file.expectation ? { expectation: file.expectation } : {}),
      content: file.content,
    }),
    questions: {
      completeness: {
        type: 'score',
        instructions:
          'Judge this file against what it is supposed to do. A file that is short is not thereby incomplete; a file that names a responsibility and does not carry it out is.',
        criteria: FILE_LEVELS,
      },
      leftoverScaffolding: {
        type: 'noul',
        instructions:
          'Does this file contain scaffolding that was meant to be removed: commented-out alternatives, an unused duplicate implementation, debug output, or a placeholder value in a path that runs?',
        criteria: {
          true: 'the file carries leftover scaffolding',
          false: 'the file carries none',
        },
      },
    },
  })
}
