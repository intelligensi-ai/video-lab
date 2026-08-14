/**
 * Parse a deployment integer without allowing malformed configuration to turn
 * timers or capacity limits into NaN, zero, negative, fractional, or unbounded
 * values. Invalid input fails to the reviewed default.
 */
export function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}
