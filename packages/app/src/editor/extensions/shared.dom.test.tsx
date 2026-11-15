import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, test } from 'vitest';
import { pressEditorKey } from '../editor-rig.test-helper';
import { sharedExtensions } from './shared';

describe('sharedExtensions module graph', () => {
  afterEach(() => {
    cleanup();
  });

  test('loads under the DOM test substrate without initialization cycles', async () => {
    expect(sharedExtensions.length).toBeGreaterThan(0);
  });

  const flushRaf = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );

  const dispatchKey = (editor: Editor, key: string, opts: { shiftKey?: boolean } = {}) =>
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        code: key,
        shiftKey: opts.shiftKey ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );

  test('Escape on a top-level NodeSelection blurs the editor (WCAG 2.1.2 keyboard exit, paired with TabFocusTrap)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new Editor({
      element: container,
      content: '<p>alpha</p>',
      extensions: sharedExtensions,
      editable: true,
    });

    try {
      editor.view.dom.focus();
      expect(document.activeElement).toBe(editor.view.dom);

      editor.commands.setNodeSelection(0);
      expect(editor.state.selection.$from.depth).toBe(0);

      dispatchKey(editor, 'Escape');
      await flushRaf();

      expect(document.activeElement).not.toBe(editor.view.dom);
    } finally {
      editor.destroy();
      container.remove();
    }
  });

  test('Escape on a TextSelection inside a paragraph escalates to NodeSelection (does NOT blur on first press)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new Editor({
      element: container,
      content: '<p>alpha</p>',
      extensions: sharedExtensions,
      editable: true,
    });

    try {
      editor.view.dom.focus();
      editor.commands.setTextSelection({ from: 1, to: 6 });
      expect(document.activeElement).toBe(editor.view.dom);

      dispatchKey(editor, 'Escape');
      await flushRaf();

      expect(document.activeElement).toBe(editor.view.dom);
      expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    } finally {
      editor.destroy();
      container.remove();
    }
  });

  test('Tab inside a code block inserts 2 spaces (Prettier/Biome convention; the TabFocusTrap fall-through must NOT swallow it)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new Editor({
      element: container,
      content: '<pre><code></code></pre>',
      extensions: sharedExtensions,
      editable: true,
    });

    try {
      editor.commands.focus();
      editor.commands.setTextSelection(1);
      dispatchKey(editor, 'Tab');
      expect(editor.getText().replace(/\n+$/, '')).toBe('  ');
    } finally {
      editor.destroy();
      container.remove();
    }
  });

  test('Shift-Tab inside a code block removes up to 2 leading spaces (symmetric unindent)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new Editor({
      element: container,
      content: '<pre><code>    hello</code></pre>',
      extensions: sharedExtensions,
      editable: true,
    });

    try {
      editor.commands.focus();
      editor.commands.setTextSelection(7);
      dispatchKey(editor, 'Tab', { shiftKey: true });
      expect(editor.getText().replace(/\n+$/, '')).toBe('  hello');
      dispatchKey(editor, 'Tab', { shiftKey: true });
      expect(editor.getText().replace(/\n+$/, '')).toBe('hello');
    } finally {
      editor.destroy();
      container.remove();
    }
  });

  test('advertised strikethrough shortcut toggles strike formatting', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new Editor({
      element: container,
      content: '<p>alpha</p>',
      extensions: sharedExtensions,
      editable: true,
    });

    try {
      editor.commands.setTextSelection({ from: 1, to: 6 });

      expect(editor.isActive('strike')).toBe(false);
      pressEditorKey(editor, 'Mod-Shift-x');
      expect(editor.isActive('strike')).toBe(true);
      expect(editor.getHTML()).toContain('<s>alpha</s>');
    } finally {
      editor.destroy();
      container.remove();
    }
  });
});
