import { describe, expect, test } from 'vitest';
import {
  formatShortcut,
  formatShortcutBindingLabel,
  formatShortcutLabel,
  isEditableShortcutTarget,
  KEYBOARD_SHORTCUTS,
  type KeyboardShortcutId,
  matchesKeyboardShortcut,
} from './keyboard-shortcuts';

describe('keyboard shortcut registry', () => {
  test('uses unique shortcut ids', () => {
    const ids = KEYBOARD_SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('formats spoken shortcut labels for accessible names', () => {
    expect(formatShortcutLabel('toggle-files-sidebar', 'mac')).toBe('Option Command S');
    expect(formatShortcutLabel('toggle-files-sidebar', 'windowsLinux')).toBe('Control Alt S');
    expect(
      formatShortcutBindingLabel(
        { mac: '⌥⌘ ↑ / ⌥⌘ ↓', windowsLinux: 'Ctrl Alt ↑ / Ctrl Alt ↓' },
        'mac',
      ),
    ).toBe('Option Command Up Arrow or Option Command Down Arrow');
    expect(formatShortcutLabel('source-folding', 'mac')).toBe(
      'Option Command Left Bracket or Option Command Right Bracket',
    );
    expect(formatShortcutLabel('source-folding', 'windowsLinux')).toBe(
      'Control Shift Left Bracket or Control Shift Right Bracket',
    );
  });

  test('matches settings shortcut exactly and excludes Alt combinations', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: ',' },
        'settings',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, key: ',' },
        'settings',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: ',' },
        'settings',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, key: ',' },
        'settings',
        'mac',
      ),
    ).toBe(false);
  });

  test('matches CmdOrCtrl renderer shortcuts regardless of detected platform', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: true, key: 's', code: 'KeyS' },
        'toggle-files-sidebar',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: true, key: 's', code: 'KeyS' },
        'toggle-files-sidebar',
        'mac',
      ),
    ).toBe(false);
  });

  test('matches new file on the Alt chord and leaves Cmd/Ctrl+N to the browser', () => {
    expect(formatShortcut('new-item', 'mac')).toBe('⌥⌘ N');
    expect(formatShortcut('new-item', 'windowsLinux')).toBe('Ctrl Alt N');
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, key: 'n', code: 'KeyN' },
        'new-item',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: true, key: 'n', code: 'KeyN' },
        'new-item',
        'windowsLinux',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: 'n', code: 'KeyN' },
        'new-item',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'n', code: 'KeyN' },
        'new-item',
        'windowsLinux',
      ),
    ).toBe(false);
  });

  test('formats the toggle-agent-panel shortcut like the other panel toggles', () => {
    expect(formatShortcut('toggle-agent-panel', 'mac')).toBe('⌥⌘ A');
    expect(formatShortcut('toggle-agent-panel', 'windowsLinux')).toBe('Ctrl Alt A');
  });

  test('matches toggle-agent-panel on the Alt chord and leaves Cmd/Ctrl+L to the browser', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, key: 'å', code: 'KeyA' },
        'toggle-agent-panel',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: true, key: 'a', code: 'KeyA' },
        'toggle-agent-panel',
        'windowsLinux',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: 'a', code: 'KeyA' },
        'toggle-agent-panel',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: true, key: 'a', code: 'KeyA' },
        'toggle-agent-panel',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: 'l', code: 'KeyL' },
        'toggle-agent-panel',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'l', code: 'KeyL' },
        'toggle-agent-panel',
        'windowsLinux',
      ),
    ).toBe(false);
  });

  test('ignores AltGr keystrokes, which Windows reports as Ctrl+Alt', () => {
    const altGraphHeld = (key: string) => key === 'AltGraph';
    const noAltGraph = () => false;
    const euroSign = { metaKey: false, ctrlKey: true, altKey: true, key: '€', code: 'KeyE' };
    expect(
      matchesKeyboardShortcut(
        { ...euroSign, getModifierState: altGraphHeld },
        'view-source-at-cursor',
        'windowsLinux',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { ...euroSign, key: 'e', getModifierState: noAltGraph },
        'view-source-at-cursor',
        'windowsLinux',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        {
          metaKey: false,
          ctrlKey: true,
          altKey: true,
          key: 'µ',
          code: 'KeyM',
          getModifierState: altGraphHeld,
        },
        'toggle-editor-mode',
        'windowsLinux',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        {
          metaKey: true,
          ctrlKey: false,
          altKey: true,
          key: '€',
          code: 'KeyE',
          getModifierState: altGraphHeld,
        },
        'view-source-at-cursor',
        'mac',
      ),
    ).toBe(true);
  });

  test('matches command palette on exact Cmd/Ctrl+K only', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: 'k' },
        'command-palette',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'k' },
        'command-palette',
        'windowsLinux',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'k' },
        'command-palette',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, key: 'k' },
        'command-palette',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, key: 'k' },
        'command-palette',
        'mac',
      ),
    ).toBe(false);
  });

  test('add-link shares the exact ⌘K chord with the palette and excludes extra modifiers', () => {
    expect(formatShortcut('add-link', 'mac')).toBe('⌘ K');
    expect(formatShortcut('add-link', 'windowsLinux')).toBe('Ctrl K');
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: 'k' },
        'add-link',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'k' },
        'add-link',
        'windowsLinux',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'k' },
        'add-link',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'k' },
        'add-link',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, key: 'k' },
        'add-link',
        'mac',
      ),
    ).toBe(false);
    const exactCmdK = { metaKey: true, ctrlKey: false, altKey: false, key: 'k' };
    expect(matchesKeyboardShortcut(exactCmdK, 'add-link', 'mac')).toBe(true);
    expect(matchesKeyboardShortcut(exactCmdK, 'command-palette', 'mac')).toBe(true);
  });

  test('opens the command palette on the Alt+P chord, which add-link never claims', () => {
    const macChord = { metaKey: true, ctrlKey: false, altKey: true, key: 'π', code: 'KeyP' };
    expect(matchesKeyboardShortcut(macChord, 'command-palette', 'mac')).toBe(true);
    expect(matchesKeyboardShortcut(macChord, 'add-link', 'mac')).toBe(false);

    const otherChord = { metaKey: false, ctrlKey: true, altKey: true, key: 'p', code: 'KeyP' };
    expect(matchesKeyboardShortcut(otherChord, 'command-palette', 'windowsLinux')).toBe(true);
    expect(matchesKeyboardShortcut(otherChord, 'add-link', 'windowsLinux')).toBe(false);

    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: true, key: 'π', code: 'KeyP' },
        'command-palette',
        'mac',
      ),
    ).toBe(false);
  });

  test('leaves Cmd/Ctrl+P to the browser for printing', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: 'p' },
        'command-palette',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'p' },
        'command-palette',
        'windowsLinux',
      ),
    ).toBe(false);
  });

  test('keeps Cmd+K as the displayed command-palette chord', () => {
    expect(formatShortcut('command-palette', 'mac')).toBe('⌘ K');
    expect(formatShortcut('command-palette', 'windowsLinux')).toBe('Ctrl K');
  });

  test('matches source-aware replace shortcuts per platform', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, key: 'f' },
        'replace',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'h' },
        'replace',
        'windowsLinux',
      ),
    ).toBe(true);
  });

  test('matches find-next and find-previous with strict shift handling', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: 'g' },
        'find-next',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'g' },
        'find-next',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'g' },
        'find-previous',
        'mac',
      ),
    ).toBe(true);
  });

  test('matches F3 find navigation alternates with strict shift handling', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: 'F3' },
        'find-next',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, key: 'F3' },
        'find-next',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, key: 'F3' },
        'find-previous',
        'mac',
      ),
    ).toBe(true);
  });

  test('matches find shortcut with Shift held through allowShiftKey', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'f' },
        'find',
        'mac',
      ),
    ).toBe(true);
  });

  test('detects editable shortcut targets', () => {
    expect(isEditableShortcutTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableShortcutTarget({ isContentEditable: true })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: 'BUTTON' })).toBe(false);
  });

  test('formats the mode-switch shortcuts per platform', () => {
    expect(formatShortcut('toggle-editor-mode', 'mac')).toBe('⌥⌘ M');
    expect(formatShortcut('toggle-editor-mode', 'windowsLinux')).toBe('Ctrl Alt M');
    expect(formatShortcut('view-source-at-cursor', 'mac')).toBe('⌥⌘ E');
    expect(formatShortcut('view-source-at-cursor', 'windowsLinux')).toBe('Ctrl Alt E');
  });

  test('registers the mode-switch commands in their shortcut-help categories', () => {
    const byId = new Map(KEYBOARD_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));
    expect(byId.get('toggle-editor-mode')?.category).toBe('general');
    expect(byId.get('view-source-at-cursor')?.category).toBe('wysiwyg');
  });

  test('the mode-switch chords match only their own id across the whole registry', () => {
    const chords = [
      { id: 'toggle-editor-mode', code: 'KeyM', key: 'm' },
      { id: 'view-source-at-cursor', code: 'KeyE', key: 'e' },
    ] as const;
    for (const chord of chords) {
      const macEvent = {
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
        key: chord.key,
        code: chord.code,
      };
      const winEvent = {
        metaKey: false,
        ctrlKey: true,
        altKey: true,
        shiftKey: false,
        key: chord.key,
        code: chord.code,
      };
      for (const shortcut of KEYBOARD_SHORTCUTS) {
        const id = shortcut.id as KeyboardShortcutId;
        expect(matchesKeyboardShortcut(macEvent, id, 'mac')).toBe(id === chord.id);
        expect(matchesKeyboardShortcut(winEvent, id, 'windowsLinux')).toBe(id === chord.id);
      }
    }
  });

  test('the mode toggle requires its Alt modifier so it never steals Cmd+M', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: 'm', code: 'KeyM' },
        'toggle-editor-mode',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, key: 'm', code: 'KeyM' },
        'toggle-editor-mode',
        'mac',
      ),
    ).toBe(false);
  });
});
