import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { describe, expect, test, vi } from 'vitest';
import { settledSuggestionRender } from './suggestion-settled';

function props(items: string[], loading: boolean): SuggestionProps<string, string> {
  return { items, loading } as unknown as SuggestionProps<string, string>;
}

const keyDown = {} as SuggestionKeyDownProps;

describe('settledSuggestionRender', () => {
  test('starts the menu only once items have arrived and skips loading updates', () => {
    const onStart = vi.fn();
    const onUpdate = vi.fn();
    const onKeyDown = vi.fn(() => true);
    const render = settledSuggestionRender<string>(() => ({ onStart, onUpdate, onKeyDown }))();

    render.onStart?.(props([], true));
    render.onUpdate?.(props([], true));
    expect(onStart).not.toHaveBeenCalled();
    expect(render.onKeyDown?.(keyDown)).toBe(false);

    render.onUpdate?.(props(['a'], false));
    expect(onStart).toHaveBeenCalledWith(props(['a'], false));
    expect(onUpdate).not.toHaveBeenCalled();

    render.onUpdate?.(props([], true));
    expect(onUpdate).not.toHaveBeenCalled();
    render.onUpdate?.(props(['b'], false));
    expect(onUpdate).toHaveBeenCalledWith(props(['b'], false));
    expect(render.onKeyDown?.(keyDown)).toBe(true);
  });

  test('forwards a start that already has its items', () => {
    const onStart = vi.fn();
    const render = settledSuggestionRender<string>(() => ({ onStart }))();
    render.onStart?.(props(['a'], false));
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
