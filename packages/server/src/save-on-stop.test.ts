import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { ensureProjectGit } from './project-git.ts';
import { createServer } from './server-factory.ts';
import { initShadowRepo } from './shadow-repo.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('saving before a wiki process stops', () => {
  it('writes text typed a moment ago when the server stops, with the default save times', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'gq-save-on-stop-'));
    dirs.push(projectDir);
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    await ensureProjectGit(projectDir);
    configureTestGitRepository(projectDir);
    writeFileSync(join(contentDir, 'notes.md'), '# Notes\n\nFirst line.\n', 'utf-8');
    const server = createServer({
      contentDir,
      projectDir,
      quiet: true,
      shadowRepo: await initShadowRepo(projectDir),
    });
    await server.ready;
    const conn = await server.hocuspocus.openDirectConnection('notes');
    await conn.transact((doc) => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Typed just before the stop.')]);
      doc.getXmlFragment('default').push([paragraph]);
    });
    await conn.disconnect();
    await server.destroy();
    expect(readFileSync(join(contentDir, 'notes.md'), 'utf-8')).toContain(
      'Typed just before the stop.',
    );
  });
});
