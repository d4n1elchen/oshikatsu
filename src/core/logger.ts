/**
 * Tiny shared logger.
 *
 * Process-wide silent flag so the TUI can suppress core-module logs that
 * would otherwise corrupt Ink's render. Verbose paths (daemon, scripts)
 * leave it at the default (off → logs go through).
 *
 * Why module-level state: "am I in TUI mode?" is a startup decision for the
 * whole process. Threading a logger through every constructor would be far
 * more churn for the same outcome.
 */

let silent = false;

export function setSilent(value: boolean): void {
  silent = value;
}

export function isSilent(): boolean {
  return silent;
}

export const log = {
  info: (...args: unknown[]): void => {
    if (!silent) console.log(...args);
  },
  warn: (...args: unknown[]): void => {
    if (!silent) console.warn(...args);
  },
  error: (...args: unknown[]): void => {
    if (!silent) console.error(...args);
  },
};
