/**
 * TEMPORARY [cast-diag] — remove once the cast load bug is fixed.
 * Shared timestamped console.log helper for the cast path.
 */

export function castDiag(
  site: string,
  message: string,
  detail?: unknown,
): void {
  const ms = Math.round(performance.now());
  if (detail !== undefined) {
    console.log(`[cast-diag] +${ms}ms ${site}: ${message}`, detail);
  } else {
    console.log(`[cast-diag] +${ms}ms ${site}: ${message}`);
  }
}
