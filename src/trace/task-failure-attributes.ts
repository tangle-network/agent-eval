import { ValidationError } from '../errors'
import { FAILURE_CLASSES, type FailureClass } from './schema'

const TASK_FAILURE_CLASS_ATTR = 'tangle.task.failure_class'
const TASK_FAILURE_MODE_ATTR = 'tangle.task.failure_mode'

interface AttributeCarrier {
  attributes: Record<string, unknown>
}

export interface TaskFailureLabels {
  failureClass?: FailureClass
  failureMode?: string
}

export function readTaskFailureLabels(
  roots: readonly AttributeCarrier[],
  context: string,
): TaskFailureLabels {
  const failureClass = readConsistentRootString(roots, TASK_FAILURE_CLASS_ATTR, context)
  const failureMode = readConsistentRootString(roots, TASK_FAILURE_MODE_ATTR, context)

  if (failureClass !== undefined && !FAILURE_CLASSES.includes(failureClass as FailureClass)) {
    throw new ValidationError(
      `${context}: ${TASK_FAILURE_CLASS_ATTR} must be one of ${FAILURE_CLASSES.join(', ')}`,
    )
  }

  return {
    ...(failureClass ? { failureClass: failureClass as FailureClass } : {}),
    ...(failureMode ? { failureMode } : {}),
  }
}

function readConsistentRootString(
  roots: readonly AttributeCarrier[],
  key: string,
  context: string,
): string | undefined {
  const values = new Set<string>()
  for (const root of roots) {
    if (!Object.hasOwn(root.attributes, key)) continue
    const value = root.attributes[key]
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ValidationError(`${context}: ${key} must be a non-empty string`)
    }
    values.add(value)
  }

  if (values.size > 1) {
    throw new ValidationError(
      `${context}: conflicting ${key} values: ${[...values].sort().join(', ')}`,
    )
  }
  return values.values().next().value
}
