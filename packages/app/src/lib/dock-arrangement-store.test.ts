import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  type DockArrangement,
  type DockArrangementStorage,
  dockArrangementStorageKey,
  legacyDockArrangement,
  readDockArrangement,
  withDockPaneAtEdge,
  writeDockArrangement,
} from './dock-arrangement-store.ts';
import { DEFAULT_CHAT_SHARE, DEFAULT_DOCK_TREE, type DockNode, isDockLeaf } from './dock-tree.ts';

function memoryStorage(initial: Record<string, string> = {}): DockArrangementStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function shape(node: DockNode): unknown {
  if (isDockLeaf(node)) return node.pane;
  return { [node.direction]: node.items.map((item) => shape(item.node)) };
}

function shares(node: DockNode): unknown {
  if (isDockLeaf(node)) return node.pane;
  return node.items.map((item) => [Number(item.size.toFixed(4)), shares(item.node)]);
}

const workspace = { widthPx: 1400, heightPx: 900 };
const defaultArrangement = (): DockArrangement => legacyDockArrangement(workspace, memoryStorage());

describe('dock arrangement storage', () => {
  test('scopes the key to the project', () => {
    expect(dockArrangementStorageKey('/a/notes')).not.toBe(dockArrangementStorageKey('/b/notes'));
    expect(dockArrangementStorageKey('/a/notes')).toMatch(/^ok-dock-arrangement-v1:/);
  });

  test('a host whose origin already belongs to one project uses the unscoped name', () => {
    expect(dockArrangementStorageKey(null)).toBe('ok-dock-arrangement-v1');
  });

  test('reads back a written arrangement', () => {
    const storage = memoryStorage();
    const key = dockArrangementStorageKey('/a/notes');
    const written = withDockPaneAtEdge(defaultArrangement(), 'agents', 'bottom');
    writeDockArrangement(key, written, storage);
    const read = readDockArrangement(key, storage);
    expect(read === null ? null : shares(read.tree)).toEqual(shares(written.tree));
  });

  test('reads an arrangement saved while the Terminal pane existed, without the Terminal', () => {
    const key = dockArrangementStorageKey('/a/notes');
    const saved = {
      tree: {
        direction: 'row',
        items: [
          {
            size: 0.6,
            node: {
              direction: 'column',
              items: [
                { size: 0.7, node: { pane: 'editor' } },
                { size: 0.3, node: { pane: 'terminal' } },
              ],
            },
          },
          { size: 0.4, node: { pane: 'agents' } },
        ],
      },
      terminalShares: { bottom: 0.3, right: 0.5 },
    };
    const read = readDockArrangement(key, memoryStorage({ [key]: JSON.stringify(saved) }));
    expect(read === null ? null : shares(read.tree)).toEqual([
      [0.6, 'editor'],
      [0.4, 'agents'],
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('says nothing when no arrangement was ever stored', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readDockArrangement(dockArrangementStorageKey('/a/notes'), memoryStorage())).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  test.each([
    ['text that is not JSON', '{not json'],
    ['JSON that is not a tree', JSON.stringify({ tree: { direction: 'row', items: [] } })],
    [
      'a tree missing a pane',
      JSON.stringify({
        tree: {
          direction: 'row',
          items: [
            { size: 1, node: { pane: 'editor' } },
            { size: 1, node: { pane: 'terminal' } },
          ],
        },
      }),
    ],
    ['a bare tree', JSON.stringify(DEFAULT_DOCK_TREE)],
  ])('gives no arrangement for %s, and names the record it ignored', (_label, raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = dockArrangementStorageKey('/a/notes');
    expect(readDockArrangement(key, memoryStorage({ [key]: raw }))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(key);
  });

  test('gives no tree when storage itself throws, and names the key it could not use', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage: DockArrangementStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readDockArrangement('ok-dock-arrangement-v1:blocked', storage)).toBeNull();
    expect(() =>
      writeDockArrangement('ok-dock-arrangement-v1:blocked', defaultArrangement(), storage),
    ).not.toThrow();
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining('reading ok-dock-arrangement-v1:blocked failed'),
      expect.stringContaining('writing ok-dock-arrangement-v1:blocked failed'),
    ]);
  });
});

describe('legacyDockArrangement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('a profile that never stored a layout gets the default tree', () => {
    expect(shares(defaultArrangement().tree)).toEqual(shares(DEFAULT_DOCK_TREE));
  });

  test.each(['', 'not a number'])(
    'an unreadable stored chat width %j seeds what no stored value does',
    (value) => {
      const { tree } = legacyDockArrangement(
        workspace,
        memoryStorage({ 'ok-terminal-width-v1': value }),
      );
      expect(shares(tree)).toEqual(shares(DEFAULT_DOCK_TREE));
    },
  );

  test("a stored chat width becomes chat's share of the window", () => {
    const { tree } = legacyDockArrangement(
      workspace,
      memoryStorage({ 'ok-terminal-width-v1': '700' }),
    );
    expect(shape(tree)).toEqual({ row: ['editor', 'agents'] });
    expect(shares(tree)).toEqual([
      [0.5, 'editor'],
      [0.5, 'agents'],
    ]);
  });

  test('a window with no size yet seeds the default shares', () => {
    const { tree } = legacyDockArrangement(
      { widthPx: 0, heightPx: 0 },
      memoryStorage({ 'ok-terminal-width-v1': '700' }),
    );
    expect(shares(tree)).toEqual(shares(DEFAULT_DOCK_TREE));
  });

  test('a stored chat width wider than three fifths of the window is held to three fifths', () => {
    const { tree } = legacyDockArrangement(
      { widthPx: 1000, heightPx: 900 },
      memoryStorage({ 'ok-terminal-width-v1': '900' }),
    );
    expect(shares(tree)).toEqual([
      [0.4, 'editor'],
      [0.6, 'agents'],
    ]);
  });

  test('a stored chat width under a tenth of the window is raised to a tenth', () => {
    const { tree } = legacyDockArrangement(
      { widthPx: 4000, heightPx: 900 },
      memoryStorage({ 'ok-terminal-width-v1': '320' }),
    );
    expect(shares(tree)).toEqual([
      [0.9, 'editor'],
      [0.1, 'agents'],
    ]);
  });

  test('storage that throws falls back to the default tree, and names the key it could not read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage: DockArrangementStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {},
    };
    expect(shares(legacyDockArrangement(workspace, storage).tree)).toEqual(
      shares(DEFAULT_DOCK_TREE),
    );
    expect(unreadLegacyKeys(warn)).toEqual(EVERY_LEGACY_KEY);
  });
});

const EVERY_LEGACY_KEY = ['ok-terminal-width-v1'];

function unreadLegacyKeys(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls
    .map(([message]) => /reading (\S+) failed/u.exec(String(message))?.[1] ?? String(message))
    .toSorted();
}

describe('legacyDockArrangement on a storage-restricted host', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis as object, 'localStorage');
    vi.restoreAllMocks();
  });

  test('a localStorage getter that throws seeds the default tree, and names every legacy key it could not read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('access denied', 'SecurityError');
      },
    });

    expect(shares(legacyDockArrangement(workspace).tree)).toEqual(shares(DEFAULT_DOCK_TREE));
    expect(unreadLegacyKeys(warn)).toEqual(EVERY_LEGACY_KEY);
  });

  test('a host with no localStorage at all seeds the default tree, and names every legacy key it could not read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Reflect.deleteProperty(globalThis as object, 'localStorage');

    expect(shares(legacyDockArrangement(workspace).tree)).toEqual(shares(DEFAULT_DOCK_TREE));
    expect(unreadLegacyKeys(warn)).toEqual(EVERY_LEGACY_KEY);
  });
});

describe('moving a pane to a workspace edge', () => {
  test('chat along the bottom edge takes its default share of the height', () => {
    const moved = withDockPaneAtEdge(defaultArrangement(), 'agents', 'bottom');
    expect(shape(moved.tree)).toEqual({ column: ['editor', 'agents'] });
    expect(shares(moved.tree)).toEqual([
      [Number((1 - DEFAULT_CHAT_SHARE).toFixed(4)), 'editor'],
      [Number(DEFAULT_CHAT_SHARE.toFixed(4)), 'agents'],
    ]);
  });

  test('a pane already along that edge leaves the arrangement alone', () => {
    const arrangement = defaultArrangement();
    expect(withDockPaneAtEdge(arrangement, 'agents', 'end')).toBe(arrangement);
  });
});
