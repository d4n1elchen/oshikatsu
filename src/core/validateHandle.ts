/**
 * Validate an operator-supplied artist handle. Handles are written to disk
 * (as iCal filenames) and may appear in URLs, so we reject anything that
 * would be unsafe in either context.
 *
 * Rules:
 *  - Non-empty after trim.
 *  - 1..64 chars (filesystem-friendly).
 *  - No whitespace, no control chars.
 *  - No path-unsafe punctuation: `/ \ : * ? " < > |`.
 *  - Cannot start or end with `.`, `-`, `_` (avoids hidden files and
 *    extension-parser confusion).
 *  - Unicode letters and digits allowed (so `嵐` and `乃木坂46` work).
 *
 * Returns `{ valid: true }` on success, `{ valid: false, reason }` otherwise.
 */
export type HandleValidation = { valid: true } | { valid: false; reason: string };

export function validateHandle(input: string): HandleValidation {
  if (input.length === 0) return { valid: false, reason: "Handle is required." };
  if (input.length > 64) return { valid: false, reason: "Handle is too long (max 64 chars)." };
  if (/\s/.test(input)) return { valid: false, reason: "Handle cannot contain whitespace." };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(input)) return { valid: false, reason: "Handle cannot contain control characters." };
  if (/[\\/:*?"<>|]/.test(input)) return { valid: false, reason: 'Handle cannot contain / \\ : * ? " < > |.' };
  if (/^[.\-_]/.test(input)) return { valid: false, reason: "Handle cannot start with . - or _." };
  if (/[.\-_]$/.test(input)) return { valid: false, reason: "Handle cannot end with . - or _." };
  return { valid: true };
}
