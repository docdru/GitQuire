import { describe, expect, test } from 'vitest';
import { formatTokens, parseChatEvents, toolActivity } from './chat-api';

describe('chat stream parsing', () => {
  test('returns whole lines as events and keeps a partial line', () => {
    const { events, rest } = parseChatEvents(
      '{"type":"text","text":"Hi"}\n{"type":"done","stopped":"end"}\n{"type":"te',
    );
    expect(events).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'done', stopped: 'end' },
    ]);
    expect(rest).toBe('{"type":"te');
  });

  test('skips blank and broken lines', () => {
    expect(parseChatEvents('\nnot json\n{"type":"text","text":"x"}\n').events).toEqual([
      { type: 'text', text: 'x' },
    ]);
  });
});

describe('chat helpers', () => {
  test('formats token counts compactly', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(456_789)).toBe('457k');
  });

  test('describes tool activity', () => {
    expect(toolActivity('search', { query: 'plan' })).toEqual({ kind: 'search', detail: 'plan' });
    expect(toolActivity('exec', { command: 'cat a.md' })).toEqual({
      kind: 'read',
      detail: 'cat a.md',
    });
    expect(toolActivity('edit', { document: { path: 'notes/a' } })).toEqual({
      kind: 'edit',
      detail: 'notes/a',
    });
    expect(toolActivity('move', {})).toEqual({ kind: 'move', detail: null });
    expect(toolActivity('mystery', {})).toEqual({ kind: 'other', detail: 'mystery' });
  });
});
