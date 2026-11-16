#!/usr/bin/env node

import './adopt-legacy-env.ts';

if (process.argv.includes('--no-color')) {
  process.env.NO_COLOR = '1';
  delete process.env.FORCE_COLOR;
} else if (process.argv.includes('--color')) {
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
}

trustSystemCertificates();

import { homedir } from 'node:os';
import {
  currentCliCommandName,
  currentDesktopProduct,
  formatIgnoredCommittedKey,
  humanFormat,
} from '@gitquire/core';
import {
  type Config,
  describeLegacyDataFolderMigration,
  findLegacyProjectRoot,
  loggerFactory,
  migrateLegacyDataFolders,
  migrateLegacyHomeFolder,
  trustSystemCertificates,
} from '@gitquire/server';
import { Command } from 'commander';
import { getCliLogger, initCliLogger } from './cli-logger.ts';
import { auditCommand } from './commands/audit.ts';
import { authCommand } from './commands/auth/index.ts';
import { bugReportCommand } from './commands/bug-report.ts';
import { cleanCommand } from './commands/clean.ts';
import { cloneCommand } from './commands/clone.ts';
import { commentsCommand } from './commands/comments.ts';
import { configCommand, shouldAnnounceRemovedKeys } from './commands/config.ts';
import { diagnoseCommand } from './commands/diagnose.ts';
import { embeddingsCommand } from './commands/embeddings/index.ts';
import { gitquireBootstrapCommand } from './commands/gitquire-bootstrap.ts';
import { initCommand } from './commands/init.ts';
import { lintCommand } from './commands/lint.ts';
import { migrateCommand } from './commands/migrate.ts';
import { previewCommand } from './commands/preview.ts';
import { psCommand } from './commands/ps.ts';
import { pullCommand } from './commands/pull.ts';
import { pushCommand } from './commands/push.ts';
import { seedCommand } from './commands/seed.ts';
import { shareCommand } from './commands/share/index.ts';
import { sharingCommand } from './commands/sharing/index.ts';
import { runStartCommand, startCommand } from './commands/start.ts';
import { statusCommand } from './commands/status.ts';
import { stopCommand } from './commands/stop.ts';
import { syncCommand } from './commands/sync.ts';
import { PACKAGE_VERSION } from './constants.ts';
import { loadConfig } from './index.ts';
import { legacyCommandNotice } from './legacy-command-name.ts';
import { recordInvocationCwd, resolveProjectAnchor } from './project-anchor.ts';
import { buildVersionNotice } from './version-notice.ts';

const legacyNotice = legacyCommandNotice(process.argv[1]);
if (legacyNotice !== null) process.stderr.write(legacyNotice);

const program = new Command();

let resolvedConfig: Config;

program
  .name(currentDesktopProduct().cliCommandNames[1])
  .description('Local-first knowledge base with CRDT collaboration')
  .usage('[options] [command]')
  .version(buildVersionNotice(PACKAGE_VERSION))
  .option('--cwd <path>', 'Working directory')
  .option(
    '--log-level <level>',
    'Log level: silent, error, warn, info (default), debug, trace',
    'info',
  )
  .option('--no-color', 'Disable color output')
  .option('--color', 'Force color output')
  .hook('preAction', (thisCommand, actionCommand) => {
    const opts = thisCommand.opts();
    const cwd = opts.cwd as string | undefined;
    if (cwd !== undefined) {
      process.chdir(cwd);
    }

    if (program.getOptionValueSource('logLevel') === 'cli') {
      const level = String(program.opts().logLevel);
      process.env.LOG_LEVEL = level;
      process.env.GITQUIRE_CONSOLE_LEVEL = level;
    }

    const actionOpts = actionCommand.opts<{ json?: boolean }>();
    const actionName = actionCommand.name();
    if (
      actionOpts.json === true &&
      (actionName === 'clone' ||
        actionName === 'init' ||
        (actionName === 'status' && actionCommand.parent?.name() === 'embeddings'))
    ) {
      loggerFactory.configure({ pinoConfig: { consoleDestination: 2 } });
    }

    const subcommandName = thisCommand.args?.[0];
    const legacyRoot = findLegacyProjectRoot(process.cwd());
    const migrations = [
      migrateLegacyHomeFolder(homedir()),
      ...(legacyRoot === null ? [] : [migrateLegacyDataFolders(legacyRoot)]),
    ];
    for (const line of migrations.flatMap(describeLegacyDataFolderMigration)) {
      console.error(`[gitquire] ${line}`);
    }
    const anchorRoot = resolveProjectAnchor(subcommandName, process.cwd());
    if (anchorRoot !== null) {
      recordInvocationCwd(process.cwd());
      process.chdir(anchorRoot);
      console.error(`[gitquire] Using GitQuire project at ${anchorRoot}`);
    }

    const loaded = loadConfig(anchorRoot ?? cwd);
    const config: Config = loaded.config;
    if (shouldAnnounceRemovedKeys(subcommandName)) {
      for (const diagnostic of loaded.diagnostics) {
        if (diagnostic.code !== 'REMOVED_KEY') continue;
        console.error(`[gitquire] ${humanFormat(diagnostic)}`);
      }
    }
    for (const key of loaded.ignoredCommittedKeys) {
      console.error(`[gitquire] ${formatIgnoredCommittedKey(key)}`);
    }
    resolvedConfig = config;

    const commandName = thisCommand.args?.[0] ?? thisCommand.name() ?? 'cli';
    initCliLogger({
      command: commandName,
      cwd: process.cwd(),
      configuredProjectName: (config as { project?: { name?: string } }).project?.name ?? undefined,
    });
  });

program.action(async () => {
  await runStartCommand(resolvedConfig, {});
});

const start = startCommand(() => resolvedConfig);
program.addCommand(start);

program.addCommand(initCommand());

program.addCommand(seedCommand());

program.addCommand(migrateCommand());

const preview = previewCommand(() => resolvedConfig);
program.addCommand(preview);

program.addCommand(lintCommand(() => resolvedConfig));

program.addCommand(commentsCommand(() => resolvedConfig));

program.addCommand(auditCommand(() => resolvedConfig));

const uiTombstone = new Command('ui')
  .description(`Removed: the editor UI is served by \`${currentCliCommandName()} start\``)
  .allowUnknownOption()
  .allowExcessArguments()
  .argument('[args...]')
  .action(() => {
    console.error(
      `\`${currentCliCommandName()} ui\` was removed — the editor UI is served by the project server. Run \`${currentCliCommandName()} start\` instead.`,
    );
    process.exit(1);
  });
program.addCommand(uiTombstone, { hidden: true });

program.addCommand(stopCommand(() => resolvedConfig));
program.addCommand(cleanCommand(() => resolvedConfig));
program.addCommand(statusCommand(() => resolvedConfig));

program.addCommand(gitquireBootstrapCommand(), { hidden: true });

program.addCommand(psCommand());

program.addCommand(diagnoseCommand());

program.addCommand(bugReportCommand());

program.addCommand(configCommand());

program.addCommand(authCommand(getCliLogger));

program.addCommand(embeddingsCommand());

program.addCommand(cloneCommand(() => resolvedConfig));

program.addCommand(syncCommand(() => resolvedConfig));
program.addCommand(pushCommand(() => resolvedConfig));
program.addCommand(pullCommand(() => resolvedConfig));

program.addCommand(shareCommand());

program.addCommand(sharingCommand());

await program.parseAsync(process.argv, { from: 'node' });
