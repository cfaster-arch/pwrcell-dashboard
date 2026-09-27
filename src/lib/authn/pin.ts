/**
 * PIN scheme (2026-09-27): the dashboard's credential is a short numeric PIN,
 * not a text password. The PIN is still scrypt-hashed at rest via
 * better-auth's password.hash hook — only the *format* changed, not the
 * storage security. This module is client-safe (no node imports).
 */

export const PIN_LENGTH = 4;

/** Exactly 4 ASCII digits. */
const PIN_RE = /^\d{4}$/;

/** Trivial PINs that are rejected even though they match the shape. */
function isTrivial(pin: string): boolean {
  // 0000, 1111, ..., 9999
  if (/^(\d)\1{3}$/.test(pin)) return true;
  // 0123..6789 and 9876..3210 (straight runs up or down)
  if ("0123456789".includes(pin)) return true;
  if ("9876543210".includes(pin)) return true;
  return false;
}

/**
 * True when `pin` is acceptable as a user credential:
 * exactly 4 digits and not a trivially guessable one.
 */
export function isValidPin(pin: string): boolean {
  return PIN_RE.test(pin) && !isTrivial(pin);
}

export const PIN_RULE_TEXT =
  "PIN must be 4 digits (0-9), not all the same digit, and not a simple sequence like 1234.";
