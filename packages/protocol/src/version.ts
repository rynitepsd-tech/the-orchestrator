/**
 * Engine protocol version.
 *
 * Bump MAJOR when a change is not backward compatible with an older UI.
 * The host negotiates on connect via `hello`; a mismatch surfaces as an
 * actionable engine error rather than mysterious runtime failures.
 */
export const PROTOCOL_VERSION = 1 as const;

/** Oldest protocol version this build can still talk to. */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1 as const;

export function isProtocolCompatible(remote: number): boolean {
  return (
    Number.isInteger(remote) &&
    remote >= MIN_SUPPORTED_PROTOCOL_VERSION &&
    remote <= PROTOCOL_VERSION
  );
}
