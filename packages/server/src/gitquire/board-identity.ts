import type { IncomingMessage } from 'node:http';
import {
  attributeEdit,
  sanitizeDisplayName,
  sessionPrincipal,
  type WriterIdentityLike,
} from './principal-directory.ts';

export const BOARD_CLIENT_NAME = 'gitquire-board';

export interface BoardWriterIdentity {
  agentId: string;
  agentName: string;
  colorSeed: string;
  clientName: string;
  clientVersion: undefined;
  label: undefined;
  principalId: string;
}

export function boardAgentId(principalId: string): string {
  return `board-${principalId}`;
}

export function boardWriterIdentity(
  req: IncomingMessage,
  clientName: string | undefined,
): BoardWriterIdentity | undefined {
  if (clientName !== BOARD_CLIENT_NAME) return undefined;
  const person = sessionPrincipal(req);
  if (person === undefined) return undefined;
  return {
    agentId: boardAgentId(person.id),
    agentName: sanitizeDisplayName(person.name, person.login),
    colorSeed: person.id,
    clientName: BOARD_CLIENT_NAME,
    clientVersion: undefined,
    label: undefined,
    principalId: person.id,
  };
}

export function boardEditWriter(context: Record<string, unknown>): WriterIdentityLike | undefined {
  if (context.agent_type !== BOARD_CLIENT_NAME) return undefined;
  const principalId = context.principal;
  return typeof principalId === 'string' ? attributeEdit(principalId) : undefined;
}
