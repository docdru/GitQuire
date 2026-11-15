import { afterEach, describe, expect, test, vi } from 'vitest';
import { type DockPaneMove, subscribeDockPaneMoves } from '@/lib/dock-move-requests';
import { PALETTE_COMMANDS, type PaletteCommandContext } from './command-palette-commands';

let stopListening: (() => void) | undefined;

afterEach(() => {
  stopListening?.();
  stopListening = undefined;
});

describe('dock move palette commands', () => {
  test.each([
    ['move-agents-left', { pane: 'agents', side: 'left' }],
    ['move-editor-bottom', { pane: 'editor', side: 'bottom' }],
  ] as const)('%s closes the palette and asks for that pane at that edge', (id, move) => {
    const requested: DockPaneMove[] = [];
    stopListening = subscribeDockPaneMoves((request) => requested.push(request));
    const command = PALETTE_COMMANDS.find((entry) => entry.id === id);
    if (command === undefined) throw new Error(`no ${id} command`);
    const closePalette = vi.fn();

    command.dispatch({ closePalette } as unknown as PaletteCommandContext);

    expect(closePalette).toHaveBeenCalledOnce();
    expect(requested).toEqual([move]);
  });

  test('the moves only show up when searched for', () => {
    const moves = PALETTE_COMMANDS.filter((entry) => /^move-(editor|agents)-/.test(entry.id));
    expect(moves).toHaveLength(8);
    expect(new Set(moves.map((entry) => entry.visibility))).toEqual(new Set(['search-only']));
  });
});
