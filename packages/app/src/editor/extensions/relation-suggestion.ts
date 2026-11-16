import type { Editor } from '@tiptap/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { fetchTypedLinks, type RelationName } from '@/lib/gitquire/typed-links';
import { RelationSuggestionMenu } from '../relation-suggestion/RelationSuggestionMenu';
import { suggestionAllow } from './suggestion-allow';
import {
  createSuggestionPopup,
  destroySuggestionPopup,
  type SuggestionPositionState,
} from './suggestion-floating-ui';
import { settledSuggestionRender } from './suggestion-settled';

export const relationSuggestionKey = new PluginKey('relationSuggestion');

const MAX_ITEMS = 8;

const RELATION_TRIGGER_RE = /(^|[[(])((?:[^[\]()`:\s￼][^[\]()`:￼]{0,59})?)::$/u;

export function relationMatcher(config: {
  $position: ResolvedPos;
}): { range: { from: number; to: number }; query: string; text: string } | null {
  const { $position } = config;
  const textBefore = $position.parent.textBetween(0, $position.parentOffset, undefined, '￼');
  const match = textBefore.match(RELATION_TRIGGER_RE);
  if (!match) return null;
  const query = match[2] ?? '';
  const start = $position.start() + (match.index ?? 0) + match[1].length;
  return {
    range: { from: start, to: $position.pos },
    query,
    text: `${query}::`,
  };
}

export function rankRelations(relations: readonly RelationName[], query: string): RelationName[] {
  const lower = query.trim().toLowerCase();
  const filtered =
    lower === ''
      ? relations.slice()
      : relations.filter((relation) => relation.name.toLowerCase().includes(lower));
  filtered.sort((a, b) => {
    const aStarts = a.name.toLowerCase().startsWith(lower) ? 0 : 1;
    const bStarts = b.name.toLowerCase().startsWith(lower) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
  return filtered.slice(0, MAX_ITEMS);
}

export function relationInsertion(name: string): string {
  return `${name}:: [[`;
}

export function configureRelationSuggestion(
  editor: Editor,
  load: () => Promise<readonly RelationName[]> = async () => (await fetchTypedLinks()).relations,
) {
  let relations: readonly RelationName[] = [];
  let loaded = false;
  let loading: Promise<readonly RelationName[]> | null = null;

  return Suggestion<RelationName>({
    editor,
    pluginKey: relationSuggestionKey,
    char: '::',
    allowedPrefixes: null,
    findSuggestionMatch: relationMatcher,
    allow: suggestionAllow,

    items: async ({ query }) => {
      if (!loaded) {
        loading ||= load();
        try {
          relations = await loading;
        } catch (err) {
          console.error('[relation-suggestion] Failed to fetch relation names:', err);
          relations = [];
        } finally {
          loaded = true;
          loading = null;
        }
      }
      return rankRelations(relations, query);
    },

    command: ({ editor, range, props: item }) => {
      editor.chain().focus().insertContentAt(range, relationInsertion(item.name)).run();
    },

    render: settledSuggestionRender(() => {
      let renderer: ReactRenderer<typeof RelationSuggestionMenu> | null = null;
      let currentProps: SuggestionProps<RelationName> | null = null;
      let selectedIndex = 0;
      const posState: SuggestionPositionState = { popup: null, stopAutoUpdate: null };
      let doPosition: (() => void) | null = null;
      let reveal: (() => void) | null = null;

      const onSelect = (item: RelationName) => {
        currentProps?.command(item);
      };

      const onHover = (index: number) => {
        if (selectedIndex === index) return;
        selectedIndex = index;
        rerender();
      };

      const menuProps = (props: SuggestionProps<RelationName>) => ({
        items: props.items,
        query: props.query ?? '',
        selectedIndex,
        onSelect,
        onHover,
        loading: !loaded,
        known: relations.length,
      });

      const rerender = () => {
        if (!renderer || !currentProps) return;
        renderer.updateProps(menuProps(currentProps));
      };

      return {
        onBeforeStart(props: SuggestionProps<RelationName>) {
          currentProps = props;
          selectedIndex = 0;
          const result = createSuggestionPopup(() => currentProps, 'relation-suggestion', {
            clipToEditorPane: true,
          });
          posState.popup = result.popup;
          doPosition = result.doPosition;
          reveal = result.reveal;
          renderer = new ReactRenderer(RelationSuggestionMenu, {
            props: { ...menuProps(props), loading: true },
            editor: props.editor,
          });
          result.popup.appendChild(renderer.element);
          posState.stopAutoUpdate = result.startAutoUpdate();
        },

        onStart(props: SuggestionProps<RelationName>) {
          currentProps = props;
          selectedIndex = 0;
          rerender();
          reveal?.();
        },

        onUpdate(props: SuggestionProps<RelationName>) {
          currentProps = props;
          selectedIndex = Math.min(selectedIndex, Math.max(0, props.items.length - 1));
          rerender();
          doPosition?.();
        },

        onKeyDown({ event }: SuggestionKeyDownProps) {
          if (!currentProps) return false;
          const items = currentProps.items;
          if (items.length === 0) return false;
          if (event.key === 'ArrowDown') {
            selectedIndex = (selectedIndex + 1) % items.length;
            rerender();
            return true;
          }
          if (event.key === 'ArrowUp') {
            selectedIndex = (selectedIndex - 1 + items.length) % items.length;
            rerender();
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const item = items[selectedIndex];
            if (!item) return false;
            currentProps.command(item);
            return true;
          }
          return false;
        },

        onExit() {
          destroySuggestionPopup(posState);
          doPosition = null;
          reveal = null;
          renderer?.destroy();
          renderer = null;
          currentProps = null;
          selectedIndex = 0;
          relations = [];
          loaded = false;
          loading = null;
        },
      };
    }),
  });
}
