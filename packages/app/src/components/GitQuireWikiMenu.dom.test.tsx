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
              address: '/w/team/a/',
              admin: true,
              state: 'on',
              unread: 2,
            },
            {
              key: 'github-3',
              owner: 'team',
              name: 'c',
              address: '/w/team/c/',
              admin: false,
              state: 'on',
              unread: 3,
            },
            {
              key: 'github-2',
              owner: 'team',
              name: 'b',
              address: '/w/team/b/',
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
    window.history.replaceState(null, '', '/w/team/a/');
    repository = { owner: 'team', name: 'a', url: 'https://github.com/team/a', host: 'GitHub' };
    render(<WebProjectName />, { wrapper: TooltipProvider });
    expect(screen.getByTestId('web-project-name-label').textContent).toBe('team/a');
    await waitFor(() => expect(requested).toEqual(['/api/front-door/wikis']));
    expect((await screen.findByTestId('wiki-menu-badge')).textContent).toBe(
      '3Other wikis, 3 unread',
    );
    await userEvent.click(screen.getByTestId('web-project-name'));
    const menu = await screen.findByTestId('wiki-menu');
    const here = menu.querySelector('[data-wiki="github-1"]');
    expect(here?.getAttribute('href')).toBe('/w/team/a/');
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
  });
});
