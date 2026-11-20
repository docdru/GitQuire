import { afterEach, describe, expect, test } from 'vitest';
import { EDITOR_OVERLAY_HOST_ATTR, editorOverlayHost } from './editor-overlay-host';

afterEach(() => {
  document.body.replaceChildren();
});

describe('editorOverlayHost', () => {
  test('returns the editor pane an element sits in', () => {
    const pane = document.createElement('div');
    pane.setAttribute(EDITOR_OVERLAY_HOST_ATTR, '');
    const inner = document.createElement('span');
    pane.appendChild(document.createElement('div')).appendChild(inner);
    document.body.appendChild(pane);
    expect(editorOverlayHost(inner)).toBe(pane);
  });

  test('falls back to the body outside an editor pane', () => {
    const loose = document.body.appendChild(document.createElement('span'));
    expect(editorOverlayHost(loose)).toBe(document.body);
    expect(editorOverlayHost(null)).toBe(document.body);
  });
});
