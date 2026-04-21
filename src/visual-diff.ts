/**
 * Visual diff — pixel-delta scoring for UI / visual outputs.
 *
 * Minimal dependency-free implementation: accepts two PNGs as byte
 * arrays + width/height and returns a Δ ratio + per-channel histogram.
 * Consumers supply the decoded pixel arrays (we don't pull a PNG
 * decoder into the core — use `sharp`, `@napi-rs/canvas`, or Playwright
 * in the driving test and pass the result here).
 */

export interface ImageData {
  width: number
  height: number
  /** Pixel data in RGBA order, 4 bytes per pixel. */
  data: Uint8Array | Uint8ClampedArray
}

export interface VisualDiffResult {
  /** Ratio of pixels differing beyond `tolerance` (0..1). */
  diffRatio: number
  differingPixels: number
  totalPixels: number
  maxChannelDelta: number
  /** Status for dashboards: unchanged (< 0.1%), changed, or severely-changed (> 5%). */
  status: 'unchanged' | 'changed' | 'severely-changed'
}

export interface VisualDiffOptions {
  /** Pixels whose max-channel delta is ≤ this are considered unchanged. Default 8/255. */
  tolerance?: number
}

export function visualDiff(a: ImageData, b: ImageData, options: VisualDiffOptions = {}): VisualDiffResult {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`visualDiff: image dims differ (${a.width}x${a.height} vs ${b.width}x${b.height})`)
  }
  if (a.data.length !== b.data.length) {
    throw new Error('visualDiff: image data length mismatch')
  }
  const tolerance = options.tolerance ?? 8
  const totalPixels = a.width * a.height
  let differing = 0
  let maxDelta = 0
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = Math.abs(a.data[i] - b.data[i])
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1])
    const db = Math.abs(a.data[i + 2] - b.data[i + 2])
    const da = Math.abs(a.data[i + 3] - b.data[i + 3])
    const worst = Math.max(dr, dg, db, da)
    if (worst > maxDelta) maxDelta = worst
    if (worst > tolerance) differing++
  }
  const diffRatio = totalPixels > 0 ? differing / totalPixels : 0
  const status = diffRatio < 0.001 ? 'unchanged' : diffRatio > 0.05 ? 'severely-changed' : 'changed'
  return { diffRatio, differingPixels: differing, totalPixels, maxChannelDelta: maxDelta, status }
}

/** Convenience: diffs two byte-identical-dim RGBA arrays, returns just the ratio. */
export function pixelDeltaRatio(a: Uint8Array, b: Uint8Array, width: number, height: number, tolerance = 8): number {
  return visualDiff({ width, height, data: a }, { width, height, data: b }, { tolerance }).diffRatio
}
