import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  keepUnsavedAfterRestart,
  resetUnsavedAfterRestartForTests,
  unsavedAfterRestart,
} from '@/editor/unsaved-after-restart';
import { UnsavedAfterRestartNotice } from './UnsavedAfterRestartNotice';

afterEach(() => {
  act(() => resetUnsavedAfterRestartForTests());
});

describe('notice for typing that could not be merged back after a server restart', () => {
  it('shows nothing until the page has refused text, then offers it for copying', () => {
    render(<UnsavedAfterRestartNotice docName="notes" />);
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => keepUnsavedAfterRestart('other', 'not this page'));
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => keepUnsavedAfterRestart('notes', '# Notes\n\nMy unsaved line.\n'));
    expect(screen.getByRole('alert').textContent).toContain(
      'Some of your recent typing could not be saved',
    );
    expect(
      (screen.getByLabelText('Your version of the page') as HTMLTextAreaElement).value,
    ).toContain('My unsaved line.');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('goes away when dismissed', () => {
    render(<UnsavedAfterRestartNotice docName="notes" />);
    act(() => keepUnsavedAfterRestart('notes', 'text'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(unsavedAfterRestart('notes')).toBeUndefined();
  });
});
