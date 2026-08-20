/** Engine configuration shared by every GEPA run in the examples.
 *  litellm defaults `num_retries` to 3, and the loopback proxy already meters
 *  every attempt, so provider retries multiply attempt counts against the
 *  declared reflection budget. Zero keeps one metered attempt per call. */
export const GEPA_REFLECTION_ENGINE_CONFIG: Record<string, unknown> = {
  reflection: { reflection_lm_kwargs: { num_retries: 0 } },
}
