import { describe, expect, test } from 'vitest';
import type { SidebarGroup } from '@/components/settings/settings-sidebar-types';
import { withoutHiddenSettings } from './settings-visibility';

const groups: SidebarGroup[] = [
  {
    id: 'user',
    label: 'User',
    enabled: true,
    items: [
      { id: 'preferences', label: 'Preferences' },
      { id: 'account', label: 'Git' },
      { id: 'user-plugins-manage', label: 'Plugins' },
      { id: 'user-skills', label: 'Skills Studio' },
    ],
  },
  {
    id: 'project',
    label: 'This project',
    enabled: true,
    items: [
      {
        id: 'sync',
        label: 'Sync & sharing',
        subsections: [{ id: 'sharing', label: 'Config sharing', anchor: 'section:sharing' }],
      },
      { id: 'skills', label: 'Skills Studio' },
    ],
  },
];

describe('withoutHiddenSettings', () => {
  test('hides server-wide user items, config sharing and the personal Git token page', () => {
    const shown = withoutHiddenSettings(groups, false);
    expect(shown[0]?.items.map((item) => item.id)).toEqual(['preferences']);
    expect(shown[1]?.items.map((item) => item.id)).toEqual(['sync', 'skills']);
    expect(shown[1]?.items[0]?.subsections).toEqual([]);
  });

  test('keeps the Git token page when personal credentials are turned on', () => {
    const shown = withoutHiddenSettings(groups, true);
    expect(shown[0]?.items.map((item) => item.id)).toEqual(['preferences', 'account']);
  });
});
