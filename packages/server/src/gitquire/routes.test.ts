import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { GitHubUnavailableError } from './github-app.ts';
import type {
  CreatePullRequestInput,
  GitHubPullsClient,
  PullRequestSummary,
} from './github-pulls.ts';
import { createGitQuireRoutes, isSameOrigin, validateBranchName } from './routes.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

interface Captured {
  status: number | undefined;
  body: Record<string, unknown>;
  done: Promise<void>;
  res: ServerResponse;
}

function capture(): Captured {
  const { promise, resolve } = Promise.withResolvers<void>();
  const state: Captured = {
    status: undefined,
    body: {},
    done: promise,
    res: undefined as unknown as ServerResponse,
  };
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number) {
      state.status = status;
      res.headersSent = true;
      return res;
    },
    end(chunk?: string) {
      if (chunk !== undefined) state.body = JSON.parse(chunk);
      res.writableEnded = true;
      resolve();
      return res;
    },
  };
  state.res = res as unknown as ServerResponse;
  return state;
}

function request(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): IncomingMessage {
  const chunks = init.body === undefined ? [] : [Buffer.from(JSON.stringify(init.body))];
  return {
    url,
    method: init.method ?? 'GET',
    headers: { host: 'brain.example.com', ...init.headers },
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  } as unknown as IncomingMessage;
}

interface FakeRepo {
  head: string;
  local: string[];
  remote: string[];
  created: string[][];
}

function fakeGit(repo: FakeRepo) {
  return (args: readonly string[]): string => {
    if (args[0] === 'symbolic-ref') return `${repo.head}\n`;
    if (args[0] === 'for-each-ref' && args[2] === 'refs/heads') {
      return repo.local.map((b) => `refs/heads/${b}`).join('\n');
    }
    if (args[0] === 'for-each-ref' && args[2] === 'refs/remotes/origin') {
      const remote = repo.remote.map((b) => `refs/remotes/origin/${b}`);
      return ['refs/remotes/origin/HEAD', ...remote].join('\n');
    }
    if (args[0] === 'branch') {
      repo.created.push([...args]);
      return '';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function fakePulls(options: { pushed?: boolean; unavailable?: boolean } = {}) {
  const created: CreatePullRequestInput[] = [];
  const client: GitHubPullsClient = {
    async defaultBranch() {
      return 'main';
    },
    async listOpenPullRequests() {
      if (options.unavailable) throw new GitHubUnavailableError('GitHub answered HTTP 503.');
      return [];
    },
    async branchExists() {
      return options.pushed ?? true;
    },
    async createPullRequest(input): Promise<PullRequestSummary> {
      created.push(input);
      return {
        number: 7,
        title: input.title,
        url: 'https://github.com/acme/notes/pull/7',
        head: input.head,
        base: input.base,
        draft: input.draft ?? false,
        author: 'gitquire[bot]',
        updatedAt: '2026-11-11T12:00:00Z',
      };
    },
  };
  return { client, created };
}

function routesFor(repo: FakeRepo, pulls?: GitHubPullsClient, login: string | undefined = 'alice') {
  return createGitQuireRoutes({
    projectDir: '/data',
    log: silentLog,
    pulls,
    runGit: fakeGit(repo),
    sessionUser: () =>
      login === undefined ? undefined : { id: 42, login, name: 'Alice', avatarUrl: '' },
  });
}

async function call(
  routes: ReturnType<typeof createGitQuireRoutes>,
  req: IncomingMessage,
): Promise<Captured> {
  const out = capture();
  expect(routes.handle(req, out.res)).toBe(true);
  await out.done;
  return out;
}

const baseRepo = (): FakeRepo => ({
  head: 'main',
  local: ['main'],
  remote: ['main', 'report/q3'],
  created: [],
});

describe('validateBranchName', () => {
  it.each(['report/q4-results', 'fix_typo', 'v1.2'])('accepts %s', (name) => {
    expect(validateBranchName(name)).toBe(name);
  });

  it.each(['', ' ', '-flag', 'a..b', 'a//b', 'trail/', 'x.lock', 'a@{b', 'has space', 'end.'])(
    'rejects %j',
    (name) => {
      expect(() => validateBranchName(name)).toThrow();
    },
  );
});

describe('isSameOrigin', () => {
  it('compares the Origin host with the Host header', () => {
    expect(isSameOrigin(request('/', { headers: { origin: 'https://brain.example.com' } }))).toBe(
      true,
    );
    expect(isSameOrigin(request('/', { headers: { origin: 'https://evil.example' } }))).toBe(false);
    expect(isSameOrigin(request('/'))).toBe(true);
  });
});

describe('GitQuire routes', () => {
  it('ignores other paths', () => {
    expect(routesFor(baseRepo()).handle(request('/api/config'), capture().res)).toBe(false);
  });

  it('lists local and remote-only branches', async () => {
    const routes = routesFor(baseRepo(), fakePulls().client);
    const out = await call(routes, request('/api/gitquire/branches'));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      current: 'main',
      base: 'main',
      local: ['main'],
      remoteOnly: ['report/q3'],
      github: true,
    });
  });

  it('creates a branch from the current state', async () => {
    const repo = baseRepo();
    const out = await call(
      routesFor(repo),
      request('/api/gitquire/branches', { method: 'POST', body: { name: 'report/q4' } }),
    );
    expect(out.status).toBe(201);
    expect(repo.created).toEqual([['branch', '--no-track', 'report/q4', 'HEAD']]);
  });

  it('creates a branch from a remote-only branch', async () => {
    const repo = baseRepo();
    await call(
      routesFor(repo),
      request('/api/gitquire/branches', {
        method: 'POST',
        body: { name: 'report/q3-edit', from: 'report/q3' },
      }),
    );
    expect(repo.created).toEqual([
      ['branch', '--no-track', 'report/q3-edit', 'refs/remotes/origin/report/q3'],
    ]);
  });

  it('refuses an existing branch name and cross-origin posts', async () => {
    const routes = routesFor(baseRepo());
    const exists = await call(
      routes,
      request('/api/gitquire/branches', { method: 'POST', body: { name: 'main' } }),
    );
    expect(exists.status).toBe(409);
    expect(exists.body.error).toBe('branch-exists');
    const cross = await call(
      routes,
      request('/api/gitquire/branches', {
        method: 'POST',
        body: { name: 'x' },
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(cross.status).toBe(403);
  });

  it('reports a branch created concurrently as already existing', async () => {
    const repo = baseRepo();
    const git = fakeGit(repo);
    const routes = createGitQuireRoutes({
      projectDir: '/data',
      log: silentLog,
      runGit: (args) => {
        if (args[0] === 'branch') {
          repo.local.push('report/race');
          throw new Error('fatal: a branch named report/race already exists');
        }
        return git(args);
      },
    });
    const out = await call(
      routes,
      request('/api/gitquire/branches', { method: 'POST', body: { name: 'report/race' } }),
    );
    expect(out.status).toBe(409);
    expect(out.body.error).toBe('branch-exists');
  });

  it('reports pull requests as not configured without the GitHub App', async () => {
    const routes = routesFor(baseRepo());
    const list = await call(routes, request('/api/gitquire/pulls'));
    expect(list.body).toEqual({ configured: false, pulls: [] });
    const create = await call(
      routes,
      request('/api/gitquire/pulls', { method: 'POST', body: { title: 'Q4 report' } }),
    );
    expect(create.status).toBe(501);
  });

  it('opens a pull request from the current branch with attribution', async () => {
    const repo = { ...baseRepo(), head: 'report/q4', local: ['main', 'report/q4'] };
    const { client, created } = fakePulls();
    const out = await call(
      routesFor(repo, client),
      request('/api/gitquire/pulls', {
        method: 'POST',
        body: { title: ' Q4 report ', body: 'Numbers for review.', draft: true },
      }),
    );
    expect(out.status).toBe(201);
    expect(created).toEqual([
      {
        title: 'Q4 report',
        body: 'Numbers for review.\n\n---\nProposed by @alice in GitQuire.',
        head: 'report/q4',
        base: 'main',
        draft: true,
      },
    ]);
    expect((out.body.pull as PullRequestSummary).number).toBe(7);
  });

  it('refuses a pull request from the base branch or an unpushed branch', async () => {
    const onMain = await call(
      routesFor(baseRepo(), fakePulls().client),
      request('/api/gitquire/pulls', { method: 'POST', body: { title: 'x' } }),
    );
    expect(onMain.body.error).toBe('same-branch');

    const repo = { ...baseRepo(), head: 'report/q4' };
    const unpushed = await call(
      routesFor(repo, fakePulls({ pushed: false }).client),
      request('/api/gitquire/pulls', { method: 'POST', body: { title: 'x' } }),
    );
    expect(unpushed.status).toBe(409);
    expect(unpushed.body.error).toBe('branch-not-pushed');
  });

  it('requires a title', async () => {
    const repo = { ...baseRepo(), head: 'report/q4' };
    const out = await call(
      routesFor(repo, fakePulls().client),
      request('/api/gitquire/pulls', { method: 'POST', body: { title: '  ' } }),
    );
    expect(out.status).toBe(400);
  });

  it('maps GitHub outages to 503', async () => {
    const out = await call(
      routesFor(baseRepo(), fakePulls({ unavailable: true }).client),
      request('/api/gitquire/pulls'),
    );
    expect(out.status).toBe(503);
    expect(out.body.error).toBe('github-unavailable');
  });
});
