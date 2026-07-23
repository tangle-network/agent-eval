export function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

export function nonNegativeIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value
}

export function safeIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`)
  return value
}

export function stringEnv(name: string, fallback: string): string {
  const value = (process.env[name] ?? fallback).trim()
  if (!value) throw new Error(`${name} must be a non-empty string`)
  return value
}

export function positiveNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than 0`)
  return value
}

export function nonNegativeNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be greater than or equal to 0`)
  }
  return value
}

export function optionalNonNegativeNumberEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be greater than or equal to 0`)
  }
  return value
}
