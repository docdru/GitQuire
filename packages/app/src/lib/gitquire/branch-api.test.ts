import { describe, expect, test } from 'vitest';
import { GitQuireApiError, gitquireRequest } from './branch-api';

function answer(status: number, body: unknown) {
  return (async () =>
    new Response(body === undefined ? '' : JSON.stringify(body), { status })) as typeof fetch;
}

describe('gitquireRequest', () => {
  test('returns the parsed body', async () => {
    await expect(gitquireRequest('/x', {}, { fetch: answer(200, { ok: 1 }) })).resolves.toEqual({
      ok: 1,
    });
  });

  test('turns an error answer into a GitQuireApiError with its code and message', async () => {
    const failing = gitquireRequest(
      '/x',
      {},
      {
        fetch: answer(409, { error: 'conflict', message: 'Update first.' }),
      },
    );
    await expect(failing).rejects.toBeInstanceOf(GitQuireApiError);
    await expect(failing).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'Update first.',
    });
  });

  test('falls back to the HTTP status when the body has no code', async () => {
    await expect(
      gitquireRequest('/x', {}, { fetch: answer(500, undefined) }),
    ).rejects.toMatchObject({
      code: 'http-500',
    });
  });
});
