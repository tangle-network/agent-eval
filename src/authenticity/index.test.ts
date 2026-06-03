import { describe, expect, it } from 'vitest'

import {
  type AuthenticitySignals,
  gateRealness,
  type ProducedFile,
  scoreAuthenticity,
  scoreAuthenticityNuance,
  scoreRealnessBlended,
} from './index'

// Domain signals live in the consumer, not the substrate — the test defines its
// own (fhenix-shaped) to exercise the generic scorer.
const SIGNALS: AuthenticitySignals = {
  label: 'fhenix-fhe',
  requiredArtifact: /\.sol$/,
  vendored: /(^|\/)(lib\/forge-std|lib\/openzeppelin)\//,
  realImpl:
    /\beuint\d+\b|\bebool\b|\bFHE\.(add|sub|gte?|lte?|select|asEuint\d*|decrypt|sealoutput)\b|\binEuint\d*\b/,
  realInfra: /cofhejs\.\w+|\.encrypt_uint\d*\s*\(|cofhe\.encrypt\s*\(|\.createPermit\s*\(/,
  wiring: /writeContract|useContractWrite|sendTransaction|getContract\s*\(/,
  fakeShim: /fhe.?engine|mock.?encrypt|fake.?fhe|simulateEncrypt/i,
}

const FAKE: ProducedFile[] = [
  {
    path: 'src/App.tsx',
    content: 'export default function App(){return <div>Confidential Lending</div>}',
  },
  {
    path: 'src/lib/fhe-engine.ts',
    content:
      '// in-memory FHE simulation\nexport function mockEncrypt(v){/* TODO real cofhe */ return v}\nexport const euint64 = "euint64"',
  },
  {
    path: 'src/pages/Dashboard.tsx',
    content:
      'import type { EncryptedItemInput } from "@cofhe/sdk" // cosmetic\n// Credit Line (euint64)',
  },
]

const REAL: ProducedFile[] = [
  {
    path: 'contracts/ConfidentialLending.sol',
    content:
      'pragma solidity ^0.8.25;\nimport {FHE, euint64, ebool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";\ncontract Lending {\n  mapping(address=>euint64) credit;\n  function draw(inEuint64 calldata amt) external {\n    euint64 a = FHE.asEuint64(amt);\n    ebool ok = FHE.gte(credit[msg.sender], a);\n    credit[msg.sender] = FHE.select(ok, FHE.sub(credit[msg.sender], a), credit[msg.sender]);\n  }\n}',
  },
  {
    path: 'src/client.ts',
    content:
      'import { cofhejs } from "cofhejs/web"\nconst enc = await cofhejs.encrypt([amount])\nawait walletClient.writeContract({ address, abi, functionName: "draw", args: [enc] })',
  },
]

describe('authenticity — deterministic', () => {
  it('flags a fake frontend with no contract + a fake FHE engine', () => {
    const r = scoreAuthenticity(FAKE, SIGNALS)
    expect(r.requiredArtifactPresent).toBe(false)
    expect(r.usesRealImpl).toBe(false)
    expect(r.fakeShim).toBe(true)
    expect(r.realness).toBeLessThan(20)
    expect(r.flags.join(' ')).toMatch(/NO_REQUIRED_ARTIFACT/)
    expect(r.flags.join(' ')).toMatch(/FAKE_SHIM/)
  })

  it('scores a real contract with FHE ops + real client calls high', () => {
    const r = scoreAuthenticity(REAL, SIGNALS)
    expect(r.requiredArtifactPresent).toBe(true)
    expect(r.usesRealImpl).toBe(true)
    expect(r.realInfra).toBe(true)
    expect(r.wired).toBe(true)
    expect(r.realness).toBeGreaterThanOrEqual(90)
    expect(r.flags).toHaveLength(0)
  })

  it('the gate kills the fake and passes the real (anti-Goodhart)', () => {
    expect(gateRealness(scoreAuthenticity(FAKE, SIGNALS)).gated).toBe(true)
    expect(gateRealness(scoreAuthenticity(REAL, SIGNALS)).gated).toBe(false)
  })

  it('a .sol with no FHE ops is flagged (real artifact, fake substance)', () => {
    const r = scoreAuthenticity(
      [
        {
          path: 'contracts/Plain.sol',
          content:
            'pragma solidity ^0.8; contract C { uint256 x; function set(uint256 v) external { x = v; } }',
        },
      ],
      SIGNALS,
    )
    expect(r.requiredArtifactPresent).toBe(true)
    expect(r.usesRealImpl).toBe(false)
    expect(r.flags.join(' ')).toMatch(/ARTIFACT_NO_REAL_IMPL/)
  })

  it('ignores vendored forge-std/.sol when detecting the required artifact', () => {
    const r = scoreAuthenticity(
      [
        { path: 'lib/forge-std/src/Test.sol', content: 'contract Test {}' },
        { path: 'src/App.tsx', content: 'ui' },
      ],
      SIGNALS,
    )
    expect(r.requiredArtifactPresent).toBe(false)
  })
})

describe('authenticity — dead-code / decorative artifact (general)', () => {
  // A real-looking contract (real FHE ops) that NOTHING else imports/references,
  // sitting next to a simulated runtime that actually serves the app.
  const DEAD: ProducedFile[] = [
    {
      path: 'contracts/PerpetualDEX.sol',
      content:
        'pragma solidity ^0.8.25;\nimport {FHE, euint128, ebool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";\ncontract PerpetualDEX {\n  function open(inEuint128 calldata s) external { euint128 x = FHE.asEuint128(s); FHE.gte(x, x); }\n}',
    },
    {
      path: 'src/dexEngine.ts',
      content:
        '// in-browser engine — deterministic masking for demo\nexport const euint128 = "euint128"\nfunction maskEncrypt(v){ return v ^ 0x5eed }\nexport function open(v){ return maskEncrypt(v) }',
    },
    { path: 'src/App.tsx', content: 'import { open } from "./dexEngine"; export default ()=> <div/>' },
  ]

  it('flags a real artifact that nothing references as DEAD_ARTIFACT + de-ranks it', () => {
    const r = scoreAuthenticity(DEAD, SIGNALS)
    expect(r.requiredArtifactPresent).toBe(true)
    expect(r.usesRealImpl).toBe(true)
    expect(r.artifactReferenced).toBe(false)
    expect(r.artifactWired).toBe(false)
    expect(r.flags.join(' ')).toMatch(/DEAD_ARTIFACT/)
    // de-ranked vs an identical-but-wired artifact
    const wiredScore = scoreAuthenticity(REAL, SIGNALS).realness
    expect(r.realness).toBeLessThan(wiredScore)
  })

  it('does NOT gate dead code by default (could be incomplete-but-real), but does under requireArtifactWired', () => {
    const r = scoreAuthenticity(DEAD, SIGNALS)
    expect(gateRealness(r).gated).toBe(false)
    expect(gateRealness(r, { requireArtifactWired: true }).gated).toBe(true)
  })

  it('a real contract referenced by name elsewhere is artifactWired (not dead)', () => {
    const r = scoreAuthenticity(
      [
        REAL[0]!, // ConfidentialLending.sol declaring `contract Lending`
        { path: 'scripts/deploy.ts', content: 'const c = await ethers.deployContract("Lending")' },
      ],
      SIGNALS,
    )
    expect(r.artifactReferenced).toBe(true)
    expect(r.artifactWired).toBe(true)
    expect(r.flags.join(' ')).not.toMatch(/DEAD_ARTIFACT/)
  })

  it('a contract-only submission (no client at all) is not penalized as dead code via wiring gate', () => {
    // contract present + real impl, no other files — legitimately partial, not a facade
    const r = scoreAuthenticity([REAL[0]!], SIGNALS)
    expect(r.requiredArtifactPresent).toBe(true)
    expect(r.usesRealImpl).toBe(true)
    // default gate stays lenient (incomplete-but-real should not be called fake)
    expect(gateRealness(r).gated).toBe(false)
  })
})

describe('authenticity — LLM nuance', () => {
  it('parses a well-formed judge response', async () => {
    const complete = async () =>
      '{"mockedPct":80,"fakePct":90,"uniquePct":10,"verdict":"frontend facade, no real FHE"}'
    const n = await scoreAuthenticityNuance(FAKE, complete)
    expect(n).toEqual({
      mockedPct: 80,
      fakePct: 90,
      uniquePct: 10,
      verdict: 'frontend facade, no real FHE',
    })
  })

  it('fails closed (fully-fake) on an unparseable response', async () => {
    const n = await scoreAuthenticityNuance(FAKE, async () => 'the model rambled with no json')
    expect(n.fakePct).toBe(100)
    expect(n.uniquePct).toBe(0)
  })
})

describe('authenticity — blended pipeline (gray-band-only LLM)', () => {
  let calls = 0
  const spyComplete = (resp: string) => async () => {
    calls++
    return resp
  }

  it('does NOT call the LLM on a clean fake (deterministic suffices)', async () => {
    calls = 0
    const r = await scoreRealnessBlended(FAKE, SIGNALS, spyComplete('{}'))
    expect(r.band).toBe('clean-fake')
    expect(r.consultedLlm).toBe(false)
    expect(calls).toBe(0)
    expect(r.blendedRealness).toBe(r.realness)
  })

  it('does NOT call the LLM on a clean, wired, real build', async () => {
    calls = 0
    const r = await scoreRealnessBlended(REAL, SIGNALS, spyComplete('{}'))
    expect(r.band).toBe('clean-real')
    expect(r.consultedLlm).toBe(false)
    expect(calls).toBe(0)
  })

  it('consults the LLM on the gray band (real-looking artifact + fake shim) and lets it rescue a real one', async () => {
    // real contract + a fake-shim file present → structurally conflicted → gray
    const conflicted: ProducedFile[] = [
      REAL[0]!,
      { path: 'src/fhe-engine.ts', content: '// in-memory FHE simulation\nexport const mockEncrypt = (v)=>v' },
    ]
    calls = 0
    const r = await scoreRealnessBlended(
      conflicted,
      SIGNALS,
      spyComplete('{"isReal":85,"why":"real contract with FHE ops; the sim is a dev aid"}'),
    )
    expect(r.band).toBe('gray')
    expect(r.consultedLlm).toBe(true)
    expect(calls).toBe(1)
    expect(r.judgment?.isReal).toBe(85)
    expect(r.blendedRealness).toBeGreaterThan(60) // LLM rescued it from the shim penalty
  })

  it('gray band + fail-closed LLM response yields a low blend (no false pass)', async () => {
    const conflicted: ProducedFile[] = [
      REAL[0]!,
      { path: 'src/fhe-engine.ts', content: '// in-memory FHE simulation\nexport const mockEncrypt = (v)=>v' },
    ]
    const r = await scoreRealnessBlended(conflicted, SIGNALS, async () => 'no json here')
    expect(r.band).toBe('gray')
    expect(r.blendedRealness).toBeLessThan(40) // fakePct=100 → llmReal=0 → low blend
  })
})
