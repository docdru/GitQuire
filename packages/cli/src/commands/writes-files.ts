import type { Command } from 'commander';

const WRITING_COMMANDS = new Set([
  'embeddings set-url',
  'embeddings clear-url',
  'embeddings set-model',
  'embeddings clear-model',
  'config migrate',
  'comments convert',
]);

function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    names.unshift(current.name());
  }
  return names.join(' ');
}

export function writesFilesForARunningServer(command: Command): boolean {
  const opts = command.opts<{ dryRun?: boolean; fix?: boolean }>();
  if (opts.dryRun === true) return false;
  const path = commandPath(command);
  if (path === 'lint') return opts.fix === true;
  return WRITING_COMMANDS.has(path);
}
