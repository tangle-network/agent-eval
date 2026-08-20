/**
 * Startup validation for the GSM8K comparison.
 *
 * The run pays for a baseline smoke pass before optimization starts, so
 * every required variable must be checked before the first paid call.
 * `missingGsm8kEnv` returns ONE entry per missing requirement, so a user
 * fixes the complete list in one edit instead of one crash at a time.
 */

export function missingGsm8kEnv(env: Record<string, string | undefined>): string[] {
  const missing: string[] = []
  if (!env.AGENT_EVAL_GSM8K_PATH?.trim()) {
    missing.push(
      'AGENT_EVAL_GSM8K_PATH — JSONL dataset with {id, question, answer} rows; the file header documents the download command',
    )
  }
  if (!env.LLM_API_KEY?.trim() && !env.TANGLE_API_KEY?.trim()) {
    missing.push('LLM_API_KEY (or TANGLE_API_KEY) — worker and optimizer credential')
  }
  const hasOwnerModule = Boolean(env.OPTIMIZER_EXECUTION_OWNER_MODULE?.trim())
  if (!hasOwnerModule && !env.LLM_BASE_URL?.trim() && !env.TANGLE_ROUTER_URL?.trim()) {
    missing.push(
      'LLM_BASE_URL (or TANGLE_ROUTER_URL) — required by the default optimizer execution owner; OPTIMIZER_EXECUTION_OWNER_MODULE replaces it',
    )
  }
  const sharedRates = Boolean(env.PRICE_IN_PER_M?.trim() && env.PRICE_OUT_PER_M?.trim())
  for (const prefix of ['GEPA', 'SKILLOPT'] as const) {
    const hasIn = sharedRates || Boolean(env[`${prefix}_PRICE_IN_PER_M`]?.trim())
    const hasOut = sharedRates || Boolean(env[`${prefix}_PRICE_OUT_PER_M`]?.trim())
    if (!hasIn || !hasOut) {
      missing.push(
        `${prefix}_PRICE_IN_PER_M and ${prefix}_PRICE_OUT_PER_M — exact ${prefix.toLowerCase()} optimizer-model rates; shared PRICE_IN_PER_M + PRICE_OUT_PER_M also satisfy them`,
      )
    }
  }
  return missing
}
