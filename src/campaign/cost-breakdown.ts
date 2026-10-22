import { createHash } from 'node:crypto'
import type { CostBreakdown, CostUsage } from '../cost-ledger'

/** Read the source rates for this execution, never a copied model price table.
 * inputTokens includes cachedTokens. Seat credits are standard model credits;
 * discounts and MCP charges require provider observations, not token guesses.
 * The existing USD receipt remains the Router charge. Sandbox is additional.
 */
export async function measureCampaignCost(input: {
  routerUsd?: number
  sandbox?: { seconds: number; cpu: number; memoryGB: number; diskGB: number; pool?: string }
  seat?: { model: string; usage: CostUsage & { usageUnknown?: boolean } }
  signal?: AbortSignal
}): Promise<CostBreakdown> {
  const sources: CostBreakdown['sources'] = []
  const unknown = { kind: 'uncaptured', usd: null } as const
  if (input.routerUsd !== undefined) finite(input.routerUsd, 'routerUsd')
  const result: CostBreakdown = {
    router: input.routerUsd === undefined ? unknown : { kind: 'observed', usd: input.routerUsd },
    sandbox: unknown,
    seatCredits: { kind: 'uncaptured', credits: null, reason: 'No seat usage supplied' },
    sources,
  }
  const read = async (url: string) => {
    const response = await fetch(url, {
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Rate source HTTP ${response.status}`)
    // Refuse a changed/unbounded document rather than importing arbitrary data.
    if (Number(response.headers.get('content-length')) > 1_000_000)
      throw new Error('Rate source too large')
    const chunks: Uint8Array[] = []
    let bytes = 0
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength
      if (bytes > 1_000_000) throw new Error('Rate source too large')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return {
      text,
      snapshot: {
        url,
        readAt: new Date().toISOString(),
        sha256: createHash('sha256').update(text).digest('hex'),
      },
    }
  }
  if (input.sandbox) {
    for (const [key, value] of Object.entries(input.sandbox))
      if (key !== 'pool') finite(value, `sandbox.${key}`)
    try {
      const { text, snapshot } = await read('https://sandbox.tangle.tools/v1/pricing/sandboxes')
      const card = JSON.parse(text).pools?.[input.sandbox.pool ?? 'general']
      const rates: Record<string, number> = {}
      for (const key of [
        'cpuCoreHourUsd',
        'memoryGBHourUsd',
        'diskGBHourUsd',
        'minChargeHourUsd',
      ]) {
        finite(card?.[key], key)
        rates[key] = card[key]
      }
      const s = input.sandbox
      const hourly = Math.max(
        rates.minChargeHourUsd!,
        s.cpu * rates.cpuCoreHourUsd! +
          s.memoryGB * rates.memoryGBHourUsd! +
          s.diskGB * rates.diskGBHourUsd!,
      )
      const usd = (hourly * s.seconds) / 3600
      finite(usd, 'sandbox USD estimate')
      result.sandbox = { kind: 'estimated', usd }
      sources.push({ ...snapshot, rates })
    } catch {
      // A missing rate leaves the estimate unknown while preserving Router observations.
    }
  }
  if (input.seat) {
    const { usage, model } = input.seat
    if (usage.usageUnknown || usage.cachedTokens === undefined) {
      result.seatCredits = {
        kind: 'uncaptured',
        credits: null,
        reason: 'Seat token or cached-input usage is unknown',
      }
      return result
    }
    for (const key of ['inputTokens', 'cachedTokens', 'outputTokens'] as const) {
      const value = usage[key]
      if (!Number.isSafeInteger(value) || value! < 0)
        throw new Error(`seat.${key} must be a known nonnegative token count`)
    }
    if (usage.cachedTokens! > usage.inputTokens) throw new Error('cachedTokens exceeds inputTokens')
    try {
      const { text, snapshot } = await read('https://docs.z.ai/devpack/overview.md')
      const modelName = model.split('/').at(-1)!.toLowerCase()
      const section = text
        .split('#### Credit Calculation')[1]
        ?.split('#### Estimated Token Allowance')[0]
      if (!section) throw new Error('Credit calculation section unavailable')
      const rows = [...section.matchAll(/<tr>\s*([\s\S]*?)<\/tr>/gu)]
      const matching = rows.filter((row) => {
        const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gu)].map((cell) =>
          cell[1]!.trim(),
        )
        return cells.some(
          (cell) =>
            cell
              .split(/\\|\n|</u)[0]!
              .trim()
              .toLowerCase() === modelName,
        )
      })
      if (matching.length !== 1) throw new Error(`No unique live credit row for '${model}'`)
      const cells = [...matching[0]![1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gu)].map((cell) =>
        cell[1]!.trim(),
      )
      const rateCells = cells.slice(-3)
      if (rateCells.length !== 3 || rateCells.some((cell) => !/^(?:\d+)(?:\.\d+)?$/u.test(cell)))
        throw new Error('Invalid live credit multipliers')
      const multipliers = rateCells.map(Number)
      for (const rate of multipliers) finite(rate, 'credit multiplier')
      const divisor = Number(
        section.match(/Model credit usage[^\n]*\/\s*([\d,]+)/u)?.[1]?.replaceAll(',', ''),
      )
      if (!Number.isFinite(divisor) || divisor <= 0) throw new Error('No live credit divisor')
      const [fresh, cached, output] = multipliers as [number, number, number]
      const credits =
        ((usage.inputTokens - usage.cachedTokens!) * fresh +
          usage.cachedTokens! * cached +
          usage.outputTokens * output) /
        divisor
      finite(credits, 'standard seat credits')
      result.seatCredits = { kind: 'estimated', credits }
      sources.push({
        ...snapshot,
        rates: {
          inputMultiplier: fresh,
          cachedInputMultiplier: cached,
          outputMultiplier: output,
          divisor,
        },
      })
    } catch (error) {
      result.seatCredits = {
        kind: 'uncaptured',
        credits: null,
        reason: error instanceof Error ? error.message : 'Credit source unavailable',
      }
    }
  }
  return result
}

function finite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be finite and nonnegative`)
}
