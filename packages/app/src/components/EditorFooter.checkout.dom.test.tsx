import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { DocumentStats } from '@/lib/document-stats';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{value === 1 ? one : other}</>
  ),
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

let branch: string | null = null;

vi.doMock('@/hooks/use-current-branch', () => ({ useCurrentBranch: () => branch }));

const STATS: DocumentStats = { words: 10, chars: 50, tokens: 12 };

async function renderFooter() {
  const { EditorFooter } = await import('./EditorFooter');
  return render(
    <TooltipProvider delayDuration={0}>
      <EditorFooter stats={STATS} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  branch = null;
  Object.defineProperty(window, 'okDesktop', { configurable: true, value: undefined });
});

describe('EditorFooter checkout detail', () => {
  test('on the web, with no desktop project, the footer shows the branch alone and no path target', async () => {
    branch = 'main';
    await renderFooter();

    expect(screen.getByTestId('editor-footer-branch').textContent).toBe('main');
    expect(screen.queryByTestId('editor-footer-checkout')).toBeNull();
  });
});
