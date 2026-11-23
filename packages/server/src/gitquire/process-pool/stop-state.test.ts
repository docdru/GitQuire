import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { internalRequestHeaders } from '../internal-request.ts';
import { runGitSync } from '../repo-bootstrap.ts';
import { createStopStateRoute, projectStopState } from './stop-state.ts';

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  execFileSync('git', [...IDENTITY, ...args], { cwd, stdio: 'pipe' });
}

function wiki(withRemote: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'gq-stop-state-'));
  roots.push(root);
  const dir = join(root, 'wiki');
  git(['init', '--quiet', '--initial-branch=main', dir], root);
  writeFileSync(join(dir, 'a.md'), '# A\n');
  git(['add', '-A'], dir);
  git(['commit', '--quiet', '-m', 'a'], dir);
  if (withRemote) {
    git(['init', '--quiet', '--bare', '--initial-branch=main', join(root, 'origin.git')], root);
    git(['remote', 'add', 'origin', join(root, 'origin.git')], dir);
    git(['push', '--quiet', '-u', 'origin', 'main'], dir);
  }
  return dir;
}

const noChildren = async () => ({ pushedAndClean: true });

describe('pushed and clean', () => {
  it('is true for a pushed wiki with nothing changed', async () => {
    const dir = wiki(true);
    expect(await projectStopState(dir, runGitSync, noChildren)).toEqual({
      pushedAndClean: true,
      clean: true,
      pushed: true,
      children: true,
    });
  });

  it('is false while a file is changed', async () => {
    const dir = wiki(true);
    writeFileSync(join(dir, 'a.md'), '# A, changed\n');
    expect(await projectStopState(dir, runGitSync, noChildren)).toMatchObject({
      pushedAndClean: false,
      clean: false,
    });
  });

  it('is false while a commit is not pushed', async () => {
    const dir = wiki(true);
    writeFileSync(join(dir, 'b.md'), '# B\n');
    git(['add', '-A'], dir);
    git(['commit', '--quiet', '-m', 'b'], dir);
    expect(await projectStopState(dir, runGitSync, noChildren)).toMatchObject({
      pushedAndClean: false,
      clean: true,
      pushed: false,
    });
  });

  it('counts a wiki without a remote as pushed', async () => {
    const dir = wiki(false);
    expect(await projectStopState(dir, runGitSync, noChildren)).toMatchObject({
      pushedAndClean: true,
    });
  });

  it('waits for its drafts', async () => {
    const dir = wiki(true);
    const dirty = await projectStopState(dir, runGitSync, async () => ({ pushedAndClean: false }));
    expect(dirty).toMatchObject({ pushedAndClean: false, children: false });
    const unknown = await projectStopState(dir, runGitSync, async () => undefined);
    expect(unknown).toMatchObject({ pushedAndClean: false, children: null });
  });
});

describe('stop-state route', () => {
  function call(headers: Record<string, string>, method = 'GET') {
    const out = { status: 0, body: '' };
    const done = Promise.withResolvers<void>();
    const res = {
      writeHead(status: number) {
        out.status = status;
        return res;
      },
      end(body: string) {
        out.body = body;
        done.resolve();
      },
    } as unknown as ServerResponse;
    const req = { url: '/api/gitquire/stop-state', method, headers } as IncomingMessage;
    const route = createStopStateRoute(async () => ({
      pushedAndClean: true,
      clean: true,
      pushed: true,
      children: true,
    }));
    const handled = route(req, res);
    return { handled, out, done: done.promise };
  }

  it('answers only internal requests', async () => {
    const outside = call({});
    await outside.done;
    expect(outside.out.status).toBe(403);
    const inside = call(internalRequestHeaders());
    await inside.done;
    expect(inside.out.status).toBe(200);
    expect(JSON.parse(inside.out.body)).toMatchObject({ pushedAndClean: true });
  });
});
