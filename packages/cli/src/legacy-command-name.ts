import { basename } from 'node:path';

const LEGACY_COMMAND_NAMES: ReadonlySet<string> = new Set(['ok', 'open-knowledge']);

export function legacyCommandNotice(invokedPath: string | undefined): string | null {
  if (invokedPath === undefined) return null;
  const name = basename(invokedPath).replace(/\.(?:c|m)?js$/, '');
  if (!LEGACY_COMMAND_NAMES.has(name)) return null;
  return `The command \`${name}\` is now \`gq\` (or \`gitquire\`). The old name still works for now and will be removed in a later version.\n`;
}
