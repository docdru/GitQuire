import { describe, expect, test } from 'vitest';
import { collabUrlFromRequestHeaders } from './collab-bootstrap-url.ts';

describe('collabUrlFromRequestHeaders', () => {
  test('reflects the client Host over plain ws locally', () => {
    expect(collabUrlFromRequestHeaders({ host: 'localhost:24550' })).toBe(
      'ws://localhost:24550/collab',
    );
  });

  test('upgrades to wss when the tunnel forwarded https', () => {
    expect(
      collabUrlFromRequestHeaders({
        host: 'myproject.ngrok.app',
        'x-forwarded-proto': 'https',
      }),
    ).toBe('wss://myproject.ngrok.app/collab');
  });

  test('multi-valued forwarded-proto uses the first hop', () => {
    expect(
      collabUrlFromRequestHeaders({
        host: 'myproject.ngrok.app',
        'x-forwarded-proto': ['https', 'http'] as unknown as string,
      }),
    ).toBe('wss://myproject.ngrok.app/collab');
  });

  test('puts the forwarded prefix of the front door into the address', () => {
    expect(
      collabUrlFromRequestHeaders(
        { host: 'wiki.example', 'x-forwarded-proto': 'https' },
        '/w/team/wiki',
      ),
    ).toBe('wss://wiki.example/w/team/wiki/collab');
  });

  test('ignores a prefix header outside the front-door mode', () => {
    expect(
      collabUrlFromRequestHeaders({ host: 'localhost:24550', 'x-gitquire-prefix': '/w/team/wiki' }),
    ).toBe('ws://localhost:24550/collab');
  });

  test('missing Host yields null (malformed-request floor)', () => {
    expect(collabUrlFromRequestHeaders({})).toBeNull();
  });
});
