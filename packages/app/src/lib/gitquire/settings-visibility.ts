import type { SidebarGroup } from '@/components/settings/settings-sidebar-types';
import { PERSONAL_GIT_CREDENTIALS_ENABLED } from './personal-git-credentials';

const ALWAYS_HIDDEN_ITEMS = new Set(['user-skills', 'user-plugins-manage', 'search']);
const ALWAYS_HIDDEN_SUBSECTIONS = new Set(['sharing']);

export function hiddenSettingsItems(personalGitCredentials: boolean): ReadonlySet<string> {
  return personalGitCredentials
    ? ALWAYS_HIDDEN_ITEMS
    : new Set([...ALWAYS_HIDDEN_ITEMS, 'account']);
}

export function withoutHiddenSettings(
  groups: readonly SidebarGroup[],
  personalGitCredentials: boolean = PERSONAL_GIT_CREDENTIALS_ENABLED,
): SidebarGroup[] {
  const hiddenItems = hiddenSettingsItems(personalGitCredentials);
  return groups.map((group) => ({
    ...group,
    items: group.items
      .filter((item) => !hiddenItems.has(item.id))
      .map((item) =>
        item.subsections === undefined
          ? item
          : {
              ...item,
              subsections: item.subsections.filter(
                (subsection) => !ALWAYS_HIDDEN_SUBSECTIONS.has(subsection.id),
              ),
            },
      ),
  }));
}

const WIKI_ADMIN_ITEMS = new Set([
  'project-preferences',
  'sync',
  'link-previews',
  'plugins-manage',
  'project-templates',
  'skills',
  'okignore',
]);
const PERSONAL_PLUGIN_ITEMS = new Set(['plugin:theme', 'plugin:slides']);

export function isWikiAdminSetting(itemId: string): boolean {
  if (WIKI_ADMIN_ITEMS.has(itemId)) return true;
  return itemId.startsWith('plugin:') && !PERSONAL_PLUGIN_ITEMS.has(itemId);
}

const HIDDEN_LINT_PLUGINS = new Set(['okf']);

export function isLintPluginOffered(plugin: { id: string }): boolean {
  return !HIDDEN_LINT_PLUGINS.has(plugin.id);
}
