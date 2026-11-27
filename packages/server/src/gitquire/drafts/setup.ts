import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import type { GateLogger, SessionUser } from '../access-gate.ts';
import { markDraftsAvailable } from '../edit-destination.ts';
import type { GitHubAppConfig } from '../github-app.ts';
import type { GitHubDraftsClient } from '../github-pulls.ts';
import type { HostKind } from '../host/types.ts';
import { internalRequestHeaders, internalSecret } from '../internal-request.ts';
import { migrateLegacyDataFolders } from '../legacy-data-folder.ts';
import {
  DEFAULT_PROCESS_HEAP_MB,
  ProcessHeapSettingError,
  processHeapMb,
} from '../process-pool/pool.ts';
import {
  authHeaderEnv,
  ensureAutoSyncMode,
  parseAutoSyncMode,
  type RunGit,
  runGitSync,
} from '../repo-bootstrap.ts';
import { type RepoPin, withGitConfig } from '../repo-pin.ts';
import { createDraftsHttp, type DraftsHttp } from './http.ts';
import { createDraftInstances, DRAFT_INSTANCE_ENV, type DraftInstances } from './instances.ts';
import { type DraftRecord, isOpen } from './model.ts';
import { type DraftRemote, forgejoRemote, gitHubRemote, plainGitRemote } from './remote.ts';
import { createDraftService, type DraftService } from './service.ts';
import { createDraftStore, draftsDir, draftsStatePath } from './store.ts';

type Env = Readonly<Record<string, string | undefined>>;

const FOLLOW_REMOTE_MS = 2 * 60 * 1000;
const PROJECT_FILES = ['.gitquire/config.yml', '.okignore'];

export interface DraftsSetupDeps {
  liveServer?: LiveServerHandle;
  repoPin?: RepoPin;
  env: Env;
  projectDir: string;
  log: GateLogger;
  sessionUser: (req: IncomingMessage) => SessionUser | undefined;
  agentOwner: (req: IncomingMessage) => SessionUser | undefined;
  secure: boolean;
  behindFrontDoor?: boolean;
  appConfig: RepoSyncConfig | undefined;
  client: GitHubDraftsClient | undefined;
  token: () => string | undefined;
  cli: readonly string[];
  initProject: (dir: string) => void;
  runGit?: RunGit;
}

export interface RepoSyncConfig extends Pick<GitHubAppConfig, 'repo' | 'branch' | 'gitHost'> {
  host: HostKind;
  webUrl: string;
}

export interface Drafts {
  http: DraftsHttp;
  service: DraftService;
  instances: DraftInstances;
  stop: () => Promise<void>;
}

export interface LiveServerHandle {
  current?: { pull: () => Promise<unknown>; reread: () => Promise<unknown> };
}

function pullLiveSoon(env: Env, live: LiveServerHandle | undefined): void {
  const inProcess = live?.current;
  if (inProcess !== undefined) {
    void inProcess.pull().catch(() => undefined);
    return;
  }
  const port = Number(env.PORT ?? '') || 8080;
  fetch(`http://127.0.0.1:${port}/api/sync/trigger`, {
    method: 'POST',
    headers: { ...internalRequestHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'pull' }),
  }).catch(() => undefined);
}

function rereadLiveSoon(env: Env, live: LiveServerHandle | undefined): void {
  const inProcess = live?.current;
  if (inProcess !== undefined) {
    void inProcess.reread().catch(() => undefined);
    return;
  }
  const port = Number(env.PORT ?? '') || 8080;
  fetch(`http://127.0.0.1:${port}/api/documents/reread`, {
    method: 'POST',
    headers: { ...internalRequestHeaders(), 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => undefined);
}

export const DRAFT_IDLE_ENV = 'GITQUIRE_DRAFT_IDLE_MINUTES';
const DEFAULT_DRAFT_IDLE_MINUTES = 30;
const DRAFT_CLOSED_IDLE_MINUTES = 10;

export function draftIdle(env: Env, log: GateLogger): { idleMs: number; closedIdleMs: number } {
  const raw = env[DRAFT_IDLE_ENV]?.trim();
  let minutes = DEFAULT_DRAFT_IDLE_MINUTES;
  if (raw !== undefined && raw !== '') {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0.01 && value <= 1440) minutes = value;
    else log.warn({ value: raw }, `[gitquire-drafts] ${DRAFT_IDLE_ENV} refused, using 30`);
  }
  const idleMs = Math.round(minutes * 60_000);
  return { idleMs, closedIdleMs: Math.min(idleMs, DRAFT_CLOSED_IDLE_MINUTES * 60_000) };
}

export function draftHeapMb(env: Env, log: GateLogger): number | undefined {
  try {
    return processHeapMb(env);
  } catch (err) {
    if (!(err instanceof ProcessHeapSettingError)) throw err;
    log.warn({ err }, '[gitquire-drafts] heap setting refused, using the default');
    return DEFAULT_PROCESS_HEAP_MB;
  }
}

export function isDraftInstance(env: Env): boolean {
  const value = env[DRAFT_INSTANCE_ENV];
  return value !== undefined && value.trim() !== '';
}

export function pinnedRemote(remote: DraftRemote, beforeRemote: () => Promise<void>): DraftRemote {
  const first =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await beforeRemote();
      return call(...args);
    };
  return {
    kind: remote.kind,
    headSha: first(remote.headSha),
    createBranch: first(remote.createBranch),
    deleteBranch: first(remote.deleteBranch),
    openReview: first(remote.openReview),
    publish: first(remote.publish),
    close: first(remote.close),
    closedElsewhere: first(remote.closedElsewhere),
    pullUrl: remote.pullUrl,
  };
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
  const pin = deps.repoPin;
  const authEnv = (): Record<string, string> => {
    const token = deps.token();
    const auth =
      deps.appConfig === undefined || token === undefined
        ? {}
        : authHeaderEnv(deps.appConfig.gitHost, token);
    return pin === undefined ? auth : withGitConfig(auth, pin.current());
  };
  const beforeRemote = async (): Promise<void> => {
    await pin?.refresh();
  };
  const hostRemote: DraftRemote =
    deps.appConfig !== undefined && deps.client !== undefined
      ? deps.appConfig.host === 'forgejo'
        ? forgejoRemote(deps.client, deps.appConfig.repo, deps.appConfig.webUrl, {
            projectDir: deps.projectDir,
            runGit,
            authEnv,
          })
        : gitHubRemote(deps.client, deps.appConfig.repo, deps.appConfig.webUrl, {
            projectDir: deps.projectDir,
            runGit,
            authEnv,
          })
      : plainGitRemote(deps.projectDir, runGit, authEnv);
  const remote = pin === undefined ? hostRemote : pinnedRemote(hostRemote, beforeRemote);
  const syncMode = parseAutoSyncMode(deps.env.GITQUIRE_SYNC_MODE);

  async function prepare(draft: DraftRecord, dir: string): Promise<void> {
    await beforeRemote();
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
    migrateLegacyDataFolders(dir);
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
    behindFrontDoor: deps.behindFrontDoor,
    heapMb: draftHeapMb(deps.env, deps.log),
    ...draftIdle(deps.env, deps.log),
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
    beforeRemote,
    baseBranch,
    log: deps.log,
    onPublished: () => pullLiveSoon(deps.env, deps.liveServer),
    onLiveFilesChanged: () => rereadLiveSoon(deps.env, deps.liveServer),
  });
  const http = createDraftsHttp({
    service,
    instances,
    sessionUser: deps.sessionUser,
    agentOwner: deps.agentOwner,
    secure: deps.secure,
    behindFrontDoor: deps.behindFrontDoor,
    log: deps.log,
  });
  const follow = setInterval(() => {
    service.followRemote().catch(() => undefined);
  }, FOLLOW_REMOTE_MS);
  follow.unref();
  markDraftsAvailable();
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
