import type { IncomingMessage } from 'node:http';
import type { Extension } from '@hocuspocus/server';
import {
  CONFIG_DOC_NAME_OKIGNORE,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
} from '@inkeep/open-knowledge-core';
import { parseDocument } from 'yaml';
import * as Y from 'yjs';
import { cookieFromBag } from './principal-directory.ts';

type AdminResolver = (req: IncomingMessage) => boolean;

let resolver: AdminResolver | undefined;

const READ_ONLY_FOR_MEMBERS: ReadonlySet<string> = new Set([
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_OKIGNORE,
]);

const MEMBER_ONLY_KEYS_CONTEXT = 'gitquireMemberSettings';

export function setAdminResolver(next: AdminResolver | undefined): void {
  resolver = next;
}

interface AuthPayloadLike {
  documentName: string;
  context: unknown;
  requestHeaders?: unknown;
  request?: { headers?: unknown };
  connectionConfig: { readOnly: boolean };
}

function isMember(payload: AuthPayloadLike): boolean {
  if (resolver === undefined) return false;
  const cookie = cookieFromBag(payload.requestHeaders) ?? cookieFromBag(payload.request?.headers);
  return !resolver({ headers: { cookie: cookie ?? '' } } as IncomingMessage);
}

export function applySettingsAccess(payload: AuthPayloadLike): void {
  const governed =
    READ_ONLY_FOR_MEMBERS.has(payload.documentName) ||
    payload.documentName === CONFIG_DOC_NAME_PROJECT_LOCAL;
  if (!governed || !isMember(payload)) return;
  if (READ_ONLY_FOR_MEMBERS.has(payload.documentName)) {
    payload.connectionConfig.readOnly = true;
    return;
  }
  if (typeof payload.context === 'object' && payload.context !== null) {
    (payload.context as Record<string, unknown>)[MEMBER_ONLY_KEYS_CONTEXT] = true;
  }
}

function withoutPersonalViewKeys(source: string): string | null {
  try {
    const yaml = parseDocument(source);
    if (yaml.errors.length > 0) return null;
    const value = (yaml.toJS() ?? {}) as Record<string, unknown>;
    const appearance = value.appearance;
    if (typeof appearance === 'object' && appearance !== null) {
      value.appearance = Object.fromEntries(
        Object.entries(appearance).filter(([key]) => key !== 'sidebar'),
      );
    }
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function memberSettingsChangeAllowed(before: string, after: string): boolean {
  if (before === after) return true;
  const a = withoutPersonalViewKeys(before);
  const b = withoutPersonalViewKeys(after);
  return a !== null && a === b;
}

export function createSettingsWriteGuard(onRejected: () => void): Extension {
  return {
    async beforeSync({ documentName, document, connection, context, type, payload }) {
      if (documentName !== CONFIG_DOC_NAME_PROJECT_LOCAL || (type !== 1 && type !== 2)) return;
      if ((context as Record<string, unknown> | undefined)?.[MEMBER_ONLY_KEYS_CONTEXT] !== true) {
        return;
      }
      const before = document.getText('source').toString();
      const preview = new Y.Doc();
      let allowed = false;
      try {
        Y.applyUpdate(preview, Y.encodeStateAsUpdate(document));
        Y.applyUpdate(preview, payload);
        allowed = memberSettingsChangeAllowed(before, preview.getText('source').toString());
      } catch {
        allowed = false;
      } finally {
        preview.destroy();
      }
      if (allowed) return;
      connection.readOnly = true;
      onRejected();
      const reason = 'Only wiki admins can change these settings.';
      throw Object.assign(new Error(reason), { code: 4403, reason });
    },
  };
}
