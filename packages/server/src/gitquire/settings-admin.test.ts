import {
  CONFIG_DOC_NAME_OKIGNORE,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
} from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  applySettingsAccess,
  createSettingsWriteGuard,
  memberSettingsChangeAllowed,
  setAdminResolver,
} from './settings-admin.ts';

afterEach(() => setAdminResolver(undefined));

function authPayload(documentName: string, cookie: string) {
  return {
    documentName,
    context: {} as Record<string, unknown>,
    requestHeaders: { cookie },
    connectionConfig: { readOnly: false },
  };
}

function useAdmins(...cookies: string[]) {
  setAdminResolver((req) => cookies.includes(String(req.headers.cookie)));
}

describe('applySettingsAccess', () => {
  test('leaves everything writable without sign-in', () => {
    const payload = authPayload(CONFIG_DOC_NAME_PROJECT, 'anyone');
    applySettingsAccess(payload);
    expect(payload.connectionConfig.readOnly).toBe(false);
  });

  test('makes shared settings read-only for members', () => {
    useAdmins('admin');
    for (const doc of [CONFIG_DOC_NAME_PROJECT, CONFIG_DOC_NAME_OKIGNORE]) {
      const member = authPayload(doc, 'member');
      applySettingsAccess(member);
      expect(member.connectionConfig.readOnly).toBe(true);
      const admin = authPayload(doc, 'admin');
      applySettingsAccess(admin);
      expect(admin.connectionConfig.readOnly).toBe(false);
    }
  });

  test('marks server settings for key checks instead of read-only', () => {
    useAdmins('admin');
    const member = authPayload(CONFIG_DOC_NAME_PROJECT_LOCAL, 'member');
    applySettingsAccess(member);
    expect(member.connectionConfig.readOnly).toBe(false);
    expect(Object.keys(member.context)).toHaveLength(1);
    const admin = authPayload(CONFIG_DOC_NAME_PROJECT_LOCAL, 'admin');
    applySettingsAccess(admin);
    expect(admin.context).toEqual({});
  });

  test('ignores page documents', () => {
    useAdmins();
    const payload = authPayload('notes/plan', 'member');
    applySettingsAccess(payload);
    expect(payload.connectionConfig.readOnly).toBe(false);
    expect(payload.context).toEqual({});
  });
});

describe('memberSettingsChangeAllowed', () => {
  const base = 'autoSync:\n  mode: full\nappearance:\n  sidebar:\n    showHiddenFiles: false\n';

  test('allows file tree view toggles', () => {
    expect(memberSettingsChangeAllowed(base, base.replace('false', 'true'))).toBe(true);
    expect(memberSettingsChangeAllowed('', 'appearance:\n  sidebar:\n    showOkFolders: true\n')).toBe(
      true,
    );
  });

  test('refuses anything else', () => {
    expect(memberSettingsChangeAllowed(base, base.replace('full', 'off'))).toBe(false);
    expect(memberSettingsChangeAllowed(base, `${base}linkPreviews:\n  enabled: true\n`)).toBe(false);
    expect(memberSettingsChangeAllowed(base, 'autoSync: [')).toBe(false);
  });
});

describe('createSettingsWriteGuard', () => {
  function docWith(source: string): Y.Doc {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, source);
    return doc;
  }

  function updateTo(doc: Y.Doc, next: string): Uint8Array {
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(client);
    const text = client.getText('source');
    text.delete(0, text.length);
    text.insert(0, next);
    return Y.encodeStateAsUpdate(client, before);
  }

  async function run(source: string, next: string, member: boolean) {
    let rejected = 0;
    const guard = createSettingsWriteGuard(() => {
      rejected += 1;
    });
    const document = docWith(source);
    const connection = { readOnly: false };
    const context = member ? { gitquireMemberSettings: true } : {};
    const call = guard.beforeSync?.({
      documentName: CONFIG_DOC_NAME_PROJECT_LOCAL,
      document,
      connection,
      context,
      type: 2,
      payload: updateTo(document, next),
    } as never);
    const outcome = await call?.then(
      () => 'allowed',
      () => 'refused',
    );
    return { outcome, rejected, readOnly: connection.readOnly };
  }

  test('lets members change their file tree view', async () => {
    const result = await run(
      'appearance:\n  sidebar:\n    showHiddenFiles: false\n',
      'appearance:\n  sidebar:\n    showHiddenFiles: true\n',
      true,
    );
    expect(result).toEqual({ outcome: 'allowed', rejected: 0, readOnly: false });
  });

  test('refuses members other server settings', async () => {
    const result = await run('autoSync:\n  mode: full\n', 'autoSync:\n  mode: off\n', true);
    expect(result).toEqual({ outcome: 'refused', rejected: 1, readOnly: true });
  });

  test('lets admins change anything', async () => {
    const result = await run('autoSync:\n  mode: full\n', 'autoSync:\n  mode: off\n', false);
    expect(result.outcome).toBe('allowed');
  });
});
