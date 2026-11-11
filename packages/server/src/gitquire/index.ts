import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectGhFn } from '../github-permissions.ts';
import type { AccessGate, GateLogger } from './access-gate.ts';
import { createAccessGate } from './access-gate.ts';
import {
  createGitHubAppClient,
  type InstallationTokenManager,
  resolveGitHubAppConfig,
  startInstallationTokenManager,
} from './github-app.ts';
import { resolveGitHubAuthConfig } from './github-auth-config.ts';
import { bootstrapRepository, ensureAutoSyncMode, parseAutoSyncMode } from './repo-bootstrap.ts';

export type { AccessGate, SessionUser } from './access-gate.ts';
export { noreplyEmail } from './access-gate.ts';
export { GitHubAppConfigError } from './github-app.ts';
export { GitHubAuthConfigError } from './github-auth-config.ts';

type Env = Readonly<Record<string, string | undefined>>;

export function createAccessGateFromEnv(
  env: Env,
  runtime: { externalUrl: string | undefined },
  log: GateLogger,
): AccessGate | undefined {
  const config = resolveGitHubAuthConfig(env, runtime);
  if (config === undefined) return undefined;
  const access =
    config.repo === undefined
      ? `allowed users: ${[...config.allowedUsers].join(', ')}`
      : `write access to ${config.repo.owner}/${config.repo.name}`;
  log.info(
    { externalUrl: config.externalUrl.toString(), mcpToken: config.mcpToken !== undefined },
    `[gitquire-auth] GitHub sign-in enabled (${access})`,
  );
  return createAccessGate(config, { log });
}

export async function startGitHubAppTokensFromEnv(
  env: Env,
  log: GateLogger,
): Promise<InstallationTokenManager | undefined> {
  const config = resolveGitHubAppConfig(env);
  if (config === undefined) return undefined;
  return startInstallationTokenManager(config, createGitHubAppClient(config), { log });
}

export function withGitHubAppToken(
  manager: InstallationTokenManager | undefined,
  detectGh: DetectGhFn | undefined,
): DetectGhFn | undefined {
  return manager === undefined ? detectGh : manager.wrapDetectGh(detectGh);
}

export interface GitQuireBootstrapResult {
  configured: boolean;
  message: string;
}

export async function runGitQuireBootstrap(
  dir: string,
  env: Env,
  initProject: (dir: string) => void,
): Promise<GitQuireBootstrapResult> {
  const config = resolveGitHubAppConfig(env);
  if (config === undefined) {
    return { configured: false, message: 'GitHub repository sync is not configured.' };
  }
  const syncMode = parseAutoSyncMode(env.GITQUIRE_SYNC_MODE);
  const outcome = await bootstrapRepository(dir, config, createGitHubAppClient(config));
  if (!existsSync(join(dir, '.ok'))) initProject(dir);
  const sync = ensureAutoSyncMode(dir, syncMode);
  const repo = `${config.repo.owner}/${config.repo.name}`;
  const what =
    outcome.action === 'cloned'
      ? `Cloned ${repo} (${outcome.branch})`
      : outcome.action === 'initialized-empty'
        ? `${repo} is empty; started branch ${outcome.branch}`
        : `Using the existing checkout of ${repo}`;
  const syncNote =
    sync === 'written' ? `sync mode set to ${syncMode}` : 'sync mode kept from local config';
  return { configured: true, message: `${what}; ${syncNote}.` };
}

export function initProjectWithCli(cliArgs: readonly string[]): (dir: string) => void {
  return (dir) => {
    execFileSync(
      cliArgs[0] ?? process.execPath,
      [...cliArgs.slice(1), 'init', '--no-mcp', '--no-skills', '--local-only'],
      { cwd: dir, stdio: 'inherit' },
    );
  };
}
