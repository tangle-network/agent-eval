import { describe, expect, it } from 'vitest'

import {
  type AuthenticitySignals,
  gateRealness,
  type ProducedFile,
  scoreAuthenticity,
  scoreAuthenticityNuance,
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
