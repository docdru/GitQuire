import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWriterFromOrigin } from '../persistence.ts';
import {
  BOARD_CLIENT_NAME,
  boardAgentId,
  boardWriterIdentity,
} from './board-identity.ts';
import {
  rememberPrincipal,
  resetPrincipalDirectory,
  setSessionPrincipalResolver,
  takeCommitAuthors,
} from './principal-directory.ts';

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

  it('makes the person the commit author of a board edit', () => {
    rememberPrincipal(alice);
    const origin = (context: Record<string, unknown>) => ({ source: 'local', context });
    const board = { session_id: 'board-github-1', principal: 'github-1', agent_type: 'b' };
    expect(resolveWriterFromOrigin(origin(board))).toEqual({
      id: 'github-1',
      name: 'Alice\nAdmin',
      email: 'alice@example.com',
    });
    expect(takeCommitAuthors()).toEqual([alice]);
    const stranger = resolveWriterFromOrigin(origin({ ...board, principal: 'github-9' }));
    expect(stranger?.id).toBe('agent-board-github-1');
    const agent = resolveWriterFromOrigin(origin({ session_id: 'claude-1' }));
    expect(agent?.id).toBe('agent-claude-1');
  });
});
