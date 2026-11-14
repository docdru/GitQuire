import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { WikiAdminGateView } from './WikiAdminGate';

afterEach(() => cleanup());

function renderGate(admin: boolean, logins: string[], repo: string | null) {
  return render(
    <WikiAdminGateView admin={admin} logins={logins} repo={repo}>
      <button type="button">Save</button>
    </WikiAdminGateView>,
  );
}

describe('WikiAdminGateView', () => {
  test('leaves the page alone for admins', () => {
    renderGate(true, ['bob'], 'acme/notes');
    expect(screen.queryByRole('note')).toBeNull();
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
  });

  test('shows members a read-only page and who to ask', () => {
    renderGate(false, ['bob', 'zed'], 'acme/notes');
    expect(screen.getByRole('note').textContent).toBe(
      'Only wiki admins can change these settings. Ask @bob or @zed, or a maintainer of acme/notes.',
    );
    const fieldset = screen.getByTestId('wiki-admin-read-only').querySelector('fieldset');
    expect(fieldset?.disabled).toBe(true);
    expect(fieldset?.hasAttribute('inert')).toBe(true);
  });

  test('names only the repository when no admins are listed', () => {
    renderGate(false, [], 'acme/notes');
    expect(screen.getByRole('note').textContent).toBe(
      'Only maintainers of acme/notes can change these settings.',
    );
  });
});
