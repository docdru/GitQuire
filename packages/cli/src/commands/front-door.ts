import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { FrontDoorConfigError, getLogger, startFrontDoor } from '@gitquire/server';
import { Command } from 'commander';
import { error as errorColor } from '../ui/colors.ts';

export function frontDoorCommand(): Command {
  return new Command('front-door')
    .description('Run the front door for the wikis (GitQuire container)')
    .argument('[dir]', 'Data directory', '.')
    .action(async (dir: string) => {
      const target = resolve(dir);
      mkdirSync(target, { recursive: true });
      try {
        const running = await startFrontDoor(target, process.env, {
          log: getLogger('front-door'),
          cli: [process.execPath, process.argv[1] ?? ''],
        });
        let stopping = false;
        const stop = (): void => {
          if (stopping) return;
          stopping = true;
          running.stop().then(
            () => process.exit(0),
            () => process.exit(1),
          );
        };
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);
      } catch (err) {
        console.error(errorColor(err instanceof Error ? err.message : String(err)));
        process.exit(err instanceof FrontDoorConfigError ? 78 : 1);
      }
    });
}
