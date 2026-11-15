import { THEME_PLUGINS } from '@inkeep/open-knowledge-core/theme/theme-plugins';
import { cleanup, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { commands } from 'vitest/browser';
import { renderWithI18n } from '../../../tests/foundation/render-with-i18n.test-helper';
import { textMeasurement } from '../../../tests/foundation/theme-contrast.test-helper';
import { Command, CommandItem, CommandList, CommandShortcut } from './command';

afterEach(cleanup);

const HIGHLIGHT_THEMES = [
  { id: 'default', kind: 'light' },
  { id: 'default', kind: 'dark' },
  ...THEME_PLUGINS.filter((theme) => theme.toTokens).map(({ id, kind }) => ({ id, kind })),
];

describe('the highlighted command row', () => {
  let stylesheet: HTMLStyleElement | undefined;

  beforeAll(async () => {
    stylesheet = document.createElement('style');
    stylesheet.textContent = await commands.buildAppStylesheet();
    document.head.append(stylesheet);
  });

  afterAll(() => stylesheet?.remove());

  afterEach(() => {
    delete document.documentElement.dataset.colorTheme;
    document.documentElement.classList.remove('dark');
  });

  for (const theme of HIGHLIGHT_THEMES) {
    test(`keeps its label readable and above its secondary text in ${theme.id} ${theme.kind}`, async () => {
      if (theme.id !== 'default') document.documentElement.dataset.colorTheme = theme.id;
      document.documentElement.classList.toggle('dark', theme.kind === 'dark');
      renderWithI18n(
        <Command>
          <CommandList>
            <CommandItem value="open-plan">
              <span>
                Open <span className="font-semibold text-foreground">plan</span>
              </span>
              <span className="text-muted-foreground">notes/plan.md</span>
              <CommandShortcut>Ctrl O</CommandShortcut>
            </CommandItem>
          </CommandList>
        </Command>,
      );
      await vi.waitFor(() =>
        expect(
          screen.getByText('Ctrl O').closest<HTMLElement>('[data-slot="command-item"]')?.dataset
            .selected,
        ).toBe('true'),
      );
      const ratios = (texts: string[]) =>
        texts.map((text) => {
          const { ratio } = textMeasurement(screen.getByText(text));
          expect(ratio, `${theme.id} ${theme.kind} ${text}`).toBeGreaterThanOrEqual(4.5);
          return ratio;
        });
      const label = ratios(['Open', 'plan']);
      const secondary = ratios(['notes/plan.md', 'Ctrl O']);
      expect(
        Math.min(...label),
        `${theme.id} ${theme.kind} label against its secondary text`,
      ).toBeGreaterThanOrEqual(Math.max(...secondary));
    });
  }
});
