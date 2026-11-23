import { describe, expect, it } from 'vitest';
import { createForgejoPullsClient } from './forgejo-pulls.ts';

const API = 'https://git.example.org/api/v1';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function client(answers: (call: Call) => { status: number; body?: unknown }, calls: Call[] = []) {
  return createForgejoPullsClient(
    { owner: 'team', name: 'wiki' },
    {
      token: () => 'limited',
      apiUrl: API,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const call: Call = {
          method: init?.method ?? 'GET',
          path: String(input).replace(API, ''),
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        };
        expect(new Headers(init?.headers).get('authorization')).toBe('token limited');
        calls.push(call);
        const answer = answers(call);
        return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
          status: answer.status,
        });
      }) as typeof fetch,
      retry: { delaysMs: [] },
    },
  );
}

const PULL = {
  number: 4,
  title: 'Notes',
  html_url: 'https://git.example.org/team/wiki/pulls/4',
  head: { ref: 'gitquire/draft/notes', sha: 'h1' },
  base: { ref: 'main' },
  user: { login: 'gitquire-bot' },
  updated_at: '2026-11-21T00:00:00Z',
};

describe('Forgejo pulls client', () => {
  it('opens a pull request and reads branches through the Forgejo API', async () => {
    const calls: Call[] = [];
    const forgejo = client((call) => {
      if (call.method === 'POST' && call.path === '/repos/team/wiki/pulls') {
        return { status: 201, body: PULL };
      }
      if (call.path === '/repos/team/wiki/branches/gitquire/draft/notes') {
        return { status: 200, body: { commit: { id: 'abc' } } };
      }
      return { status: 404 };
    }, calls);
    const pull = await forgejo.createPullRequest({
      title: 'Notes',
      body: 'b',
      head: 'gitquire/draft/notes',
      base: 'main',
    });
    expect(pull.number).toBe(4);
    expect(calls[0]?.body).toEqual({
      title: 'Notes',
      body: 'b',
      head: 'gitquire/draft/notes',
      base: 'main',
    });
    expect(await forgejo.branchSha('gitquire/draft/notes')).toBe('abc');
    expect(await forgejo.branchSha('gone')).toBeUndefined();
  });

  it('filters merged pull requests by head branch itself (stage 0: the head filter is ignored)', async () => {
    const forgejo = client(() => ({
      status: 200,
      body: [
        { ...PULL, merged: true },
        { ...PULL, merged: true, head: { ref: 'other', sha: 'h2' } },
        { ...PULL, merged: false, head: { ref: 'gitquire/draft/notes', sha: 'h3' } },
      ],
    }));
    expect(await forgejo.mergedPullHeads?.('gitquire/draft/notes')).toEqual(['h1']);
  });

  it('deletes branches and lists collaborators', async () => {
    const calls: Call[] = [];
    const forgejo = client((call) => {
      if (call.method === 'DELETE') return { status: 204 };
      return {
        status: 200,
        body: [{ id: 1, login: 'alice', avatar_url: 'https://a/1' }, { login: 'broken' }],
      };
    }, calls);
    await forgejo.deleteBranch('gitquire/draft/notes');
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      path: '/repos/team/wiki/branches/gitquire/draft/notes',
    });
    expect(await forgejo.collaborators?.()).toEqual([
      { id: 1, login: 'alice', avatarUrl: 'https://a/1' },
    ]);
  });
});
