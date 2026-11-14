import { afterEach, describe, expect, test } from 'vitest';
import { ProviderPool } from './provider-pool';

const DUMMY_WS = 'ws://localhost:1/collab';

let pool: ProviderPool | undefined;

afterEach(() => {
  pool?.dispose();
  pool = undefined;
});

function claimedInstance(pool: ProviderPool, docName: string): string | undefined {
  const token = pool.entries.get(docName)?.provider.configuration.token;
  const claim = JSON.parse(String(token)) as { expectedServerInstanceId?: string };
  return claim.expectedServerInstanceId;
}

describe('a doc opened before the server instance is known', () => {
  test('claims the instance it synced with, so a restarted server refuses its old state', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setTabIdentity({ principalId: 'p-1', tabSessionId: 's-1' });
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    expect(claimedInstance(pool, 'doc1')).toBeUndefined();

    pool.setExpectedServerInstanceId('server-a');
    entry.provider.emit('synced', { state: true });
    expect(claimedInstance(pool, 'doc1')).toBe('server-a');
  });

  test('claims the instance once it becomes known after the first sync', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setTabIdentity({ principalId: 'p-1', tabSessionId: 's-1' });
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');

    entry.provider.emit('synced', { state: true });
    expect(claimedInstance(pool, 'doc1')).toBeUndefined();

    pool.setExpectedServerInstanceId('server-a');
    await Promise.resolve();
    await Promise.resolve();
    expect(claimedInstance(pool, 'doc1')).toBe('server-a');
  });

  test('keeps the claim it opened with', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId('server-a');
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    entry.provider.emit('synced', { state: true });
    expect(claimedInstance(pool, 'doc1')).toBe('server-a');
  });
});
