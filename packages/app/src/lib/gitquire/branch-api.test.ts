import { describe, expect, test } from 'vitest';
import { GitQuireApiError, openPullRequest } from './branch-api';

function answers(list: Array<{ status: number; body: unknown }>) {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    const next = list.shift();
    if (next === undefined) throw new Error('no more answers');
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { fetch: impl as typeof fetch, calls };
}

const notPushed = { status: 409, body: { error: 'branch-not-pushed', message: 'not yet' } };
const pull = {
  number: 9,
  title: 'Q4',
  url: 'https://github.com/acme/notes/pull/9',
  head: 'report/q4',
  base: 'main',
  draft: false,
  author: 'gitquire[bot]',
  updatedAt: '',
};

describe('openPullRequest', () => {
  test('pushes first and retries until the branch reaches GitHub', async () => {
    const { fetch, calls } = answers([notPushed, notPushed, { status: 201, body: { pull } }]);
    const sleeps: number[] = [];
    let pushed = 0;
    const result = await openPullRequest(
      { title: 'Q4', body: '', draft: false },
      {
        fetch,
        push: async () => {
          pushed += 1;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        pushWaitsMs: [10, 20, 30],
      },
    );
    expect(result.number).toBe(9);
    expect(pushed).toBe(1);
    expect(sleeps).toEqual([10, 20]);
    expect(calls).toEqual(Array(3).fill('POST /api/gitquire/pulls'));
  });

  test('gives up after the last wait', async () => {
    const { fetch } = answers([notPushed, notPushed]);
    const attempt = openPullRequest(
      { title: 'Q4', body: '', draft: false },
      { fetch, sleep: async () => {}, pushWaitsMs: [1] },
    );
    await expect(attempt).rejects.toMatchObject({ code: 'branch-not-pushed', status: 409 });
  });

  test('surfaces other errors at once', async () => {
    const { fetch } = answers([
      { status: 409, body: { error: 'same-branch', message: 'You are on main.' } },
    ]);
    const attempt = openPullRequest({ title: 'x', body: '', draft: false }, { fetch });
    await expect(attempt).rejects.toBeInstanceOf(GitQuireApiError);
    await expect(attempt).rejects.toThrow('You are on main.');
  });
});
