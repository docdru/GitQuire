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
  const trailers = coAuthors.map((author) => `Co-authored-by: ${author.name} <${author.email}>`);
  return `${message}\n\n${trailers.join('\n')}`;
}

export function commitAuthorEnv(
  authors: readonly GitQuirePrincipal[],
): Record<string, string> | undefined {
  const primary = authors.at(0);
  if (primary === undefined) return undefined;
  return { GIT_AUTHOR_NAME: primary.name, GIT_AUTHOR_EMAIL: primary.email };
}
