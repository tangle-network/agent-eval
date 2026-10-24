import { execFileSync } from 'node:child_process'

export const ADOPTION_BRANCH = 'chore/adopt-stack'
export const UPDATER_DRAFT_MARKER = '<!-- adopt-stack:draft=gate-fail -->'
const SETTLE_MS = 30_000
const MAX_READS = 6
const POLL_MS = 1_000

/** A failed legacy draft without explicit updater ownership remains held. */
export function isManuallyHeldDraft(open, previous) {
  return Boolean(previous?.isDraft && !(open?.isDraft && open.body.includes(UPDATER_DRAFT_MARKER) && previous.body.includes(UPDATER_DRAFT_MARKER)))
}

/**
 * Git's owned branch is authoritative after push; the PR view may settle later.
 * No metadata changes are allowed until both agree. Every attempt brackets the
 * PR read with fresh remote refs; unknown or competing refs fail immediately.
 * The final merge still requires its native expected-head and captured-base guards.
 * `readProposal` is the external HTTP read seam; production uses authenticated gh.
 */
export async function readPushedProposal(dir, number, expectedHead, defaultBranch, readProposal) {
  const deadline = Date.now() + SETTLE_MS
  const command = (cmd, argv) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`#${number} PR head settlement exceeded ${SETTLE_MS} ms; no metadata or merge attempted`)
    return execFileSync(cmd, argv, { cwd: dir, encoding: 'utf8', timeout: Math.min(10_000, remaining), stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  }
  const remoteHead = () => {
    const actual = command('git', ['ls-remote', 'origin', `refs/heads/${ADOPTION_BRANCH}`]).split(/\s/)[0]
    if (!/^[0-9a-f]{40}$/.test(actual)) throw new Error(`#${number} authoritative proposal ref is unknown (expected ${expectedHead}, observed ${actual || 'empty'}); no metadata or merge attempted`)
    if (actual !== expectedHead) throw new Error(`#${number} moved after the gate: authoritative branch expected ${expectedHead}, observed ${actual}; no metadata or merge attempted`)
  }
  const read = readProposal ?? (() => JSON.parse(command('gh', ['api', `repos/{owner}/{repo}/pulls/${number}`])))
  let observed = 'unknown'
  for (let attempt = 1; attempt <= MAX_READS; attempt += 1) {
    remoteHead()
    const controller = new AbortController()
    const remaining = deadline - Date.now()
    let timer
    let raw
    try {
      raw = await Promise.race([
        read({ signal: controller.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`#${number} PR read deadline exceeded; no metadata or merge attempted`)) }, Math.max(1, remaining)) }),
      ])
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
    remoteHead()
    const proposal = raw && { headRefOid: raw.head?.sha, headRefName: raw.head?.ref, baseRefName: raw.base?.ref, state: raw.state, isDraft: raw.draft, body: raw.body ?? '' }
    if (!proposal || !/^[0-9a-f]{40}$/.test(proposal.headRefOid ?? '') || typeof proposal.isDraft !== 'boolean' || typeof proposal.body !== 'string') throw new Error(`#${number} PR head/state response is unknown; no metadata or merge attempted`)
    if (proposal.state !== 'open' || proposal.headRefName !== ADOPTION_BRANCH || proposal.baseRefName !== defaultBranch) throw new Error(`#${number} proposal scope changed (state ${proposal.state}, head ${proposal.headRefName}, base ${proposal.baseRefName}); no metadata or merge attempted`)
    if (proposal.headRefOid === expectedHead) return proposal
    observed = proposal.headRefOid
    console.log(`adopt-stack: #${number} PR head ${observed} differs from stable pushed branch ${expectedHead}; settlement read ${attempt}/${MAX_READS}`)
    if (attempt < MAX_READS && Date.now() + POLL_MS < deadline) await new Promise((done) => setTimeout(done, POLL_MS))
    else break
  }
  throw new Error(`#${number} PR head did not settle (expected ${expectedHead}, last PR ${observed}, branch remained expected); no metadata or merge attempted`)
}
