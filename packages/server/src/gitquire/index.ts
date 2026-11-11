import type { AccessGate, GateLogger } from './access-gate.ts';
import { createAccessGate } from './access-gate.ts';
import { resolveGitHubAuthConfig } from './github-auth-config.ts';

export type { AccessGate, SessionUser } from './access-gate.ts';
export { noreplyEmail } from './access-gate.ts';
export { GitHubAuthConfigError } from './github-auth-config.ts';

export function createAccessGateFromEnv(
  env: Readonly<Record<string, string | undefined>>,
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
