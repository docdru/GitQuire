import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type {
  GqPackId,
  GqScaffoldPlan,
  GqSeedPackInfo,
  GqSeedPlanResult,
} from '@/lib/desktop-bridge-types';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('@lingui/core/macro', () => ({
  ...actualLinguiMacro,
  t: renderLinguiTemplate,
  msg: renderLinguiTemplate,
  plural: (value: number, options: { one: string; other: string }) =>
    (value === 1 ? options.one : options.other).replace('#', String(value)),
}));

vi.doMock('@/components/PackCardGrid', () => ({
  PackCardGrid: ({
    packs,
    onPackSelect,
  }: {
    packs: GqSeedPackInfo[] | null;
    onPackSelect: (packId: GqPackId) => void;
  }) => (
    <div data-testid="pack-card-grid">
      {packs === null ? (
        <span>Loading packs</span>
      ) : (
        packs.map((pack) => (
          <button key={pack.id} type="button" onClick={() => onPackSelect(pack.id)}>
            {pack.name}
          </button>
        ))
      )}
    </div>
  ),
}));

const toastSuccesses: string[] = [];
const toastErrors: string[] = [];
const toastWarnings: string[] = [];
const listPacksCalls: string[] = [];
const planCalls: Array<{ packId?: GqPackId; rootDir?: string }> = [];
const applyCalls: Array<{ plan: GqScaffoldPlan; packId?: GqPackId }> = [];

const knowledgeBasePlan: GqScaffoldPlan = {
  created: [
    { kind: 'folder', path: 'notes' },
    { kind: 'folder', path: 'notes/.gitquire' },
    { kind: 'folder', path: 'notes/.gitquire/templates' },
    { kind: 'file', path: 'notes/.gitquire/templates/note.md' },
    { kind: 'file', path: 'log.md' },
  ],
  skipped: [],
  warnings: [],
};

const plainNotesPlan: GqScaffoldPlan = {
  created: [
    { kind: 'folder', path: 'daily' },
    { kind: 'folder', path: 'daily/.gitquire' },
    { kind: 'folder', path: 'daily/.gitquire/templates' },
    { kind: 'file', path: 'daily/.gitquire/templates/daily.md' },
  ],
  skipped: [],
  warnings: [],
};

const packs: GqSeedPackInfo[] = [
  {
    id: 'knowledge-base',
    name: 'Knowledge Base',
    description: 'Structured notes with templates.',
    folders: [{ path: 'notes', summary: 'Notes folder' }],
    entryCounts: { files: 1, folders: 1 },
  },
  {
    id: 'plain-notes',
    name: 'Plain Notes',
    description: 'A minimal notes setup.',
    folders: [{ path: 'daily', summary: 'Daily journal' }],
    entryCounts: { files: 0, folders: 1 },
  },
];

let planImpl: (options: { packId?: GqPackId; rootDir?: string }) => Promise<GqSeedPlanResult> =
  async (options) => ({
    ok: true,
    plan: options.packId === 'plain-notes' ? plainNotesPlan : knowledgeBasePlan,
  });

vi.doMock('@/lib/seed-client', () => ({
  seedClient: () => ({
    listPacks: async () => {
      listPacksCalls.push('list');
      return { ok: true as const, packs };
    },
    plan: async (options: { packId?: GqPackId; rootDir?: string }) => {
      planCalls.push(options);
      return planImpl(options);
    },
    apply: async (plan: GqScaffoldPlan, options: { packId?: GqPackId }) => {
      applyCalls.push({ plan, packId: options.packId });
      return {
        ok: true as const,
        result: {
          applied: plan.created.length,
          errors: [],
          durationMs: 1,
        },
      };
    },
  }),
}));

vi.doMock('sonner', () => ({
  toast: {
    success: (message: string) => toastSuccesses.push(message),
    error: (message: string) => toastErrors.push(message),
    warning: (message: string) => toastWarnings.push(message),
  },
}));

async function renderSeedDialog(
  props: Partial<React.ComponentProps<typeof import('./SeedDialog').SeedDialog>> = {},
) {
  const { SeedDialog } = await import('./SeedDialog');
  const onOpenChange = props.onOpenChange ?? (() => {});
  render(
    <TooltipProvider>
      <SeedDialog open onOpenChange={onOpenChange} {...props} />
    </TooltipProvider>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('SeedDialog runtime behavior', () => {
  afterEach(() => {
    cleanup();
    listPacksCalls.length = 0;
    planCalls.length = 0;
    applyCalls.length = 0;
    toastSuccesses.length = 0;
    toastErrors.length = 0;
    toastWarnings.length = 0;
    planImpl = async (options) => ({
      ok: true,
      plan: options.packId === 'plain-notes' ? plainNotesPlan : knowledgeBasePlan,
    });
  });

  test('exports SeedDialog component', async () => {
    const mod = await import('./SeedDialog');
    expect(typeof mod.SeedDialog).toBe('function');
  });

  test('starts on the shared pack grid when no initial pack is provided', async () => {
    await renderSeedDialog();

    expect(await screen.findByTestId('pack-card-grid')).toBeTruthy();
    expect(screen.getByText('Knowledge Base')).toBeTruthy();
    expect(screen.getByText('Plain Notes')).toBeTruthy();
    expect(screen.queryByText('Where should it live?')).toBeNull();
    expect(planCalls).toHaveLength(0);
    expect(listPacksCalls).toEqual(['list']);
  });

  test('initialPackId skips the picker, plans the selected pack, and locks Back', async () => {
    await renderSeedDialog({ initialPackId: 'plain-notes' });

    expect(await screen.findByText('Initialize Plain Notes')).toBeTruthy();
    await waitFor(() => {
      expect(planCalls).toContainEqual({ packId: 'plain-notes', rootDir: undefined });
    });

    expect(screen.queryByTestId('pack-card-grid')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(await screen.findByText('daily/')).toBeTruthy();
  });

  test('Back returns to the picker and clears the previous pack plan before the next plan resolves', async () => {
    let resolveKnowledgeBasePlan: ((result: GqSeedPlanResult) => void) | null = null;
    planImpl = (options) => {
      if (options.packId === 'knowledge-base') {
        const { promise, resolve } = Promise.withResolvers<GqSeedPlanResult>();
        resolveKnowledgeBasePlan = resolve;
        return promise;
      }
      return Promise.resolve({ ok: true, plan: plainNotesPlan });
    };

    await renderSeedDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Plain Notes' }));
    expect(await screen.findByText('Initialize Plain Notes')).toBeTruthy();
    expect(await screen.findByText('daily/')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByTestId('pack-card-grid')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Knowledge Base' }));
    expect(await screen.findByText('Initialize Knowledge Base')).toBeTruthy();
    expect(screen.queryByText('daily/')).toBeNull();
    expect(screen.getByRole('status', { name: 'Loading preview' })).toBeTruthy();

    await act(async () => {
      resolveKnowledgeBasePlan?.({ ok: true, plan: knowledgeBasePlan });
    });
    expect(await screen.findByText('notes/')).toBeTruthy();
    expect(screen.getByText('log.md')).toBeTruthy();
  });

  test('Initialize applies the selected pack through seedClient and closes on success', async () => {
    const onOpenChangeCalls: boolean[] = [];
    const applied: string[] = [];
    await renderSeedDialog({
      initialPackId: 'plain-notes',
      onOpenChange: (open) => onOpenChangeCalls.push(open),
      onSeedApplied: () => applied.push('yes'),
    });

    await screen.findByText('daily/');
    await userEvent.click(screen.getByRole('button', { name: 'Initialize' }));

    await waitFor(() => {
      expect(applyCalls).toHaveLength(1);
    });
    expect(applyCalls[0]).toEqual({ plan: plainNotesPlan, packId: 'plain-notes' });
    expect(applied).toEqual(['yes']);
    expect(onOpenChangeCalls).toEqual([false]);
    expect(toastSuccesses[0]).toContain('Plain Notes initialized');
    expect(toastErrors).toEqual([]);
  });
});
