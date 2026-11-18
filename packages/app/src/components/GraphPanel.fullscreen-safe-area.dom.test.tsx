import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

vi.doMock('@lingui/core/macro', () => ({
  ...actualLinguiMacro,
  t: renderLinguiTemplate,
  msg: renderLinguiTemplate,
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Plural: ({ one }: { one: string }) => <>{one}</>,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => ({
    assetPaths: new Set<string>(),
    error: null,
    folderPaths: new Set<string>(),
    loading: false,
    pages: new Set<string>(['docs/Active']),
    pagesBySlug: new Map<string, string>(),
    pageMeta: new Map(),
    pageTitles: new Map([['docs/Active', 'Active']]),
    refetch: () => {},
    addPage: () => {},
  }),
}));

vi.doMock('@/components/GraphView', () => ({
  GraphView: ({ isExpanded }: { isExpanded: boolean }) => (
    <div data-testid="graph-view" data-expanded={String(isExpanded)} />
  ),
}));

describe('GraphPanel fullscreen safe-area behavior', () => {
  afterEach(() => {
    cleanup();
  });

  async function renderExpandedGraphPanel() {
    const { GraphPanel } = await import('./GraphPanel');
    render(
      <TooltipProvider>
        <GraphPanel activeDocName="docs/Active" />
      </TooltipProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Expand graph' }));
  }

  test('expanded overlay pads its header row', async () => {
    await renderExpandedGraphPanel();

    const graphView = screen.getByTestId('graph-view');
    const panel = graphView.closest('[data-slot="panel"]');
    expectVisualClassTokens(panel?.className, [
      'fixed',
      'inset-0',
      'z-50',
      'overflow-hidden',
      'bg-background',
    ]);

    const header = panel?.querySelector('[data-slot="panel-header"]');
    expectVisualClassTokens(header?.className, ['mt-2', 'h-12', 'py-0']);

    expectVisualClassTokens(header?.className, ['pl-4']);

    const titleCluster = header?.querySelector('[data-slot="graph-title-cluster"]');
    expectVisualClassTokens(titleCluster?.className, ['ml-4']);
  });

  test('docked (non-expanded) graph does not use the expanded header spacing', async () => {
    const { GraphPanel } = await import('./GraphPanel');
    render(
      <TooltipProvider>
        <GraphPanel activeDocName="docs/Active" />
      </TooltipProvider>,
    );

    const panel = screen.getByTestId('graph-view').closest('[data-slot="panel"]');
    const header = panel?.querySelector('[data-slot="panel-header"]');
    expectVisualClassTokensAbsent(header?.className, ['pl-4', 'mt-2', 'h-12']);
    const titleCluster = header?.querySelector('[data-slot="graph-title-cluster"]');
    expectVisualClassTokensAbsent(titleCluster?.className, ['ml-4']);
  });
});
