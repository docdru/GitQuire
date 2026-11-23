import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ForgejoRepoTokens } from '../host/forgejo.ts';
import type { HostKind, HostRepoRef } from '../host/types.ts';
import type { WikiTable } from './wiki-table.ts';

export interface RepoTokenStore extends ForgejoRepoTokens {
  has: (key: string) => boolean;
  set: (key: string, token: string) => void;
}

export function repoTokensFile(dataDir: string): string {
  return join(dataDir, 'server', 'repo-tokens.json');
}

function load(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  chmodSync(file, 0o600);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    version?: unknown;
    tokens?: Record<string, unknown>;
  };
  if (parsed.version !== 1 || typeof parsed.tokens !== 'object' || parsed.tokens === null) {
    throw new Error(`${file} is not a GitQuire token file.`);
  }
  const tokens: Record<string, string> = {};
  for (const [key, token] of Object.entries(parsed.tokens)) {
    if (typeof token === 'string' && token !== '') tokens[key] = token;
  }
  return tokens;
}

export function repoTokenKey(
  table: Pick<WikiTable, 'byId' | 'byAddress'>,
  host: HostKind,
): (repo: HostRepoRef) => string | undefined {
  return (repo) => {
    if (repo.id !== undefined) return table.byId(host, repo.id)?.key;
    const match = table.byAddress(repo.owner, repo.name);
    return match?.current === true ? match.wiki.key : undefined;
  };
}

export function openRepoTokenStore(
  file: string,
  keyOf: (repo: HostRepoRef) => string | undefined,
): RepoTokenStore {
  const tokens = load(file);

  function save(): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  }

  return {
    tokenFor: (repo) => {
      const key = keyOf(repo);
      return key === undefined ? undefined : tokens[key];
    },
    has: (key) => tokens[key] !== undefined,
    set: (key, token) => {
      tokens[key] = token;
      save();
    },
  };
}
