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

export type Logger = {
  info: (msg: string, ...rest: unknown[]) => void;
  warn: (msg: string, ...rest: unknown[]) => void;
  error: (msg: string, ...rest: unknown[]) => void;
};

export const log: Logger = {
  info: (msg, ...rest): void => {
    if (!silent) console.log(msg, ...rest);
  },
  warn: (msg, ...rest): void => {
    if (!silent) console.warn(msg, ...rest);
  },
  error: (msg, ...rest): void => {
    if (!silent) console.error(msg, ...rest);
  },
};

/**
 * Returns a logger that prepends `[component]` to every message. All call
 * sites should use this so prefixes are consistent and never drift.
 */
export function tagged(component: string): Logger {
  const prefix = `[${component}]`;
  return {
    info: (msg, ...rest) => log.info(`${prefix} ${msg}`, ...rest),
    warn: (msg, ...rest) => log.warn(`${prefix} ${msg}`, ...rest),
    error: (msg, ...rest) => log.error(`${prefix} ${msg}`, ...rest),
  };
}
