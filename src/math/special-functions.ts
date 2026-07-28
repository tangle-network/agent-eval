/** Lanczos approximation to ln Gamma(z). */
export function lnGamma(z: number): number {
  const g = 7
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z)
  }
  z -= 1
  let x = coefficients[0]!
  for (let i = 1; i < g + 2; i++) x += coefficients[i]! / (z + i)
  const t = z + g + 0.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}

/** Regularized incomplete beta function via a Lentz continued fraction. */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const logBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b)
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - logBeta) / a
  const maxIterations = 200
  const epsilon = 3e-7
  let c = 1
  let d = 1 - ((a + b) * x) / (a + 1)
  if (Math.abs(d) < 1e-30) d = 1e-30
  d = 1 / d
  let fraction = d
  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m
    let numerator = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2))
    d = 1 + numerator * d
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = 1 + numerator / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    fraction *= d * c
    numerator = -((a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))
    d = 1 + numerator * d
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = 1 + numerator / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    const delta = d * c
    fraction *= delta
    if (Math.abs(delta - 1) < epsilon) break
  }
  return front * fraction
}
