import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import type { GateLogger, SessionUser } from '../access-gate.ts';
import type { GitHubAppConfig } from '../github-app.ts';
import type { GitHubDraftsClient } from '../github-pulls.ts';
import { internalRequestHeaders, internalSecret } from '../internal-request.ts';
import {
  authHeaderEnv,
  ensureAutoSyncMode,
  parseAutoSyncMode,
  type RunGit,
  runGitSync,
} from '../repo-bootstrap.ts';
import { createDraftsHttp, type DraftsHttp } from './http.ts';
import { createDraftInstances, DRAFT_INSTANCE_ENV, type DraftInstances } from './instances.ts';
import { type DraftRecord, isOpen } from './model.ts';
import { type DraftRemote, gitHubRemote, plainGitRemote } from './remote.ts';
import { createDraftService, type DraftService } from './service.ts';
import { createDraftStore, draftsDir, draftsStatePath } from './store.ts';

type Env = Readonly<Record<string, string | undefined>>;

const FOLLOW_REMOTE_MS = 2 * 60 * 1000;
const PROJECT_FILES = ['.ok/config.yml', '.okignore'];

export interface DraftsSetupDeps {
  env: Env;
  projectDir: string;
  log: GateLogger;
  sessionUser: (req: IncomingMessage) => SessionUser | undefined;
  agentOwner: (req: IncomingMessage) => SessionUser | undefined;
  secure: boolean;
  appConfig: GitHubAppConfig | undefined;
  client: GitHubDraftsClient | undefined;
  token: () => string | undefined;
  cli: readonly string[];
  initProject: (dir: string) => void;
  runGit?: RunGit;
}

export interface Drafts {
  http: DraftsHttp;
  service: DraftService;
  instances: DraftInstances;
  stop: () => Promise<void>;
}

function pullLiveSoon(env: Env): void {
  const port = Number(env.PORT ?? '') || 8080;
  fetch(`http://127.0.0.1:${port}/api/sync/trigger`, {
    method: 'POST',
    headers: { ...internalRequestHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'pull' }),
  }).catch(() => undefined);
}

export function isDraftInstance(env: Env): boolean {
  const value = env[DRAFT_INSTANCE_ENV];
  return value !== undefined && value.trim() !== '';
}

function hasOrigin(runGit: RunGit, dir: string): boolean {
  try {
    return runGit(['remote'], dir)
      .split('\n')
      .some((line) => line.trim() === 'origin');
  } catch {
    return false;
  }
}

export function createDrafts(deps: DraftsSetupDeps): Drafts | undefined {
  const runGit = deps.runGit ?? runGitSync;
  if (isDraftInstance(deps.env) || !hasOrigin(runGit, deps.projectDir)) return undefined;
  const authEnv = (): Record<string, string> => {
    const token = deps.token();
    return deps.appConfig === undefined || token === undefined
      ? {}
      : authHeaderEnv(deps.appConfig.gitHost, token);
  };
  const remote: DraftRemote =
    deps.appConfig !== undefined && deps.client !== undefined
      ? gitHubRemote(deps.client, deps.appConfig.repo)
      : plainGitRemote(deps.projectDir, runGit, authEnv);
  const syncMode = parseAutoSyncMode(deps.env.GITQUIRE_SYNC_MODE);

  async function prepare(draft: DraftRecord, dir: string): Promise<void> {
    mkdirSync(dir, { recursive: true });
    const origin = runGit(['remote', 'get-url', 'origin'], deps.projectDir).trim();
    runGit(
      [
        'clone',
        '--quiet',
        '--no-tags',
        '--single-branch',
        '--branch',
        draft.branch,
        '--reference-if-able',
        deps.projectDir,
        '--dissociate',
        origin,
        dir,
      ],
      deps.projectDir,
      authEnv(),
    );
    runGit(['config', 'fetch.prune', 'true'], dir);
    for (const file of PROJECT_FILES) {
      const source = join(deps.projectDir, file);
      const target = join(dir, file);
      if (existsSync(target) || !existsSync(source)) continue;
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      mkdirSync(join(dir, '.git', 'info'), { recursive: true });
      appendFileSync(join(dir, '.git', 'info', 'exclude'), `\n/${file}\n`);
    }
    deps.initProject(dir);
    ensureAutoSyncMode(dir, syncMode);
  }

  async function baseBranch(): Promise<string> {
    if (deps.appConfig?.branch !== undefined) return deps.appConfig.branch;
    if (deps.client !== undefined) return deps.client.defaultBranch();
    return runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], deps.projectDir).trim() || 'main';
  }

  const store = createDraftStore(draftsStatePath(deps.projectDir));
  const instances = createDraftInstances({
    baseDir: draftsDir(deps.projectDir, deps.env),
    projectName: basename(resolve(deps.projectDir)),
    cli: deps.cli,
    env: deps.env,
    internalSecret: internalSecret(),
    log: deps.log,
    prepare,
    stillOpen: (slug) => {
      const draft = store.get(slug);
      return draft !== undefined && isOpen(draft);
    },
  });
  const service = createDraftService({
    projectDir: deps.projectDir,
    store,
    instances,
    remote,
    runGit,
    authEnv,
    baseBranch,
    log: deps.log,
    onPublished: () => pullLiveSoon(deps.env),
  });
  const http = createDraftsHttp({
    service,
    instances,
    sessionUser: deps.sessionUser,
    agentOwner: deps.agentOwner,
    secure: deps.secure,
    log: deps.log,
  });
  const follow = setInterval(() => {
    service.followRemote().catch(() => undefined);
  }, FOLLOW_REMOTE_MS);
  follow.unref();
  deps.log.info({ remote: remote.kind }, '[gitquire-drafts] drafts are on');
  return {
    http,
    service,
    instances,
    stop: async () => {
      clearInterval(follow);
      await instances.stopAll();
    },
  };
}
