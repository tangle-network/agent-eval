import { ValidationError } from '../errors'

/**
 * The terms every declarative-arm comparison must hold equal before any
 * per-kind check runs. Arm kinds (analyst definitions, repair arms) extend
 * the comparison with their own fields; the refusals here are the floor.
 */
export interface DeclarativeArmTerms {
  readonly id: string
  /** Bounded repair turns the arm earns on a malformed reply. */
  readonly repairTurns: number
}

export interface EqualDeclarativeTerms {
  readonly ids: readonly string[]
  readonly repairTurns: number
}

/**
 * Refuses a comparison whose arms are not on equal terms: an empty set, a
 * duplicated id, or unequal repair turns — a retry is a second sample the
 * other arms never got. `noun` names the arm kind in every message so a
 * refusal reads in the caller's vocabulary.
 */
export function assertEqualDeclarativeTerms(
  noun: string,
  terms: ReadonlyArray<DeclarativeArmTerms>,
): EqualDeclarativeTerms {
  if (terms.length === 0) {
    throw new ValidationError(`a ${noun} comparison needs at least one ${noun}`)
  }
  const ids = terms.map((term) => term.id)
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
  if (duplicate !== undefined) {
    throw new ValidationError(`${noun} '${duplicate}' is declared twice`)
  }
  const repairTurns = terms[0]!.repairTurns
  const unequal = terms.find((term) => term.repairTurns !== repairTurns)
  if (unequal) {
    throw new ValidationError(
      `${noun} '${unequal.id}' gets ${unequal.repairTurns} bounded repair turns and ` +
        `${noun} '${terms[0]!.id}' gets ${repairTurns}; a retry is a second sample ` +
        'the other arms never got',
    )
  }
  return { ids, repairTurns }
}
