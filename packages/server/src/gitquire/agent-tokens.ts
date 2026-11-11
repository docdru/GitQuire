import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GateLogger } from './access-gate.ts';
import { safeEqual } from './signed-cookie.ts';

export interface AgentTokenOwner {
  id: number;
  login: string;
  name: string;
  avatarUrl: string;
}

export type AgentTokenKind = 'personal' | 'connector';

export interface AgentTokenRecord {
  id: string;
  kind: AgentTokenKind;
  owner: AgentTokenOwner;
  label: string;
  clientId?: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
  accessHash: string;
  accessExpiresAt: number;
  refreshHash?: string;
}

export interface IssuedConnectorTokens {
  record: AgentTokenRecord;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface AgentTokenStore {
  list: (ownerId?: number) => AgentTokenRecord[];
  createPersonal: (
    owner: AgentTokenOwner,
    label: string,
    days: number,
  ) => { record: AgentTokenRecord; token: string };
  createConnector: (
    owner: AgentTokenOwner,
    label: string,
    clientId: string,
  ) => IssuedConnectorTokens;
  refreshConnector: (refreshToken: string, clientId: string) => IssuedConnectorTokens | undefined;
  verify: (accessToken: string) => AgentTokenRecord | undefined;
  revoke: (id: string, by: { ownerId: number } | 'admin') => boolean;
  revokeOwner: (ownerId: number) => number;
  owners: () => AgentTokenOwner[];
  flush: () => void;
}

export interface AgentTokenStoreDeps {
  file: string;
  log: GateLogger;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  connectorAccessSeconds?: number;
  connectorLifetimeDays?: number;
  lastUsedFlushMs?: number;
}

export const MAX_PERSONAL_TOKENS_PER_USER = 20;
export const MAX_CONNECTORS_PER_USER = 20;
export const MAX_LABEL_LENGTH = 80;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_RE = /^gq([ar])_([0-9a-f]{16})_([A-Za-z0-9_-]{32,})$/;

interface StoreFile {
  v: 1;
  tokens: AgentTokenRecord[];
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function parseAgentToken(
  token: string,
): { type: 'access' | 'refresh'; id: string; secret: string } | undefined {
  const match = TOKEN_RE.exec(token.trim());
  if (match === null) return undefined;
  return { type: match[1] === 'a' ? 'access' : 'refresh', id: match[2], secret: match[3] };
}

export function looksLikeAgentToken(token: string): boolean {
  return parseAgentToken(token) !== undefined;
}

export function cleanLabel(raw: unknown, fallback: string): string {
  const text = typeof raw === 'string' ? raw : '';
  const cleaned = Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? ' ' : char;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
  return cleaned === '' ? fallback : cleaned;
}

function isOwner(value: unknown): value is AgentTokenOwner {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'number' &&
    typeof v.login === 'string' &&
    typeof v.name === 'string' &&
    typeof v.avatarUrl === 'string'
  );
}

function isRecord(value: unknown): value is AgentTokenRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    /^[0-9a-f]{16}$/.test(v.id) &&
    (v.kind === 'personal' || v.kind === 'connector') &&
    isOwner(v.owner) &&
    typeof v.label === 'string' &&
    typeof v.createdAt === 'number' &&
    typeof v.expiresAt === 'number' &&
    typeof v.accessHash === 'string' &&
    typeof v.accessExpiresAt === 'number' &&
    (v.refreshHash === undefined || typeof v.refreshHash === 'string') &&
    (v.clientId === undefined || typeof v.clientId === 'string') &&
    (v.lastUsedAt === undefined || typeof v.lastUsedAt === 'number')
  );
}

export function createAgentTokenStore(deps: AgentTokenStoreDeps): AgentTokenStore {
  const now = deps.now ?? Date.now;
  const random = deps.randomBytes ?? randomBytes;
  const connectorAccessSeconds = deps.connectorAccessSeconds ?? 60 * 60;
  const connectorLifetimeMs = (deps.connectorLifetimeDays ?? 90) * DAY_MS;
  const lastUsedFlushMs = deps.lastUsedFlushMs ?? 60_000;
  const tokens = new Map<string, AgentTokenRecord>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    const parsed = JSON.parse(readFileSync(deps.file, 'utf8')) as Partial<StoreFile>;
    for (const entry of Array.isArray(parsed.tokens) ? parsed.tokens : []) {
      if (isRecord(entry)) tokens.set(entry.id, entry);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      deps.log.error({ err, file: deps.file }, '[gitquire-agents] could not read agent tokens');
    }
  }

  function persist(): void {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    const body: StoreFile = { v: 1, tokens: [...tokens.values()] };
    mkdirSync(dirname(deps.file), { recursive: true });
    const tmp = `${deps.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, deps.file);
  }

  function persistSoon(): void {
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      try {
        persist();
      } catch (err) {
        deps.log.warn({ err }, '[gitquire-agents] could not save token usage');
      }
    }, lastUsedFlushMs);
    flushTimer.unref?.();
  }

  function newId(): string {
    let id = random(8).toString('hex');
    while (tokens.has(id)) id = random(8).toString('hex');
    return id;
  }

  function newSecret(): string {
    return random(32).toString('base64url');
  }

  function dropExpired(): boolean {
    const t = now();
    let changed = false;
    for (const [id, record] of tokens) {
      if (record.expiresAt <= t) {
        tokens.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  function issueConnector(record: AgentTokenRecord): IssuedConnectorTokens {
    const access = newSecret();
    const refresh = newSecret();
    const t = now();
    record.accessHash = hashSecret(access);
    record.refreshHash = hashSecret(refresh);
    record.accessExpiresAt = Math.min(t + connectorAccessSeconds * 1000, record.expiresAt);
    return {
      record,
      accessToken: `gqa_${record.id}_${access}`,
      refreshToken: `gqr_${record.id}_${refresh}`,
      expiresInSeconds: Math.max(1, Math.floor((record.accessExpiresAt - t) / 1000)),
    };
  }

  function ownedBy(ownerId: number, kind: AgentTokenKind): AgentTokenRecord[] {
    return [...tokens.values()]
      .filter((record) => record.owner.id === ownerId && record.kind === kind)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  return {
    list(ownerId) {
      if (dropExpired()) persist();
      return [...tokens.values()]
        .filter((record) => ownerId === undefined || record.owner.id === ownerId)
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    createPersonal(owner, label, days) {
      dropExpired();
      if (ownedBy(owner.id, 'personal').length >= MAX_PERSONAL_TOKENS_PER_USER) {
        throw new AgentTokenLimitError(
          `You already have ${MAX_PERSONAL_TOKENS_PER_USER} agent tokens. Revoke one first.`,
        );
      }
      const t = now();
      const secret = newSecret();
      const expiresAt = t + days * DAY_MS;
      const record: AgentTokenRecord = {
        id: newId(),
        kind: 'personal',
        owner: { ...owner },
        label: cleanLabel(label, 'Agent token'),
        createdAt: t,
        expiresAt,
        accessHash: hashSecret(secret),
        accessExpiresAt: expiresAt,
      };
      tokens.set(record.id, record);
      persist();
      deps.log.info(
        { login: owner.login, tokenId: record.id },
        '[gitquire-agents] agent token created',
      );
      return { record, token: `gqa_${record.id}_${secret}` };
    },

    createConnector(owner, label, clientId) {
      dropExpired();
      for (const old of ownedBy(owner.id, 'connector')) {
        if (old.clientId === clientId) tokens.delete(old.id);
      }
      const existing = ownedBy(owner.id, 'connector');
      const excess = Math.max(0, existing.length - MAX_CONNECTORS_PER_USER + 1);
      for (const old of existing.slice(0, excess)) tokens.delete(old.id);
      const t = now();
      const record: AgentTokenRecord = {
        id: newId(),
        kind: 'connector',
        owner: { ...owner },
        label: cleanLabel(label, 'Connector'),
        clientId,
        createdAt: t,
        expiresAt: t + connectorLifetimeMs,
        accessHash: '',
        accessExpiresAt: t,
      };
      tokens.set(record.id, record);
      const issued = issueConnector(record);
      persist();
      deps.log.info(
        { login: owner.login, tokenId: record.id, client: record.label },
        '[gitquire-agents] connector authorized',
      );
      return issued;
    },

    refreshConnector(refreshToken, clientId) {
      const parsed = parseAgentToken(refreshToken);
      if (parsed === undefined || parsed.type !== 'refresh') return undefined;
      const record = tokens.get(parsed.id);
      if (
        record === undefined ||
        record.kind !== 'connector' ||
        record.refreshHash === undefined ||
        record.clientId !== clientId ||
        record.expiresAt <= now() ||
        !safeEqual(hashSecret(parsed.secret), record.refreshHash)
      ) {
        return undefined;
      }
      record.expiresAt = now() + connectorLifetimeMs;
      record.lastUsedAt = now();
      const issued = issueConnector(record);
      persist();
      return issued;
    },

    verify(accessToken) {
      const parsed = parseAgentToken(accessToken);
      if (parsed === undefined || parsed.type !== 'access') return undefined;
      const record = tokens.get(parsed.id);
      if (record === undefined) return undefined;
      const t = now();
      if (record.expiresAt <= t || record.accessExpiresAt <= t) return undefined;
      if (!safeEqual(hashSecret(parsed.secret), record.accessHash)) return undefined;
      const previous = record.lastUsedAt ?? 0;
      record.lastUsedAt = t;
      if (t - previous > lastUsedFlushMs) persistSoon();
      return record;
    },

    revoke(id, by) {
      const record = tokens.get(id);
      if (record === undefined) return false;
      if (by !== 'admin' && record.owner.id !== by.ownerId) return false;
      tokens.delete(id);
      persist();
      deps.log.info(
        { login: record.owner.login, tokenId: id, byAdmin: by === 'admin' },
        '[gitquire-agents] agent token revoked',
      );
      return true;
    },

    revokeOwner(ownerId) {
      let removed = 0;
      for (const [id, record] of tokens) {
        if (record.owner.id === ownerId) {
          tokens.delete(id);
          removed += 1;
        }
      }
      if (removed > 0) persist();
      return removed;
    },

    owners() {
      const seen = new Map<number, AgentTokenOwner>();
      for (const record of tokens.values()) seen.set(record.owner.id, record.owner);
      return [...seen.values()];
    },

    flush() {
      if (flushTimer !== undefined) persist();
    },
  };
}

export class AgentTokenLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTokenLimitError';
  }
}
