/**
 * The ONE encoding from this package's span values to OTLP wire values.
 *
 * Both exporters emit the same `OtlpSpan` shape, so an attribute typed as a
 * double by one and a string by the other would make the same run read
 * differently depending on which exporter produced it.
 */

/** One OTLP `KeyValue`: the value is tagged with the protocol's type slot. */
export interface OtlpAttribute {
  key: string
  value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean }
}

/** OTLP `KeyValue[]` for a flat attribute record. */
export function toOtlpAttributes(
  record: Record<string, string | number | boolean>,
): OtlpAttribute[] {
  return Object.entries(record).map(([key, value]) => ({
    key,
    value:
      typeof value === 'number'
        ? Number.isInteger(value)
          ? { intValue: value.toString() }
          : { doubleValue: value }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : { stringValue: value },
  }))
}

/** OTLP nanosecond timestamp, as the decimal string the protocol requires. */
export function msToUnixNano(ms: number): string {
  return (BigInt(Math.floor(ms)) * 1_000_000n).toString()
}
