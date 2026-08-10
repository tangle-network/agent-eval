/**
 * Recorded evidence from the three hand-written preregistrations this module
 * re-derives, distilled to the fields the sealed rules read.
 *
 * Provenance (bench-cache artifacts, 2026-08-08..10):
 *   oracleProbe        killtest-20260810/grader-probe/*.txt — 45 raw pytest
 *                      tails, one boolean per replicate, pass = no failed line
 *   m1Outcomes         t8-milestone1/out/milestone1.json outcomes
 *   m1PolicyDigest     same file, policy.digest
 *   admitRecords       t8-milestone2/out/admit.json records (48 rows)
 *   recordedChain      freelunch-20260810/freelunch.json denominatorChain
 *   freelunchOutcomes  same file, outcomes (64 rollouts)
 *   rowSubsetM2        t8-milestone2/out/row-subset.json (20 rows, pick order)
 *   rowSubsetM3        tbench-20260808/m3/row-subset-m3.json (16 rows)
 *   uniformN           freelunch-20260810/uniform-n.txt
 *   recordedPowerCurve killtest-20260810/PREREG.md power table; the 0.90 and
 *                      1.00 points recomputed from the registered simulator
 *                      power.py at seed 20260810 (0.692 / 0.690)
 */

export const oracleProbe: Record<string, boolean[]> = {
  solved: [
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ],
  partial: [
    false,
    false,
    false,
    true,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
  ],
  unsolved: [
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
  ],
}

export const m1PolicyDigest = 'zero-step-continuation@v1'

export type M1Outcome = {
  rowId: string
  admitted: boolean
  noFixPasses: number
}

export const m1Outcomes: M1Outcome[] = [
  {
    rowId: 'password-recovery::password-recovery__Y6btTEX::na',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId: 'password-recovery::password-recovery__oDL7kv9::na',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId: 'password-recovery::password-recovery__FM5nbVQ::3bdd88a8-ad06-4c7e-b227-d6531d17aaf8',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId: 'password-recovery::password-recovery__Y6btTEX::ef75f312-0dcb-4381-9962-65367b200ff4',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__bGGME5b::b5a00939-dc77-4337-8d38-4fee433338d9',
    admitted: false,
    noFixPasses: 0,
  },
  {
    rowId: 'password-recovery::password-recovery__3ppLoVS::na',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__zRCLGYv::26a16ae9-6297-458f-8da8-16273d7fcc2d',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__G3nsU9T::7651f90f-e062-43e6-9b71-39cc4cbeb9ab',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__HTN7DWj::na',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__EpX8MSQ::na',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__ApLYykT::0470ff90-4ae7-4e34-8bd5-256da0319aae',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId: 'largest-eigenval::largest-eigenval__cxEtBTx::na',
    admitted: false,
    noFixPasses: 2,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__hdBhvoV::na',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__XFJa2Gw::f72e0fed-8564-401c-88f8-19419b648a04',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__hdBhvoV::8cc246cd-a5a8-42be-a756-9190b8717b0a',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId: 'largest-eigenval::largest-eigenval__4GTN8MQ::3528aacb-c0c6-4655-bdad-efda730321dd',
    admitted: false,
    noFixPasses: 1,
  },
  {
    rowId: 'password-recovery::password-recovery__oDL7kv9::e16ce5b3-741f-4847-ac06-05ab2d05b3e3',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId: 'password-recovery::password-recovery__TDWFpxY::3e938185-ff6a-44ad-aca0-490b10265ccc',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__54tCBdt::ffb8a76a-e045-4944-975f-cd0dea68b03a',
    admitted: true,
    noFixPasses: 0,
  },
  {
    rowId: 'password-recovery::password-recovery__FM5nbVQ::na',
    admitted: true,
    noFixPasses: 0,
  },
]

export type AdmitRecord = {
  rowId: string
  taskName: string
  stratum: string
  noFixPasses: number
  prefixDivergenceRatio: number
  admitted: boolean
}

export const admitRecords: AdmitRecord[] = [
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__2TaEKop::10eb9ec0-f249-4763-8751-a74939ea3f8f',
    taskName: 'count-dataset-tokens',
    stratum: 'command-error',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'count-dataset-tokens::count-dataset-tokens__2TaEKop::na',
    taskName: 'count-dataset-tokens',
    stratum: 'command-error',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__54tCBdt::ffb8a76a-e045-4944-975f-cd0dea68b03a',
    taskName: 'count-dataset-tokens',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__ApLYykT::0470ff90-4ae7-4e34-8bd5-256da0319aae',
    taskName: 'count-dataset-tokens',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'count-dataset-tokens::count-dataset-tokens__ApLYykT::na',
    taskName: 'count-dataset-tokens',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__G3nsU9T::7651f90f-e062-43e6-9b71-39cc4cbeb9ab',
    taskName: 'count-dataset-tokens',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__HL3ZzrX::be13aad7-489a-4d4e-8baa-d6d21ccb2a5b',
    taskName: 'count-dataset-tokens',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__QsEeKbG::ca0cfe4b-3b26-43a3-a66b-2ba4aee6e123',
    taskName: 'count-dataset-tokens',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'count-dataset-tokens::count-dataset-tokens__QsEeKbG::na',
    taskName: 'count-dataset-tokens',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'count-dataset-tokens::count-dataset-tokens__Z2bXgyE::na',
    taskName: 'count-dataset-tokens',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0.125,
    admitted: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__dz37PFX::71547b37-7c96-497e-9fd8-313178b16c46',
    taskName: 'count-dataset-tokens',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__qndgJ6J::c06e9dc0-ba69-496c-8e79-b4ea629ff673',
    taskName: 'count-dataset-tokens',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__rswWZoF::bb86fdab-76d3-477b-817c-200336f10263',
    taskName: 'count-dataset-tokens',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'largest-eigenval::largest-eigenval__3JWZwyS::412ba01f-aaba-4e36-948f-ea219a7412c5',
    taskName: 'largest-eigenval',
    stratum: 'command-error',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'largest-eigenval::largest-eigenval__4GTN8MQ::3528aacb-c0c6-4655-bdad-efda730321dd',
    taskName: 'largest-eigenval',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'largest-eigenval::largest-eigenval__4GTN8MQ::na',
    taskName: 'largest-eigenval',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'largest-eigenval::largest-eigenval__DDg44L8::53379ff3-3c1f-4869-8448-ab09eb66605f',
    taskName: 'largest-eigenval',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'largest-eigenval::largest-eigenval__cxEtBTx::na',
    taskName: 'largest-eigenval',
    stratum: 'clean-exit',
    noFixPasses: 1,
    prefixDivergenceRatio: 0,
    admitted: false,
  },
  {
    rowId: 'password-recovery::password-recovery__3ppLoVS::na',
    taskName: 'password-recovery',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0.1,
    admitted: true,
  },
  {
    rowId: 'password-recovery::password-recovery__CmnSqNf::dd03eaa1-6208-4c63-b6c6-98829b365577',
    taskName: 'password-recovery',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'password-recovery::password-recovery__CmnSqNf::na',
    taskName: 'password-recovery',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'password-recovery::password-recovery__FM5nbVQ::3bdd88a8-ad06-4c7e-b227-d6531d17aaf8',
    taskName: 'password-recovery',
    stratum: 'command-error',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'password-recovery::password-recovery__FM5nbVQ::na',
    taskName: 'password-recovery',
    stratum: 'command-error',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'password-recovery::password-recovery__TDWFpxY::3e938185-ff6a-44ad-aca0-490b10265ccc',
    taskName: 'password-recovery',
    stratum: 'command-error',
    noFixPasses: 0,
    prefixDivergenceRatio: 0.09090909090909091,
    admitted: true,
  },
  {
    rowId: 'password-recovery::password-recovery__TDWFpxY::na',
    taskName: 'password-recovery',
    stratum: 'command-error',
    noFixPasses: 0,
    prefixDivergenceRatio: 0.13636363636363635,
    admitted: false,
  },
  {
    rowId: 'password-recovery::password-recovery__Y6btTEX::ef75f312-0dcb-4381-9962-65367b200ff4',
    taskName: 'password-recovery',
    stratum: 'command-error',
    noFixPasses: 0,
    prefixDivergenceRatio: 0.07142857142857142,
    admitted: true,
  },
  {
    rowId: 'password-recovery::password-recovery__Y6btTEX::na',
    taskName: 'password-recovery',
    stratum: 'command-error',
    noFixPasses: 0,
    prefixDivergenceRatio: 0.07142857142857142,
    admitted: true,
  },
  {
    rowId: 'password-recovery::password-recovery__oDL7kv9::e16ce5b3-741f-4847-ac06-05ab2d05b3e3',
    taskName: 'password-recovery',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'password-recovery::password-recovery__oDL7kv9::na',
    taskName: 'password-recovery',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'password-recovery::password-recovery__rGg4KKB::na',
    taskName: 'password-recovery',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0.09090909090909091,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__5ZHe3Vx::79b90c85-479e-40c3-9104-e1df7452f961',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__Ce9jTmg::e070e0b6-6c27-45cc-a32b-868fbe9924ce',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__EpX8MSQ::2b181451-8c66-4ed4-9de2-ff9b0e6e77f8',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__EpX8MSQ::na',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__H7KfghC::d82f8fb9-6d75-4d48-b216-2e591ba6cd58',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__H7KfghC::na',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__HTN7DWj::bd4e8221-aeef-47ab-9516-ee5e94148aec',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__HTN7DWj::na',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__XFJa2Gw::f72e0fed-8564-401c-88f8-19419b648a04',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__bGGME5b::b5a00939-dc77-4337-8d38-4fee433338d9',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0.5,
    admitted: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__bGGME5b::na',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0.5,
    admitted: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__hdBhvoV::8cc246cd-a5a8-42be-a756-9190b8717b0a',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__hdBhvoV::na',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__yHHsK92::e3f87165-fc4e-44f1-9487-01ecce658f08',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__zPQrnf7::b1d77ec4-7757-4c00-a483-1450a5f648dd',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__zPQrnf7::na',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__zRCLGYv::26a16ae9-6297-458f-8da8-16273d7fcc2d',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__zRCLGYv::na',
    taskName: 'sanitize-git-repo',
    stratum: 'clean-exit',
    noFixPasses: 0,
    prefixDivergenceRatio: 0,
    admitted: true,
  },
]

export const recordedChain = {
  evaluated: 48,
  deterministicOracle: 43,
  cleanExit: 35,
  failedEndState: 35,
  prefixFidelityOk: 32,
  prefixDivergent: 3,
} as const

export type FreelunchOutcome = {
  rowId: string
  passed: boolean
}

export const freelunchOutcomes: FreelunchOutcome[] = [
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__HL3ZzrX::be13aad7-489a-4d4e-8baa-d6d21ccb2a5b',
    passed: true,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__ApLYykT::0470ff90-4ae7-4e34-8bd5-256da0319aae',
    passed: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__G3nsU9T::7651f90f-e062-43e6-9b71-39cc4cbeb9ab',
    passed: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__54tCBdt::ffb8a76a-e045-4944-975f-cd0dea68b03a',
    passed: false,
  },
  {
    rowId: 'count-dataset-tokens::count-dataset-tokens__ApLYykT::na',
    passed: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__QsEeKbG::ca0cfe4b-3b26-43a3-a66b-2ba4aee6e123',
    passed: false,
  },
  {
    rowId: 'count-dataset-tokens::count-dataset-tokens__QsEeKbG::na',
    passed: false,
  },
  {
    rowId: 'password-recovery::password-recovery__CmnSqNf::dd03eaa1-6208-4c63-b6c6-98829b365577',
    passed: false,
  },
  {
    rowId: 'password-recovery::password-recovery__CmnSqNf::na',
    passed: false,
  },
  {
    rowId: 'password-recovery::password-recovery__3ppLoVS::na',
    passed: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__dz37PFX::71547b37-7c96-497e-9fd8-313178b16c46',
    passed: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__qndgJ6J::c06e9dc0-ba69-496c-8e79-b4ea629ff673',
    passed: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__rswWZoF::bb86fdab-76d3-477b-817c-200336f10263',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__Ce9jTmg::e070e0b6-6c27-45cc-a32b-868fbe9924ce',
    passed: false,
  },
  {
    rowId: 'password-recovery::password-recovery__rGg4KKB::na',
    passed: false,
  },
  {
    rowId: 'password-recovery::password-recovery__oDL7kv9::na',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__5ZHe3Vx::79b90c85-479e-40c3-9104-e1df7452f961',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__EpX8MSQ::2b181451-8c66-4ed4-9de2-ff9b0e6e77f8',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__H7KfghC::d82f8fb9-6d75-4d48-b216-2e591ba6cd58',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__EpX8MSQ::na',
    passed: false,
  },
  {
    rowId: 'password-recovery::password-recovery__oDL7kv9::e16ce5b3-741f-4847-ac06-05ab2d05b3e3',
    passed: true,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__H7KfghC::na',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__HTN7DWj::bd4e8221-aeef-47ab-9516-ee5e94148aec',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__HTN7DWj::na',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__hdBhvoV::8cc246cd-a5a8-42be-a756-9190b8717b0a',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__zPQrnf7::b1d77ec4-7757-4c00-a483-1450a5f648dd',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__hdBhvoV::na',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__XFJa2Gw::f72e0fed-8564-401c-88f8-19419b648a04',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__zRCLGYv::26a16ae9-6297-458f-8da8-16273d7fcc2d',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__zPQrnf7::na',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__zRCLGYv::na',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__yHHsK92::e3f87165-fc4e-44f1-9487-01ecce658f08',
    passed: false,
  },
  {
    rowId: 'count-dataset-tokens::count-dataset-tokens__ApLYykT::na',
    passed: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__G3nsU9T::7651f90f-e062-43e6-9b71-39cc4cbeb9ab',
    passed: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__QsEeKbG::ca0cfe4b-3b26-43a3-a66b-2ba4aee6e123',
    passed: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__ApLYykT::0470ff90-4ae7-4e34-8bd5-256da0319aae',
    passed: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__HL3ZzrX::be13aad7-489a-4d4e-8baa-d6d21ccb2a5b',
    passed: true,
  },
  {
    rowId: 'password-recovery::password-recovery__3ppLoVS::na',
    passed: false,
  },
  {
    rowId: 'count-dataset-tokens::count-dataset-tokens__QsEeKbG::na',
    passed: false,
  },
  {
    rowId: 'password-recovery::password-recovery__CmnSqNf::dd03eaa1-6208-4c63-b6c6-98829b365577',
    passed: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__qndgJ6J::c06e9dc0-ba69-496c-8e79-b4ea629ff673',
    passed: false,
  },
  {
    rowId: 'password-recovery::password-recovery__CmnSqNf::na',
    passed: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__rswWZoF::bb86fdab-76d3-477b-817c-200336f10263',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__5ZHe3Vx::79b90c85-479e-40c3-9104-e1df7452f961',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__Ce9jTmg::e070e0b6-6c27-45cc-a32b-868fbe9924ce',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__EpX8MSQ::2b181451-8c66-4ed4-9de2-ff9b0e6e77f8',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__EpX8MSQ::na',
    passed: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__dz37PFX::71547b37-7c96-497e-9fd8-313178b16c46',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__H7KfghC::d82f8fb9-6d75-4d48-b216-2e591ba6cd58',
    passed: false,
  },
  {
    rowId: 'password-recovery::password-recovery__rGg4KKB::na',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__H7KfghC::na',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__HTN7DWj::bd4e8221-aeef-47ab-9516-ee5e94148aec',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__HTN7DWj::na',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__XFJa2Gw::f72e0fed-8564-401c-88f8-19419b648a04',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__hdBhvoV::8cc246cd-a5a8-42be-a756-9190b8717b0a',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__hdBhvoV::na',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__yHHsK92::e3f87165-fc4e-44f1-9487-01ecce658f08',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__zPQrnf7::b1d77ec4-7757-4c00-a483-1450a5f648dd',
    passed: false,
  },
  {
    rowId: 'password-recovery::password-recovery__oDL7kv9::e16ce5b3-741f-4847-ac06-05ab2d05b3e3',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__zPQrnf7::na',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__zRCLGYv::26a16ae9-6297-458f-8da8-16273d7fcc2d',
    passed: false,
  },
  {
    rowId: 'sanitize-git-repo::sanitize-git-repo__zRCLGYv::na',
    passed: false,
  },
  {
    rowId: 'password-recovery::password-recovery__oDL7kv9::na',
    passed: false,
  },
  {
    rowId:
      'count-dataset-tokens::count-dataset-tokens__54tCBdt::ffb8a76a-e045-4944-975f-cd0dea68b03a',
    passed: false,
  },
]

export const rowSubsetM2: string[] = [
  'count-dataset-tokens::count-dataset-tokens__2TaEKop::10eb9ec0-f249-4763-8751-a74939ea3f8f',
  'largest-eigenval::largest-eigenval__3JWZwyS::412ba01f-aaba-4e36-948f-ea219a7412c5',
  'password-recovery::password-recovery__3ppLoVS::na',
  'sanitize-git-repo::sanitize-git-repo__5ZHe3Vx::79b90c85-479e-40c3-9104-e1df7452f961',
  'count-dataset-tokens::count-dataset-tokens__2TaEKop::na',
  'largest-eigenval::largest-eigenval__4GTN8MQ::3528aacb-c0c6-4655-bdad-efda730321dd',
  'password-recovery::password-recovery__CmnSqNf::dd03eaa1-6208-4c63-b6c6-98829b365577',
  'sanitize-git-repo::sanitize-git-repo__Ce9jTmg::e070e0b6-6c27-45cc-a32b-868fbe9924ce',
  'count-dataset-tokens::count-dataset-tokens__54tCBdt::ffb8a76a-e045-4944-975f-cd0dea68b03a',
  'largest-eigenval::largest-eigenval__4GTN8MQ::na',
  'password-recovery::password-recovery__CmnSqNf::na',
  'sanitize-git-repo::sanitize-git-repo__EpX8MSQ::2b181451-8c66-4ed4-9de2-ff9b0e6e77f8',
  'count-dataset-tokens::count-dataset-tokens__ApLYykT::0470ff90-4ae7-4e34-8bd5-256da0319aae',
  'largest-eigenval::largest-eigenval__DDg44L8::53379ff3-3c1f-4869-8448-ab09eb66605f',
  'password-recovery::password-recovery__FM5nbVQ::3bdd88a8-ad06-4c7e-b227-d6531d17aaf8',
  'sanitize-git-repo::sanitize-git-repo__EpX8MSQ::na',
  'count-dataset-tokens::count-dataset-tokens__ApLYykT::na',
  'password-recovery::password-recovery__FM5nbVQ::na',
  'sanitize-git-repo::sanitize-git-repo__H7KfghC::d82f8fb9-6d75-4d48-b216-2e591ba6cd58',
  'count-dataset-tokens::count-dataset-tokens__G3nsU9T::7651f90f-e062-43e6-9b71-39cc4cbeb9ab',
]

export const rowSubsetM3: string[] = [
  'count-dataset-tokens::count-dataset-tokens__2TaEKop::10eb9ec0-f249-4763-8751-a74939ea3f8f',
  'count-dataset-tokens::count-dataset-tokens__2TaEKop::na',
  'count-dataset-tokens::count-dataset-tokens__54tCBdt::ffb8a76a-e045-4944-975f-cd0dea68b03a',
  'count-dataset-tokens::count-dataset-tokens__ApLYykT::0470ff90-4ae7-4e34-8bd5-256da0319aae',
  'count-dataset-tokens::count-dataset-tokens__ApLYykT::na',
  'count-dataset-tokens::count-dataset-tokens__G3nsU9T::7651f90f-e062-43e6-9b71-39cc4cbeb9ab',
  'password-recovery::password-recovery__3ppLoVS::na',
  'password-recovery::password-recovery__CmnSqNf::dd03eaa1-6208-4c63-b6c6-98829b365577',
  'password-recovery::password-recovery__CmnSqNf::na',
  'password-recovery::password-recovery__FM5nbVQ::3bdd88a8-ad06-4c7e-b227-d6531d17aaf8',
  'password-recovery::password-recovery__FM5nbVQ::na',
  'sanitize-git-repo::sanitize-git-repo__5ZHe3Vx::79b90c85-479e-40c3-9104-e1df7452f961',
  'sanitize-git-repo::sanitize-git-repo__Ce9jTmg::e070e0b6-6c27-45cc-a32b-868fbe9924ce',
  'sanitize-git-repo::sanitize-git-repo__EpX8MSQ::2b181451-8c66-4ed4-9de2-ff9b0e6e77f8',
  'sanitize-git-repo::sanitize-git-repo__EpX8MSQ::na',
  'sanitize-git-repo::sanitize-git-repo__H7KfghC::d82f8fb9-6d75-4d48-b216-2e591ba6cd58',
]

export const recordedUniformN = 2

export const recordedPowerCurve: { effect: number; power: number }[] = [
  { effect: 0, power: 0.081 },
  { effect: 0.1, power: 0.15 },
  { effect: 0.3, power: 0.339 },
  { effect: 0.5, power: 0.488 },
  { effect: 0.9, power: 0.692 },
  { effect: 1, power: 0.69 },
]

/** Task-clustered 95% interval the milestone-2 report recorded for the prime-vs-bare contrast. */
export const recordedM2Interval = { lower: -0.1, upper: 0.567 }
