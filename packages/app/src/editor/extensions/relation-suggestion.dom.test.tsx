import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { relationSuggestionKey } from './relation-suggestion';
import { sharedExtensions } from './shared';
import { wikiLinkSuggestionKey } from './wiki-link-suggestion';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/gitquire/typed-links')) {
        return jsonResponse({
          links: [],
          relations: [
            { name: 'blocks', count: 3 },
            { name: 'supersedes', count: 1 },
          ],
          truncated: false,
        });
      }
      if (url.includes('/api/pages')) return jsonResponse({ pages: [] });
      return new Response('{}', { status: 404 });
    }),
  );
}

async function pressOnceLoaded(editor: Editor, key: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    const plugin = relationSuggestionKey.get(editor.state);
    const handled = plugin?.props.handleKeyDown?.call(
      plugin,
      editor.view,
      new KeyboardEvent('keydown', { key, bubbles: true }),
    );
    if (handled === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return false;
}

describe('relation name suggestion after ::', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('choosing a name writes name:: [[ and opens the link picker', async () => {
    stubFetch();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new Editor({
      element: container,
      extensions: sharedExtensions,
      editable: true,
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    try {
      editor.commands.focus('end');
      editor.commands.insertContent('bl::');
      expect(await pressOnceLoaded(editor, 'Enter')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(editor.state.doc.textContent).toBe('blocks:: [[');
      const wikiState = wikiLinkSuggestionKey.getState(editor.state) as
        | { active?: boolean }
        | undefined;
      expect(wikiState?.active).toBe(true);
    } finally {
      editor.destroy();
      container.remove();
    }
  });
});
