/**
 * Cholesky factorization and solves for small symmetric positive-definite
 * systems (Golub and Van Loan, Matrix Computations, 4th ed., §4.2), the
 * ridge normal equations the skill-manifold lens solves once per row and
 * column of each alternating least-squares sweep.
 */

/** The lower-triangular L with `matrix = L Lᵀ`, or null when the matrix is
 * not numerically positive definite. */
export function cholesky(matrix: readonly (readonly number[])[]): number[][] | null {
  const n = matrix.length
  const lower = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let j = 0; j < n; j++) {
    let diagonal = matrix[j]![j]!
    for (let k = 0; k < j; k++) diagonal -= lower[j]![k]! ** 2
    if (!(diagonal > 0) || !Number.isFinite(diagonal)) return null
    const pivot = Math.sqrt(diagonal)
    lower[j]![j] = pivot
    for (let i = j + 1; i < n; i++) {
      let value = matrix[i]![j]!
      for (let k = 0; k < j; k++) value -= lower[i]![k]! * lower[j]![k]!
      lower[i]![j] = value / pivot
    }
  }
  return lower
}

/** Solves `L Lᵀ x = b` for x given the Cholesky factor L. */
export function choleskySolve(
  lower: readonly (readonly number[])[],
  b: readonly number[],
): number[] {
  const n = lower.length
  const y = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    let value = b[i]!
    for (let k = 0; k < i; k++) value -= lower[i]![k]! * y[k]!
    y[i] = value / lower[i]![i]!
  }
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let value = y[i]!
    for (let k = i + 1; k < n; k++) value -= lower[k]![i]! * x[k]!
    x[i] = value / lower[i]![i]!
  }
  return x
}

/** The inverse of a symmetric positive-definite matrix from its factor. */
export function choleskyInverse(lower: readonly (readonly number[])[]): number[][] {
  const n = lower.length
  const columns = Array.from({ length: n }, (_, j) =>
    choleskySolve(
      lower,
      Array.from({ length: n }, (_, i) => (i === j ? 1 : 0)),
    ),
  )
  return Array.from({ length: n }, (_, i) => columns.map((column) => column[i]!))
}
