/**
 * Eigendecomposition of a small real symmetric matrix by cyclic Jacobi
 * rotations (Golub and Van Loan, Matrix Computations, 4th ed., §8.5).
 *
 * Jacobi is exact to rounding for symmetric input and needs no pivoting, so
 * the same matrix gives the same bits on every platform that follows IEEE 754
 * double arithmetic. It costs O(n³) per sweep and converges in a few sweeps,
 * which suits the matrices the search lenses decompose: landmark distance
 * matrices of at most a few dozen rows and unit-by-unit Gram matrices.
 */

export interface SymmetricEigen {
  /** Eigenvalues, largest first. */
  values: number[]
  /** `vectors[k]` is the unit eigenvector of `values[k]`. Its sign is fixed so
   * that its entry of largest magnitude is positive (the earliest such entry
   * on a tie), which makes the output deterministic. */
  vectors: number[][]
}

const MAX_SWEEPS = 100

/** Eigenvalues and eigenvectors of a symmetric matrix, largest value first. */
export function symmetricEigen(matrix: readonly (readonly number[])[]): SymmetricEigen {
  const n = matrix.length
  const a = matrix.map((row, index) => {
    if (row.length !== n) {
      throw new RangeError(`symmetricEigen: row ${index} has ${row.length} entries, expected ${n}`)
    }
    return row.map((value) => {
      if (!Number.isFinite(value)) throw new RangeError('symmetricEigen: entries must be finite')
      return value
    })
  })
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const scale = Math.max(1, Math.abs(a[i]![j]!), Math.abs(a[j]![i]!))
      if (Math.abs(a[i]![j]! - a[j]![i]!) > 1e-9 * scale) {
        throw new RangeError(`symmetricEigen: the matrix is not symmetric at (${i}, ${j})`)
      }
    }
  }
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  )
  let total = 0
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) total += a[i]![j]! ** 2
  const tolerance = 1e-24 * Math.max(total, Number.MIN_VALUE)
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let off = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i]![j]! ** 2
    if (off <= tolerance) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p]![q]!
        if (apq === 0) continue
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k]![p]!
          const akq = a[k]![q]!
          a[k]![p] = c * akp - s * akq
          a[k]![q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p]![k]!
          const aqk = a[q]![k]!
          a[p]![k] = c * apk - s * aqk
          a[q]![k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!
          const vkq = v[k]![q]!
          v[k]![p] = c * vkp - s * vkq
          v[k]![q] = s * vkp + c * vkq
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, index) => index).sort(
    (left, right) => a[right]![right]! - a[left]![left]! || left - right,
  )
  return {
    values: order.map((index) => a[index]![index]!),
    vectors: order.map((index) => orient(v.map((row) => row[index]!))),
  }
}

function orient(vector: number[]): number[] {
  let pivot = 0
  for (let index = 1; index < vector.length; index++) {
    if (Math.abs(vector[index]!) > Math.abs(vector[pivot]!) + 1e-12) pivot = index
  }
  return (vector[pivot] ?? 0) < 0 ? vector.map((value) => (value === 0 ? 0 : -value)) : vector
}
