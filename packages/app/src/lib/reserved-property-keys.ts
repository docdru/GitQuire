import type { LintDiagnostic } from '@gitquire/core/markdown/lint';

export const NO_RESERVED_KEYS: readonly string[] = [];

export function withoutReservedProperties(
  diagnostics: readonly LintDiagnostic[],
  reservedKeys: readonly string[],
): readonly LintDiagnostic[] {
  if (reservedKeys.length === 0) return diagnostics;
  const reserved = new Set(reservedKeys);
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.frontmatterProperty === undefined || !reserved.has(diagnostic.frontmatterProperty),
  );
}
