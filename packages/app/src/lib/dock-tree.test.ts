import { describe, expect, test } from 'vitest';
import {
  DEFAULT_CHAT_SHARE,
  DEFAULT_DOCK_TREE,
  type DockGroup,
  type DockNode,
  dockPaneDirection,
  dockTreePanes,
  isDockLeaf,
  moveDockPane,
  moveDockPaneToEdge,
  normalizeDockTree,
  parseDockTree,
  resizeDockGroup,
  swapDockPanes,
  type VisibleDockGroup,
  visibleDockTree,
} from './dock-tree.ts';
import type { PaneId } from './pane-visibility-store.ts';

function shape(node: DockNode): unknown {
  if (isDockLeaf(node)) return node.pane;
  return { [node.direction]: node.items.map((item) => shape(item.node)) };
}

function sizes(node: DockNode): number[] {
  return isDockLeaf(node) ? [] : node.items.map((item) => Number(item.size.toFixed(4)));
}

function only(...panes: PaneId[]) {
  return (pane: PaneId) => panes.includes(pane);
}

const everyPane = only('editor', 'agents');

describe('parseDockTree', () => {
  test('reads back the default tree', () => {
    const parsed = parseDockTree(JSON.parse(JSON.stringify(DEFAULT_DOCK_TREE)));
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(shape(parsed)).toEqual({ row: ['editor', 'agents'] });
    expect(sizes(parsed)).toEqual([
      Number((1 - DEFAULT_CHAT_SHARE).toFixed(4)),
      Number(DEFAULT_CHAT_SHARE.toFixed(4)),
    ]);
  });

  test.each([
    ['a value that is not a tree', 'editor'],
    ['null', null],
    [
      'an unknown pane',
      {
        direction: 'row',
        items: [
          { size: 1, node: { pane: 'graph' } },
          { size: 1, node: { pane: 'editor' } },
        ],
      },
    ],
    [
      'a pane listed twice',
      {
        direction: 'row',
        items: [
          { size: 1, node: { pane: 'editor' } },
          { size: 1, node: { pane: 'editor' } },
          { size: 1, node: { pane: 'agents' } },
        ],
      },
    ],
    [
      'a missing pane',
      {
        direction: 'row',
        items: [
          { size: 1, node: { pane: 'editor' } },
          { size: 1, node: { pane: 'terminal' } },
        ],
      },
    ],
    [
      'an unknown direction',
      {
        direction: 'diagonal',
        items: [
          { size: 1, node: { pane: 'editor' } },
          { size: 1, node: { pane: 'agents' } },
        ],
      },
    ],
    [
      'a group with one item',
      {
        direction: 'row',
        items: [
          {
            size: 1,
            node: {
              direction: 'column',
              items: [{ size: 1, node: { pane: 'editor' } }],
            },
          },
          { size: 1, node: { pane: 'agents' } },
        ],
      },
    ],
    [
      'a size of zero',
      {
        direction: 'row',
        items: [
          { size: 0, node: { pane: 'editor' } },
          { size: 1, node: { pane: 'agents' } },
        ],
      },
    ],
    [
      'a size that is not a number',
      {
        direction: 'row',
        items: [
          { size: '1', node: { pane: 'editor' } },
          { size: 1, node: { pane: 'agents' } },
        ],
      },
    ],
    [
      'sizes too large to add up',
      {
        direction: 'row',
        items: [
          { size: 1e308, node: { pane: 'editor' } },
          { size: 1e308, node: { pane: 'agents' } },
        ],
      },
    ],
  ])('refuses %s', (_label, value) => {
    expect(parseDockTree(value)).toBeNull();
  });

  test('flattens a row nested in a row and keeps the proportions', () => {
    const parsed = parseDockTree({
      direction: 'row',
      items: [
        {
          size: 1,
          node: {
            direction: 'row',
            items: [
              { size: 1, node: { pane: 'editor' } },
              { size: 1, node: { pane: 'agents' } },
            ],
          },
        },
        { size: 1, node: { pane: 'terminal' } },
      ],
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(shape(parsed)).toEqual({ row: ['editor', 'agents'] });
    expect(sizes(parsed)).toEqual([0.5, 0.5]);
  });
});

describe('reading a tree saved while the Terminal pane existed', () => {
  test('the old default, Terminal under the editor, gives the editor the whole column', () => {
    const parsed = parseDockTree({
      direction: 'row',
      items: [
        {
          size: 0.7,
          node: {
            direction: 'column',
            items: [
              { size: 0.7, node: { pane: 'editor' } },
              { size: 0.3, node: { pane: 'terminal' } },
            ],
          },
        },
        { size: 0.3, node: { pane: 'agents' } },
      ],
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(shape(parsed)).toEqual({ row: ['editor', 'agents'] });
    expect(sizes(parsed)).toEqual([0.7, 0.3]);
  });

  test('a Terminal between the editor and chat leaves the two sharing the row', () => {
    const parsed = parseDockTree({
      direction: 'row',
      items: [
        { size: 0.5, node: { pane: 'editor' } },
        { size: 0.25, node: { pane: 'terminal' } },
        { size: 0.25, node: { pane: 'agents' } },
      ],
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(shape(parsed)).toEqual({ row: ['editor', 'agents'] });
    expect(sizes(parsed)).toEqual([0.6667, 0.3333]);
  });

  test('a Terminal along the bottom edge leaves the row above it as the whole tree', () => {
    const parsed = parseDockTree({
      direction: 'column',
      items: [
        {
          size: 0.75,
          node: {
            direction: 'row',
            items: [
              { size: 0.6, node: { pane: 'editor' } },
              { size: 0.4, node: { pane: 'agents' } },
            ],
          },
        },
        { size: 0.25, node: { pane: 'terminal' }, alongEdge: true },
      ],
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(shape(parsed)).toEqual({ row: ['editor', 'agents'] });
    expect(sizes(parsed)).toEqual([0.6, 0.4]);
  });

  test('a Terminal in a row under the editor leaves chat under the editor', () => {
    const parsed = parseDockTree({
      direction: 'column',
      items: [
        { size: 0.6, node: { pane: 'editor' } },
        {
          size: 0.4,
          node: {
            direction: 'row',
            items: [
              { size: 0.5, node: { pane: 'agents' } },
              { size: 0.5, node: { pane: 'terminal' } },
            ],
          },
        },
      ],
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(shape(parsed)).toEqual({ column: ['editor', 'agents'] });
    expect(sizes(parsed)).toEqual([0.6, 0.4]);
  });
});

describe('normalizeDockTree', () => {
  test('unwraps a group left with one item', () => {
    const tree: DockGroup = {
      direction: 'row',
      items: [
        { size: 1, node: { direction: 'column', items: [{ size: 1, node: { pane: 'editor' } }] } },
        { size: 1, node: { pane: 'agents' } },
      ],
    };
    expect(shape(normalizeDockTree(tree))).toEqual({ row: ['editor', 'agents'] });
  });
});

describe('visibleDockTree', () => {
  test('keeps every pane and the full-tree slot of each item', () => {
    const visible = visibleDockTree(DEFAULT_DOCK_TREE, everyPane) as VisibleDockGroup;
    expect(visible.path).toEqual([]);
    expect(visible.items.map((item) => item.slot)).toEqual([0, 1]);
    expect(visible.items.reduce((sum, item) => sum + item.share, 0)).toBeCloseTo(1);
  });

  test('a single visible pane is the whole tree', () => {
    expect(visibleDockTree(DEFAULT_DOCK_TREE, only('agents'))).toEqual({ pane: 'agents' });
  });

  test('nothing visible gives no tree', () => {
    expect(visibleDockTree(DEFAULT_DOCK_TREE, only())).toBeNull();
  });
});

describe('resizeDockGroup', () => {
  test('changes the shares of the group', () => {
    const resized = resizeDockGroup(
      DEFAULT_DOCK_TREE,
      [],
      new Map([
        [0, 0.25],
        [1, 0.75],
      ]),
    );
    expect(sizes(resized)).toEqual([0.25, 0.75]);
  });

  test('leaves the tree alone for a path that is not a group', () => {
    expect(resizeDockGroup(DEFAULT_DOCK_TREE, [1], new Map([[0, 1]]))).toBe(DEFAULT_DOCK_TREE);
    expect(resizeDockGroup(DEFAULT_DOCK_TREE, [7], new Map([[0, 1]]))).toBe(DEFAULT_DOCK_TREE);
  });

  test('leaves the tree alone for a share that is not positive', () => {
    expect(
      resizeDockGroup(
        DEFAULT_DOCK_TREE,
        [],
        new Map([
          [0, 0],
          [1, 1],
        ]),
      ),
    ).toBe(DEFAULT_DOCK_TREE);
  });
});

describe('moveDockPane', () => {
  test('puts chat under the editor, and back beside it', () => {
    const under = moveDockPane(DEFAULT_DOCK_TREE, 'agents', 'editor', 'bottom', 0.3);
    expect(shape(under)).toEqual({ column: ['editor', 'agents'] });
    expect(dockPaneDirection(under, 'agents')).toBe('column');
    const beside = moveDockPane(under, 'agents', 'editor', 'end');
    expect(shape(beside)).toEqual({ row: ['editor', 'agents'] });
    expect(dockPaneDirection(beside, 'agents')).toBe('row');
  });

  test('every move keeps both panes, each once', () => {
    const edges = ['start', 'end', 'top', 'bottom'] as const;
    const panes: PaneId[] = ['editor', 'agents'];
    for (const pane of panes) {
      for (const target of panes) {
        for (const edge of edges) {
          const moved = moveDockPane(DEFAULT_DOCK_TREE, pane, target, edge);
          expect(dockTreePanes(moved).toSorted()).toEqual(['agents', 'editor']);
          expect(parseDockTree(JSON.parse(JSON.stringify(moved)))).not.toBeNull();
        }
      }
    }
  });

  test('moving a pane onto itself changes nothing', () => {
    expect(moveDockPane(DEFAULT_DOCK_TREE, 'editor', 'editor', 'end')).toBe(DEFAULT_DOCK_TREE);
  });
});

describe('moveDockPaneToEdge', () => {
  test('puts chat along the start edge', () => {
    const moved = moveDockPaneToEdge(DEFAULT_DOCK_TREE, 'agents', 'start', 0.3);
    expect(shape(moved)).toEqual({ row: ['agents', 'editor'] });
    expect(sizes(moved)).toEqual([0.3, 0.7]);
  });

  test('puts the editor along the top edge', () => {
    const moved = moveDockPaneToEdge(DEFAULT_DOCK_TREE, 'editor', 'top', 0.6);
    expect(shape(moved)).toEqual({ column: ['editor', 'agents'] });
    expect(sizes(moved)).toEqual([0.6, 0.4]);
  });

  test('a pane already along that edge stays put at its size', () => {
    expect(moveDockPaneToEdge(DEFAULT_DOCK_TREE, 'agents', 'end', 0.5)).toBe(DEFAULT_DOCK_TREE);
  });

  test('every edge keeps both panes, each once, in a tree that reads back', () => {
    const edges = ['start', 'end', 'top', 'bottom'] as const;
    const panes: PaneId[] = ['editor', 'agents'];
    for (const pane of panes) {
      for (const edge of edges) {
        const moved = moveDockPaneToEdge(DEFAULT_DOCK_TREE, pane, edge, 1 / 3);
        expect(dockTreePanes(moved).toSorted()).toEqual(['agents', 'editor']);
        expect(parseDockTree(JSON.parse(JSON.stringify(moved)))).not.toBeNull();
      }
    }
  });
});

describe('swapDockPanes', () => {
  test('trades the places of two panes and keeps every size', () => {
    const swapped = swapDockPanes(DEFAULT_DOCK_TREE, 'editor', 'agents');
    expect(shape(swapped)).toEqual({ row: ['agents', 'editor'] });
    expect(sizes(swapped)).toEqual(sizes(DEFAULT_DOCK_TREE));
  });
});
