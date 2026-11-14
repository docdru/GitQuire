import type { IncomingMessage } from 'node:http';

export interface GitQuirePrincipal {
  id: string;
  login: string;
  name: string;
  email: string;
}

export interface WriterIdentityLike {
  id: string;
  name: string;
  email: string;
}

type SessionResolver = (req: IncomingMessage) => GitQuirePrincipal | undefined;

let resolver: SessionResolver | undefined;
const known = new Map<string, GitQuirePrincipal>();
const pendingEdits = new Map<string, number>();
const documentWriters = new Map<string, { principalId: string; at: number }>();
const MAX_DOCUMENT_WRITERS = 5000;

export function sanitizeDisplayName(raw: string, fallback: string): string {
  const cleaned = Array.from(raw, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || code === 127 || char === '<' || char === '>' ? ' ' : char;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? fallback : cleaned;
}

export function principalIdForGitHubUser(githubUserId: number): string {
  return `github-${githubUserId}`;
}

export function setSessionPrincipalResolver(next: SessionResolver | undefined): void {
  resolver = next;
}

export function resetPrincipalDirectory(): void {
  resolver = undefined;
  known.clear();
  pendingEdits.clear();
  agentOwners.clear();
  documentWriters.clear();
}

export function noteDocumentWriter(
  documentName: string,
  principalId: string,
  at: number = Date.now(),
): void {
  if (!known.has(principalId)) return;
  documentWriters.delete(documentName);
  documentWriters.set(documentName, { principalId, at });
  if (documentWriters.size > MAX_DOCUMENT_WRITERS) {
    const oldest = documentWriters.keys().next().value;
    if (oldest !== undefined) documentWriters.delete(oldest);
  }
}

export function recentDocumentWriter(
  documentName: string,
  maxAgeMs: number,
  now: number = Date.now(),
): GitQuirePrincipal | undefined {
  const entry = documentWriters.get(documentName);
  if (entry === undefined || now - entry.at > maxAgeMs) return undefined;
  return known.get(entry.principalId);
}

export function rememberPrincipal(principal: GitQuirePrincipal): void {
  known.set(principal.id, principal);
}

export function sessionPrincipal(req: IncomingMessage | undefined): GitQuirePrincipal | undefined {
  if (resolver === undefined || req === undefined) return undefined;
  const principal = resolver(req);
  if (principal !== undefined) rememberPrincipal(principal);
  return principal;
}

export function cookieFromBag(bag: unknown): string | undefined {
  if (typeof bag !== 'object' || bag === null) return undefined;
  const maybeHeaders = bag as { get?: unknown };
  if (typeof maybeHeaders.get === 'function') {
    const value = (bag as Headers).get('cookie');
    return value === null ? undefined : value;
  }
  const value = (bag as Record<string, unknown>).cookie;
  return typeof value === 'string' ? value : undefined;
}

export function sessionPrincipalForAuthPayload(payload: unknown): GitQuirePrincipal | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as { requestHeaders?: unknown; request?: { headers?: unknown } };
  const cookie = cookieFromBag(p.requestHeaders) ?? cookieFromBag(p.request?.headers);
  if (cookie === undefined) return undefined;
  return sessionPrincipal({ headers: { cookie } } as IncomingMessage);
}

const requestPrincipals = new WeakMap<object, GitQuirePrincipal>();
const agentOwners = new Map<string, GitQuirePrincipal>();
const MAX_AGENT_BINDINGS = 1000;

export function bindRequestPrincipal(req: object, principal: GitQuirePrincipal): void {
  requestPrincipals.set(req, principal);
}

export function requestPrincipal(req: object | undefined): GitQuirePrincipal | undefined {
  return req === undefined ? undefined : requestPrincipals.get(req);
}

export function bindAgentConnection(connectionId: string, principal: GitQuirePrincipal): void {
  agentOwners.delete(connectionId);
  agentOwners.set(connectionId, principal);
  rememberPrincipal(principal);
  while (agentOwners.size > MAX_AGENT_BINDINGS) {
    const oldest = agentOwners.keys().next().value;
    if (oldest === undefined) break;
    agentOwners.delete(oldest);
  }
}

export function agentConnectionOwner(connectionId: string): GitQuirePrincipal | undefined {
  return agentOwners.get(connectionId);
}

export function attributeAgentEdit(sessionId: string): WriterIdentityLike | undefined {
  const owner = agentOwners.get(sessionId) ?? agentOwners.get(`agent-${sessionId}`);
  if (owner === undefined) return undefined;
  rememberPrincipal(owner);
  return attributeEdit(owner.id);
}

export function attributeEdit(principalId: string): WriterIdentityLike | undefined {
  const principal = known.get(principalId);
  if (principal === undefined) return undefined;
  pendingEdits.set(principalId, (pendingEdits.get(principalId) ?? 0) + 1);
  return { id: principal.id, name: principal.name, email: principal.email };
}

export function takeCommitAuthors(): GitQuirePrincipal[] {
  const ranked = [...pendingEdits.entries()]
    .map(([id, edits], order) => ({ principal: known.get(id), edits, order }))
    .filter(
      (entry): entry is { principal: GitQuirePrincipal; edits: number; order: number } =>
        entry.principal !== undefined,
    )
    .sort((a, b) => b.edits - a.edits || a.order - b.order)
    .map((entry) => entry.principal);
  pendingEdits.clear();
  return ranked;
}

export function restoreCommitAuthors(authors: readonly GitQuirePrincipal[]): void {
  for (const author of authors) {
    rememberPrincipal(author);
    pendingEdits.set(author.id, (pendingEdits.get(author.id) ?? 0) + 1);
  }
}

export function withCoAuthorTrailers(
  message: string,
  authors: readonly GitQuirePrincipal[],
): string {
  const coAuthors = authors.slice(1);
  if (coAuthors.length === 0) return message;
  const trailers = coAuthors.map(
    (author) =>
      `Co-authored-by: ${sanitizeDisplayName(author.name, author.login)} <${author.email}>`,
  );
  return `${message}\n\n${trailers.join('\n')}`;
}

export function commitAuthorEnv(
  authors: readonly GitQuirePrincipal[],
): Record<string, string> | undefined {
  const primary = authors.at(0);
  if (primary === undefined) return undefined;
  return {
    GIT_AUTHOR_NAME: sanitizeDisplayName(primary.name, primary.login),
    GIT_AUTHOR_EMAIL: primary.email,
  };
}
