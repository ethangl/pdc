// Shared argument-parsing helpers for the scripts/ CLIs.

/** Drops one leading "--". pnpm forwards a literal "--" separator when a
 * script is invoked as `pnpm <script> -- --flag`; strict parseArgs treats
 * anything after it as a positional and rejects it. Dropping one leading
 * "--" makes that invocation and the no-separator form behave alike. */
export function stripPnpmSeparator(argv: string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

/** Parses a `--<flag>` value as a positive integer. Returns null when
 * `value` is undefined (the flag was not given). Throws when it is given
 * but is not an integer greater than 0 (so "10.5" and "0" are rejected,
 * not silently rounded or ignored). */
export function parsePositiveInt(flag: string, value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (Number.isInteger(n) && n > 0) return n;
  throw new Error(`--${flag} must be a positive integer, got ${value}`);
}
