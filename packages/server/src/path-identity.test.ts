import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createBasenameIndex } from '@gitquire/core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { seedBasenameIndex } from './asset-walk.ts';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import {
  contentHash,
  type DiskEvent,
  registerWrite,
  resetWatcherDecisionDiagnostics,
  startWatcher,
} from './file-watcher.ts';
import { LocalTargetIndex } from './local-target-index.ts';
import { createPersistenceExtension } from './persistence.ts';
import type { ServerInstance } from './server-factory.ts';
import { destroyShadowRepo, initShadowRepo, shadowGit } from './shadow-repo.ts';

const echoGate = vi.hoisted(() => ({
  docName: null as string | null,
  held: [] as Array<() => Promise<void>>,
}));

vi.mock('./file-watcher.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-watcher.ts')>();
  return {
    ...actual,
    startWatcher: (...[contentDir, onDiskEvent, ...rest]: Parameters<typeof actual.startWatcher>) =>
      actual.startWatcher(
        contentDir,
        async (event) => {
          if (event.kind === 'update' && event.docName === echoGate.docName) {
            echoGate.held.push(() => onDiskEvent(event));
            return;
          }
          await onDiskEvent(event);
        },
        ...rest,
      ),
  };
});

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

const ROOT_SPELLINGS = ['natively spelled'] as const;
type RootSpelling = (typeof ROOT_SPELLINGS)[number];

interface SpelledRoot {
  spelling: RootSpelling;
  projectDir: string;
  contentDir: string;
  canonicalContentDir: string;
}

function spelledRoot(spelling: RootSpelling): SpelledRoot {
  const projectDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ok-path-identity-')));
  fixtures.push(projectDir);
  const contentDir = join(projectDir, 'ContentCase');
  mkdirSync(contentDir);
  return { spelling, projectDir, contentDir, canonicalContentDir: realpathSync.native(contentDir) };
}

function requireSpellingOnThisLeg(root: SpelledRoot): void {
  expect(root.contentDir).toBe(root.canonicalContentDir);
}

describe('directory identity across server components', () => {
  test.for(ROOT_SPELLINGS)(
    'persistence stores an edited document from the %s root',
    async (spelling) => {
      const root = spelledRoot(spelling);
      requireSpellingOnThisLeg(root);
      const { projectDir, contentDir } = root;
      const docName = 'note';
      const seed = '# Note\n\nBefore.\n';
      const edited = '# Note\n\nAfter.\n';
      writeFileSync(join(contentDir, `${docName}.md`), seed);
      const state = new DocumentDurabilityState();
      const persistence = createPersistenceExtension({
        mergeHistory: null,
        ingestDiskAtStore: null,
        contentDir,
        projectDir,
        gitEnabled: false,
        durabilityState: state,
      });
      const doc = new Y.Doc();
      try {
        composeAndWriteRawBody(doc, edited, 'agent');
        state.setReconciledBase(docName, seed);
        state.markAgentWriteStore(docName);
        await expect(persistence.forceStore(doc, docName)).resolves.toBeUndefined();
        expect(readFileSync(join(contentDir, `${docName}.md`), 'utf8')).toBe(edited);
        expect(state.takeStoreFailure(docName)).toBeNull();
      } finally {
        doc.destroy();
      }
    },
  );

  test.each([
    { spelling: 'working directory', contentDir: process.cwd() },
    { spelling: 'empty', contentDir: '' },
  ])(
    'persistence keeps writes within the $spelling root, which resolves to the working directory',
    async ({ contentDir }) => {
      const insideDir = mkdtempSync(join(process.cwd(), 'ok-cwd-root-'));
      fixtures.push(insideDir);
      const { projectDir } = spelledRoot('natively spelled');
      const insidePath = join(insideDir, 'inside.md');
      const insideName = relative(process.cwd(), insidePath).split(sep).join('/');
      const outsidePath = join(projectDir, 'outside.md');
      const seed = '# Note\n\nBefore.\n';
      const edited = '# Note\n\nAfter.\n';
      writeFileSync(insidePath, seed);
      writeFileSync(outsidePath, seed);
      const state = new DocumentDurabilityState();
      const persistence = createPersistenceExtension({
        mergeHistory: null,
        ingestDiskAtStore: null,
        contentDir,
        projectDir,
        gitEnabled: false,
        durabilityState: state,
      });
      const doc = new Y.Doc();
      try {
        composeAndWriteRawBody(doc, edited, 'agent');
        state.setReconciledBase(insideName, seed);
        state.markAgentWriteStore(insideName);
        await expect(persistence.forceStore(doc, insideName)).resolves.toBeUndefined();
        expect(readFileSync(insidePath, 'utf8')).toBe(edited);
        state.setReconciledBase(outsidePath, seed);
        state.markAgentWriteStore(outsidePath);
        await expect(persistence.forceStore(doc, outsidePath)).rejects.toThrow(
          'Invalid document name',
        );
        expect(readFileSync(outsidePath, 'utf8')).toBe(seed);
      } finally {
        doc.destroy();
      }
    },
  );

  test.for(ROOT_SPELLINGS)(
    'persistence records edited bytes from the %s project root',
    async (spelling) => {
      const root = spelledRoot(spelling);
      requireSpellingOnThisLeg(root);
      const { contentDir: projectDir, canonicalContentDir: contentDir } = root;
      const docName = 'note';
      const seed = '# Note\n\nBefore.\n';
      const edited = '# Note\n\nAfter.\n';
      writeFileSync(join(contentDir, `${docName}.md`), seed);
      const shadow = await initShadowRepo(projectDir);
      const state = new DocumentDurabilityState();
      const persistence = createPersistenceExtension({
        mergeHistory: null,
        ingestDiskAtStore: null,
        contentDir,
        projectDir,
        gitEnabled: true,
        shadowRef: { current: shadow },
        durabilityState: state,
      });
      const doc = new Y.Doc();
      try {
        composeAndWriteRawBody(doc, edited, 'agent');
        state.setReconciledBase(docName, seed);
        state.markAgentWriteStore(docName);
        await expect(persistence.forceStore(doc, docName)).resolves.toBeUndefined();
        expect(readFileSync(join(contentDir, `${docName}.md`), 'utf8')).toBe(edited);
        await persistence.flushPendingGitCommit();
        const git = shadowGit(shadow);
        const refs = (await git.raw('for-each-ref', '--format=%(objectname)', 'refs/wip/main'))
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        expect(refs).not.toEqual([]);
        await expect(git.raw('show', `${refs[0]}:${docName}.md`)).resolves.toBe(edited);
      } finally {
        try {
          await persistence.flushPendingGitCommit();
        } finally {
          doc.destroy();
          destroyShadowRepo(shadow);
        }
      }
    },
  );

  test.for(ROOT_SPELLINGS)(
    'file target reconciliation finds an existing file from the %s root',
    async (spelling) => {
      const root = spelledRoot(spelling);
      requireSpellingOnThisLeg(root);
      const { contentDir } = root;
      writeFileSync(join(contentDir, 'target.png'), 'owned asset');
      const index = new LocalTargetIndex({ contentDir });
      try {
        index.setSource('note', '![Image](target.png)\n');
        expect(index.getAssessments('note')[0]).toMatchObject({
          resolvedTarget: 'target.png',
          status: 'missing',
        });
        await index.reconcileDependentFileTargetsFromDisk();
        expect(index.getAssessments('note')[0]).toMatchObject({
          resolvedTarget: 'target.png',
          status: 'exact',
        });
      } finally {
        index.close();
      }
    },
  );

  test('file target reconciliation leaves an out-of-root target missing', async () => {
    const { projectDir, contentDir } = spelledRoot('natively spelled');
    writeFileSync(join(projectDir, 'outside.png'), 'outside asset');
    symlinkSync('../outside.png', join(contentDir, 'outside.png'));
    expect(existsSync(join(contentDir, 'outside.png'))).toBe(true);
    const index = new LocalTargetIndex({ contentDir });
    try {
      index.setSource('note', '![Image](outside.png)\n');
      await index.reconcileDependentFileTargetsFromDisk();
      expect(index.getAssessments('note')[0]).toMatchObject({
        resolvedTarget: 'outside.png',
        status: 'missing',
      });
    } finally {
      index.close();
    }
  });

  test.for(ROOT_SPELLINGS)(
    'asset walk includes an in-root file alias from the %s root',
    async (spelling) => {
      const root = spelledRoot(spelling);
      requireSpellingOnThisLeg(root);
      const { contentDir } = root;
      writeFileSync(join(contentDir, 'target.png'), 'owned asset');
      symlinkSync('target.png', join(contentDir, 'alias.png'));
      const index = createBasenameIndex();
      await seedBasenameIndex({ contentDir, basenameIndex: index });
      expect(index.resolveEmbed('target.png', 'note.md')).toBe('target.png');
      expect(index.resolveEmbed('alias.png', 'note.md')).toBe('alias.png');
    },
  );

  test.each([
    { spelling: 'existing', input: '.' },
    { spelling: 'empty', input: '' },
    { spelling: 'unresolved', input: `missing${sep}..` },
  ])('asset walk respects filesystem admission for the $spelling root', async ({ input }) => {
    const { contentDir } = spelledRoot('natively spelled');
    writeFileSync(join(contentDir, 'target.png'), 'owned asset');
    const previousCwd = process.cwd();
    process.chdir(contentDir);
    try {
      const entries = await readdir(input).catch((): string[] => []);
      const expected = entries.includes('target.png') ? 'target.png' : null;
      const index = createBasenameIndex();
      await seedBasenameIndex({ contentDir: input, basenameIndex: index });
      expect(index.resolveEmbed('target.png', 'note.md')).toBe(expected);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

type DirectConnection = Awaited<ReturnType<ServerInstance['hocuspocus']['openDirectConnection']>>;

async function _appendParagraph(connection: DirectConnection, text: string): Promise<void> {
  await connection.transact((doc) => {
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(text)]);
    const fragment = doc.getXmlFragment('default');
    fragment.insert(fragment.length, [paragraph]);
  });
}

async function _storeNow(server: ServerInstance, docName: string): Promise<void> {
  const debounceId = `onStoreDocument-${docName}`;
  await vi.waitFor(() => expect(server.hocuspocus.debouncer.isDebounced(debounceId)).toBe(true));
  await server.hocuspocus.debouncer.executeNow(debounceId);
}

const WATCHED_ROOT_ROWS = ROOT_SPELLINGS.flatMap((spelling) =>
  (['default'] as const).map((watcher) => [spelling, watcher] as const),
);

function watcherOptions(_backend: (typeof WATCHED_ROOT_ROWS)[number][1]) {
  return {};
}

interface ListedEntry {
  kind: string;
  docName?: string;
  path?: string;
  isSymlink?: boolean;
  canonicalDocName?: string | null;
  targetPath?: string | null;
}

async function documentListingFrom(contentDir: string): Promise<ListedEntry[]> {
  const server = await bootCompositionRig(contentDir);
  try {
    await server.ready;
    const response = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { documents: ListedEntry[] }).documents;
  } finally {
    await server.destroy();
  }
}

describe('one directory identity for watcher keys and linked documents', () => {
  test.for(ROOT_SPELLINGS)(
    'links spelled through the %s root or its native spelling load and store, while links out of the root or into private state stay refused',
    async (spelling) => {
      const root = spelledRoot(spelling);
      requireSpellingOnThisLeg(root);
      const { projectDir, contentDir, canonicalContentDir } = root;
      const original = '# Target\n\nTarget body.\n';
      const edited = '# Target\n\nTarget body.\n\nAppended.\n';
      mkdirSync(join(canonicalContentDir, '.gitquire', 'local'), { recursive: true });
      const targets = {
        'root-spelled': join(contentDir, 'root-target.md'),
        'native-spelled': join(canonicalContentDir, 'native-target.md'),
        outside: join(projectDir, 'outside-target.md'),
        private: join(contentDir, '.gitquire', 'local', 'private-target.md'),
      };
      for (const [docName, target] of Object.entries(targets)) {
        writeFileSync(target, original);
        symlinkSync(target, join(canonicalContentDir, `${docName}.md`));
      }
      const loader = createPersistenceExtension({
        mergeHistory: null,
        ingestDiskAtStore: null,
        contentDir,
        projectDir,
        gitEnabled: false,
        durabilityState: new DocumentDurabilityState(),
      });
      const storeState = new DocumentDurabilityState();
      const storer = createPersistenceExtension({
        mergeHistory: null,
        ingestDiskAtStore: null,
        contentDir,
        projectDir,
        gitEnabled: false,
        durabilityState: storeState,
      });
      const load = async (documentName: string): Promise<string> => {
        const document = new Y.Doc();
        try {
          await loader.extension.onLoadDocument?.({
            document,
            documentName,
            context: {},
          } as never);
          return document.getText('source').toString();
        } finally {
          document.destroy();
        }
      };
      const store = async (documentName: string): Promise<void> => {
        const document = new Y.Doc();
        try {
          composeAndWriteRawBody(document, edited, 'agent');
          storeState.setReconciledBase(documentName, original);
          storeState.markAgentWriteStore(documentName);
          await storer.forceStore(document, documentName);
        } finally {
          document.destroy();
        }
      };
      expect(await load('root-spelled')).toBe(original);
      expect(await load('native-spelled')).toBe(original);
      expect(await load('outside')).toBe('');
      expect(await load('private')).toBe('');
      await expect(store('root-spelled')).resolves.toBeUndefined();
      await expect(store('native-spelled')).resolves.toBeUndefined();
      await expect(store('outside')).rejects.toThrow();
      await expect(store('private')).rejects.toThrow();
      expect(readFileSync(targets['root-spelled'], 'utf8')).toBe(edited);
      expect(readFileSync(targets['native-spelled'], 'utf8')).toBe(edited);
      expect(readFileSync(targets.outside, 'utf8')).toBe(original);
      expect(readFileSync(targets.private, 'utf8')).toBe(original);
    },
  );

  test.for(WATCHED_ROOT_ROWS)(
    'a page created under the %s root and deleted on disk is reported deleted under its own name after a re-check (%s)',
    async ([spelling, backend]) => {
      const root = spelledRoot(spelling);
      requireSpellingOnThisLeg(root);
      const docName = `page-${randomUUID().slice(0, 8)}`;
      const fileName = `${docName}.md`;
      const fullPath = join(root.contentDir, fileName);
      const content = '# Page\n\nCreated through the server.\n';
      const events: DiskEvent[] = [];
      const watcher = await startWatcher(
        root.contentDir,
        async (event) => {
          events.push(event);
        },
        undefined,
        watcherOptions(backend),
      );
      try {
        resetWatcherDecisionDiagnostics();
        writeFileSync(fullPath, content, { flag: 'wx' });
        registerWrite(fullPath, contentHash(content));
        watcher.mutateFileIndex({ kind: 'create', path: fullPath, docName, content });
        unlinkSync(fullPath);
        await watcher.recheck();
        await vi.waitFor(() =>
          expect(events).toContainEqual(expect.objectContaining({ kind: 'delete', docName })),
        );
        expect(watcher.getFileIndex().has(docName)).toBe(false);
      } finally {
        await watcher.unsubscribe();
      }
    },
  );

  test.for(WATCHED_ROOT_ROWS)(
    'links created under the %s root through its own spelling or its native spelling are aliases of their target after a re-check (%s)',
    async ([spelling, backend]) => {
      const root = spelledRoot(spelling);
      requireSpellingOnThisLeg(root);
      writeFileSync(join(root.canonicalContentDir, 'target.md'), '# Target\n\nTarget body.\n');
      const watcher = await startWatcher(
        root.contentDir,
        async () => {},
        undefined,
        watcherOptions(backend),
      );
      try {
        resetWatcherDecisionDiagnostics();
        symlinkSync(
          join(root.canonicalContentDir, 'target.md'),
          join(root.canonicalContentDir, 'link-native.md'),
        );
        symlinkSync(
          join(root.contentDir, 'target.md'),
          join(root.canonicalContentDir, 'link-root.md'),
        );
        await watcher.recheck();
        expect(Object.fromEntries(watcher.getAliasMap())).toEqual({
          'link-native': 'target',
          'link-root': 'target',
        });
      } finally {
        await watcher.unsubscribe();
      }
    },
  );

  test.for(ROOT_SPELLINGS)(
    'the document listing from the %s root labels a linked document by its in-root target',
    async (spelling) => {
      const root = spelledRoot(spelling);
      requireSpellingOnThisLeg(root);
      writeFileSync(join(root.canonicalContentDir, 'target.md'), '# Target\n');
      symlinkSync('target.md', join(root.canonicalContentDir, 'link.md'));
      expect(await documentListingFrom(root.contentDir)).toContainEqual(
        expect.objectContaining({
          kind: 'document',
          docName: 'link',
          isSymlink: true,
          canonicalDocName: 'target',
          targetPath: 'target.md',
        }),
      );
    },
  );

  test.for(ROOT_SPELLINGS)(
    'the document listing from the %s root labels a linked folder and what lies beneath it by their in-root targets',
    async (spelling) => {
      const root = spelledRoot(spelling);
      requireSpellingOnThisLeg(root);
      mkdirSync(join(root.canonicalContentDir, 'real', 'sub'), { recursive: true });
      writeFileSync(join(root.canonicalContentDir, 'real', 'note.md'), '# Note\n');
      symlinkSync('real', join(root.canonicalContentDir, 'alias'), 'junction');
      const listing = await documentListingFrom(root.contentDir);
      expect(listing).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'folder',
            path: 'alias',
            isSymlink: true,
            canonicalDocName: 'real',
            targetPath: 'real',
          }),
          expect.objectContaining({
            kind: 'folder',
            path: 'alias/sub',
            isSymlink: true,
            canonicalDocName: 'real/sub',
            targetPath: 'real/sub',
          }),
          expect.objectContaining({
            kind: 'document',
            docName: 'alias/note',
            isSymlink: true,
            canonicalDocName: 'real/note',
            targetPath: 'real/note.md',
          }),
        ]),
      );
    },
  );
});
