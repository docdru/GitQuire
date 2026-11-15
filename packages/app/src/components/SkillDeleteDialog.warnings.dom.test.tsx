import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as linguiShim from '../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => linguiShim);

const deleteSkill = vi.fn();
const closeTabs = vi.fn();
const toastSuccess = vi.fn();
const toastWarning = vi.fn();
const noop = vi.fn();

vi.doMock('@/lib/skills-api', () => ({ deleteSkill }));
vi.doMock('sonner', () => ({
  toast: { error: vi.fn(), success: toastSuccess, warning: toastWarning },
}));
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ closeTabs, openTabs: [] }),
}));

function skill(name: string) {
  return {
    scope: 'project' as const,
    name,
    path: `.agents/skills/${name}/SKILL.md`,
    installed: true,
    hosts: [],
  };
}

const ALPHA_WARNING =
  'Also removed a copy at .ok/skills/alpha that an earlier failed move had kept.';
const _GAMMA_WARNING =
  'Also removed a copy at .ok/skills/gamma that an earlier failed move had kept.';

async function confirmDelete() {
  await userEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
}

describe('SkillDeleteDialog surfaces a successful-deletion warning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function renderDialog() {
    const { SkillDeleteDialog } = await import('./SkillDeleteDialog');
    render(<SkillDeleteDialog skill={skill('alpha')} onOpenChange={noop} onDeleted={noop} />);
  }

  test('the server sentence is shown verbatim instead of a plain success', async () => {
    deleteSkill.mockResolvedValue({ ok: true, existed: true, warnings: [ALPHA_WARNING] });
    await renderDialog();

    await confirmDelete();

    await waitFor(() => expect(toastWarning).toHaveBeenCalled());
    const [, options] = toastWarning.mock.calls[0] as [
      string,
      { description: string; duration: number },
    ];
    expect(options.description).toBe(ALPHA_WARNING);
    expect(options.duration).toBeGreaterThan(4000);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(closeTabs).toHaveBeenCalled();
  });

  test('a delete the server had nothing to say about keeps the plain success', async () => {
    deleteSkill.mockResolvedValue({ ok: true, existed: true, warnings: [] });
    await renderDialog();

    await confirmDelete();

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastWarning).not.toHaveBeenCalled();
  });
});
