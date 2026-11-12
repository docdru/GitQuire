import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { BOARD_CLIENT_NAME, boardAgentId, boardWriterIdentity } from './board-identity.ts';
import { resetPrincipalDirectory, setSessionPrincipalResolver } from './principal-directory.ts';

const alice = { id: 'github-1', login: 'alice', name: 'Alice\nAdmin', email: 'alice@example.com' };

function request(cookie: string | undefined): IncomingMessage {
  return { headers: cookie === undefined ? {} : { cookie } } as IncomingMessage;
}

function aliceWithCookie(req: IncomingMessage) {
  return req.headers.cookie === 'gq_session=a' ? alice : undefined;
}

afterEach(() => {
  resetPrincipalDirectory();
});

describe('board writer identity', () => {
  it('names the signed-in person when the board asks for it', () => {
    setSessionPrincipalResolver(aliceWithCookie);
    expect(boardWriterIdentity(request('gq_session=a'), BOARD_CLIENT_NAME)).toEqual({
      agentId: 'board-github-1',
      agentName: 'Alice Admin',
      colorSeed: 'github-1',
      clientName: BOARD_CLIENT_NAME,
      clientVersion: undefined,
      label: undefined,
      principalId: 'github-1',
    });
    expect(boardAgentId('github-1')).toBe('board-github-1');
  });

  it('leaves other writers and signed-out requests alone', () => {
    setSessionPrincipalResolver(aliceWithCookie);
    expect(boardWriterIdentity(request('gq_session=a'), 'claude-code')).toBeUndefined();
    expect(boardWriterIdentity(request('gq_session=a'), undefined)).toBeUndefined();
    expect(boardWriterIdentity(request(undefined), BOARD_CLIENT_NAME)).toBeUndefined();
    resetPrincipalDirectory();
    expect(boardWriterIdentity(request('gq_session=a'), BOARD_CLIENT_NAME)).toBeUndefined();
  });
});
