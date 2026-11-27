// Seal this experiment's specification, or verify its sealed registration, through the package's own experiment surface.
//   pnpm exec tsx benchmarks/program-search-vs-chat/2026-11-27/seal.ts seal <sealedAt>   prints the registration
//   pnpm exec tsx benchmarks/program-search-vs-chat/2026-11-27/seal.ts amend <at> <reason> <blind...>   prints design.json amended to spec.json
//   pnpm exec tsx benchmarks/program-search-vs-chat/2026-11-27/seal.ts verify            checks design.json against spec.json
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { amendExperiment, type ExperimentSpec, type SealedExperiment, sealExperiment, verifySealedExperiment } from '../../../src/experiment'

const here = dirname(fileURLToPath(import.meta.url))
const spec = JSON.parse(readFileSync(join(here, 'spec.json'), 'utf8')) as ExperimentSpec
const [action, sealedAt, ...rest] = process.argv.slice(2)
const design = () => JSON.parse(readFileSync(join(here, 'design.json'), 'utf8')) as SealedExperiment
if (action === 'seal') {
  console.log(`SEALED ${JSON.stringify(await sealExperiment(spec, { sealedAt }))}`)
} else if (action === 'amend') {
  const [reason, ...blind] = rest
  console.log(`SEALED ${JSON.stringify(await amendExperiment(design(), { spec, reason, blind, at: sealedAt }))}`)
} else if (action === 'verify') {
  const registered = design()
  const sealed = await sealExperiment(spec, { sealedAt: registered.sealedAt })
  const ok = (await verifySealedExperiment(registered)) && sealed.digest === registered.digest
  console.log(`SEAL ${ok ? 'verifies' : 'does not verify'}: ${registered.digest}`)
  process.exitCode = ok ? 0 : 1
} else throw new Error('usage: seal.ts seal <sealedAt> | amend <at> <reason> <blind...> | verify')
