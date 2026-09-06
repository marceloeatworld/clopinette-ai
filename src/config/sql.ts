/**
 * Central SQL tagged template type for Durable Object SQLite.
 * Used across the entire codebase — import from here instead of redefining locally.
 */
export type SqlFn = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];
