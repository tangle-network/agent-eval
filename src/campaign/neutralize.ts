/**
 * @module
 * Footprint-matched neutralization — the placebo control for content-vs-footprint
 * attribution in a promotion gate.
 *
 * A promoted surface can raise a held-out score two different ways:
 *  1. its CONTENT is informative (the thing we want to promote), or
 *  2. it merely added prompt/mount FOOTPRINT — more bytes, more lines, a longer
 *     more authoritative-looking prompt — that the model spends attention on
 *     regardless of what the bytes say.
 *
 * A held-out gate proves the candidate beat baseline; it cannot separate (1) from
 * (2). `neutralizeText` produces a variant that keeps the input's layout and
 * length while carrying ZERO information, so scoring it isolates the footprint
 * contribution (2). Feed the neutralized variant's scores to `neutralizationGate`:
 * any lift it still holds over baseline is decorative, and a candidate whose lift
 * survives neutralization is rejected however large its raw lift.
 */

/** Filler for blanked content. A single ASCII byte, so a run of it preserves an
 *  ASCII source's exact byte length; for multibyte sources it preserves CHARACTER
 *  count and layout (what the tokenizer footprint tracks), not raw byte count. */
const FILLER = '#'

/**
 * Blank every non-whitespace character to a 1-byte filler while preserving all
 * whitespace. Line count, indentation, and word/line lengths are unchanged — so
 * the neutralized variant has the same layout and (for ASCII) the same byte
 * footprint as the input, but no readable content. Whitespace is preserved
 * deliberately: collapsing it would change the token structure and stop the
 * variant from being a true footprint match.
 */
export function neutralizeText(content: string): string {
  return content.replace(/\S/g, FILLER)
}
