import { resolve } from 'node:path';
import { FrontDoorConfigError, MoveOverError, moveOverFromEnv } from '@gitquire/server';
import { Command } from 'commander';
import { resolveLockDir } from '../config/paths.ts';
import { error as errorColor, success, warning } from '../ui/colors.ts';
import { inspectLock } from './lock-state.ts';

function runningOn(dir: string): string | undefined {
  const state = inspectLock(resolveLockDir(dir), 'server');
  if (state.status === 'alive') return `process ${state.lock.pid} holds its lock`;
  if (state.status === 'foreign-host') {
    return `a GitQuire in another container (${state.lock.hostname}) holds its lock; if that container is stopped, remove ${state.lockPath}`;
  }
  return undefined;
}

function moveCommand(direction: 'adopt' | 'unadopt', description: string): Command {
  return new Command(direction)
    .description(description)
    .argument('[dir]', 'Data directory', '/data')
    .option('--dry-run', 'Show what would change and change nothing')
    .option('--force', 'Move although edits are not pushed to the host yet')
    .action(async (dir: string, opts: { dryRun?: boolean; force?: boolean }) => {
      try {
        const report = await moveOverFromEnv(direction, resolve(dir), process.env, runningOn, {
          dryRun: opts.dryRun === true,
          force: opts.force === true,
        });
        for (const step of report.steps) console.log(report.changed ? success(step) : step);
        for (const note of report.warnings) console.warn(warning(note));
      } catch (err) {
        console.error(errorColor(err instanceof Error ? err.message : String(err)));
        process.exit(err instanceof MoveOverError || err instanceof FrontDoorConfigError ? 78 : 1);
      }
    });
}

export function wikisCommand(): Command {
  return new Command('wikis')
    .description(
      'Move a single-wiki volume into the several-wiki layout and back (GitQuire container)',
    )
    .addCommand(
      moveCommand(
        'adopt',
        'Move the single wiki in the volume (GITQUIRE_REPO) behind the front door as its first wiki',
      ),
    )
    .addCommand(
      moveCommand(
        'unadopt',
        'Move the one wiki behind the front door back into a single-wiki volume',
      ),
    );
}
