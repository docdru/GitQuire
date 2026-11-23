import { describe, expect, it } from 'vitest';
import { stopWikiAndDrafts } from './stop-order.ts';

function recorder() {
  const order: string[] = [];
  return {
    order,
    steps: {
      flushWiki: async () => {
        order.push('wiki');
      },
      stopDrafts: async () => {
        order.push('drafts');
      },
    },
  };
}

describe('stopping a wiki and its drafts', () => {
  it('writes a single wiki before waiting for its drafts, as before drafts were stopped at all', async () => {
    const { order, steps } = recorder();
    await stopWikiAndDrafts(false, steps);
    expect(order).toEqual(['wiki', 'drafts']);
  });

  it('behind the front door stops the drafts first, within the front door’s stop budget', async () => {
    const { order, steps } = recorder();
    await stopWikiAndDrafts(true, steps);
    expect(order).toEqual(['drafts', 'wiki']);
  });
});
