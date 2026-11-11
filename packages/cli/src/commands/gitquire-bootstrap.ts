import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { initProjectWithCli, runGitQuireBootstrap } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { error as errorColor, success } from '../ui/colors.ts';

export function gitquireBootstrapCommand(): Command {
  return new Command('gitquire-bootstrap')
    .description(
      'Clone GITQUIRE_REPO into a directory with the GitHub App token and enable auto-sync (GitQuire container setup)',
    )
    .argument('[dir]', 'Project directory', '.')
    .action(async (dir: string) => {
      const target = resolve(dir);
      mkdirSync(target, { recursive: true });
      try {
        const result = await runGitQuireBootstrap(
          target,
          process.env,
          initProjectWithCli([process.execPath, process.argv[1] ?? '']),
        );
        console.log(result.configured ? success(result.message) : result.message);
      } catch (err) {
        console.error(errorColor(err instanceof Error ? err.message : String(err)));
        process.exit(78);
      }
    });
}
