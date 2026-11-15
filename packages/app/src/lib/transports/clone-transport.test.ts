import { DEV_FALLBACK_CLI_REFUSAL } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { httpCloneTransport } from './clone-transport';

describe('httpCloneTransport — a refused request', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function firstEventFor(problem: Record<string, unknown>, status: number) {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ status, ...problem }), { status }),
    ) as unknown as typeof fetch;
    const handle = httpCloneTransport().start({ url: 'https://github.com/o/r.git', dir: '/tmp/r' });
    for await (const event of handle.events) return event;
    return undefined;
  }

  test('shows the problem detail, so the dev-build refusal keeps its remedy', async () => {
    expect(
      await firstEventFor(
        {
          type: 'urn:ok:error:clone-failed',
          title: 'This dev build has no built CLI.',
          detail: DEV_FALLBACK_CLI_REFUSAL,
        },
        409,
      ),
    ).toEqual({ type: 'error', message: `Clone failed: ${DEV_FALLBACK_CLI_REFUSAL}` });
  });

  test('keeps the title when the problem carries no detail', async () => {
    expect(
      await firstEventFor(
        { type: 'urn:ok:error:url-not-allowed', title: 'URL protocol is not allowed for clone.' },
        400,
      ),
    ).toEqual({ type: 'error', message: 'Clone failed: URL protocol is not allowed for clone.' });
  });
});
