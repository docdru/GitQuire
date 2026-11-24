import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

let repository: { owner: string; name: string; url: string; host: string } | null = null;

vi.mock('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/data', pathSeparator: '/' }),
}));
vi.mock('@/lib/gitquire/repository', () => ({ useGitQuireRepository: () => repository }));

vi.mock('@lingui/react/macro', () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

const { WebProjectName } = await import('./WebProjectName');

const requested: string[] = [];

beforeEach(() => {
  requested.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      requested.push(input);
      return new Response(
        JSON.stringify({
          wikis: [
            {
              key: 'github-1',
              owner: 'team',
              name: 'a',
              address: '/w/github/team/a/',
              admin: true,
              state: 'on',
              unread: 2,
            },
            {
              key: 'github-3',
              owner: 'team',
              name: 'c',
              address: '/w/github/team/c/',
              admin: false,
              state: 'on',
              unread: 3,
            },
            {
              key: 'github-2',
              owner: 'team',
              name: 'b',
              address: '/w/github/team/b/',
              admin: true,
              state: 'disconnected',
              why: 'GitQuire no longer has access to this repository.',
            },
          ],
          hosts: 'This server hosts wikis from team.',
          addWikiPage: '/add-wiki',
        }),
        { status: 200 },
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  repository = null;
  window.history.replaceState(null, '', '/');
});

describe('the wiki menu', () => {
  test('stays the single-wiki repository link without a wiki prefix', () => {
    repository = { owner: 'team', name: 'a', url: 'https://github.com/team/a', host: 'GitHub' };
    render(<WebProjectName />, { wrapper: TooltipProvider });
    expect(screen.getByTestId('web-project-name').getAttribute('href')).toBe(
      'https://github.com/team/a',
    );
    expect(requested).toEqual([]);
    expect(screen.queryByTestId('wiki-menu-badge')).toBeNull();
  });

  test("lists the person's wikis behind the front door, from the front door's own address", async () => {
    window.history.replaceState(null, '', '/w/github/team/a/');
    repository = { owner: 'team', name: 'a', url: 'https://github.com/team/a', host: 'GitHub' };
    render(<WebProjectName />, { wrapper: TooltipProvider });
    expect(screen.getByTestId('web-project-name-label').textContent).toBe('github/team/a');
    expect(screen.getByTestId('web-project-name-label').getAttribute('title')).toBe(
      'github/team/a',
    );
    await waitFor(() => expect(requested).toEqual(['/api/front-door/wikis']));
    expect((await screen.findByTestId('wiki-menu-badge')).textContent).toBe(
      '3Other wikis, 3 unread',
    );
    await userEvent.click(screen.getByTestId('web-project-name'));
    const menu = await screen.findByTestId('wiki-menu');
    const here = menu.querySelector('[data-wiki="github-1"]');
    expect(here?.getAttribute('href')).toBe('/w/github/team/a/');
    expect(here?.getAttribute('aria-current')).toBe('page');
    expect(here?.querySelector('[data-unread]')?.textContent).toBe('2 Unread');
    expect(menu.querySelector('[data-wiki="github-3"] [data-unread]')?.textContent).toBe(
      '3 Unread',
    );
    const other = menu.querySelector('[data-wiki="github-2"]');
    expect(other?.textContent).toContain('Disconnected');
    expect(other?.getAttribute('title')).toBe('GitQuire no longer has access to this repository.');
    expect(screen.getByText('All wikis').closest('a')?.getAttribute('href')).toBe('/');
    expect(screen.getByText('Add a wiki').closest('a')?.getAttribute('href')).toBe('/add-wiki');
    expect(screen.getByText('Open team/a on GitHub').closest('a')?.getAttribute('href')).toBe(
      'https://github.com/team/a',
    );
    expect(screen.getByTestId('wiki-menu-current').textContent).toBe('github/team/a');
    expect(menu.querySelector('[data-sign-in-host]')).toBeNull();
    expect(screen.queryByText('Sign out…')).toBeNull();
  });

  test('offers the other host and shows the full name, shortened from the left where tight', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        requested.push(input);
        return new Response(
          JSON.stringify({
            wikis: [
              {
                key: 'github-1',
                hostKey: 'github',
                hostLabel: 'GitHub',
                fullName: 'github/a-very-long-organisation-name/handbook',
                owner: 'a-very-long-organisation-name',
                name: 'handbook',
                address: '/w/github/a-very-long-organisation-name/handbook/',
                state: 'on',
              },
            ],
            accounts: [{ host: 'github', label: 'GitHub', login: 'alice' }],
            signInWith: [{ host: 'forgejo', label: 'Forgejo', address: '/auth/forgejo/login' }],
          }),
          { status: 200 },
        );
      }),
    );
    window.history.replaceState(null, '', '/w/github/a-very-long-organisation-name/handbook/');
    render(<WebProjectName />, { wrapper: TooltipProvider });
    const label = screen.getByTestId('web-project-name-label');
    expect(label.getAttribute('dir')).toBe('rtl');
    expect(label.querySelector('bdi')?.getAttribute('dir')).toBe('ltr');
    expect(label.getAttribute('title')).toBe('github/a-very-long-organisation-name/handbook');
    await userEvent.click(screen.getByTestId('web-project-name'));
    await screen.findByTestId('wiki-menu');
    expect(screen.getByText('Sign in with Forgejo').closest('a')?.getAttribute('href')).toBe(
      '/auth/forgejo/login?next=%2Fw%2Fgithub%2Fa-very-long-organisation-name%2Fhandbook%2F',
    );
    expect(screen.getByText('Sign out…').closest('a')?.getAttribute('href')).toBe('/auth/logout');
  });
});
