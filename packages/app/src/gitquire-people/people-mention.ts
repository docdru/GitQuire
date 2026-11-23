import { Extension } from '@tiptap/core';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { type EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { suggestionAllow } from '@/editor/extensions/suggestion-allow';
import {
  createSuggestionPopup,
  destroySuggestionPopup,
  type SuggestionPositionState,
} from '@/editor/extensions/suggestion-floating-ui';
import {
  getPeopleSnapshot,
  knownLogins,
  loadPeople,
  matchPeople,
  type Person,
  subscribePeople,
} from '@/lib/gitquire/people';
import { settledSuggestionRender } from '../editor/extensions/suggestion-settled';
import { PeopleSuggestionMenu } from './PeopleSuggestionMenu';
import { type MentionPlace, mentionRanges } from './page-mention-find';

const TRIGGER_RE = /(^|[\s(￼])@([A-Za-z0-9-]{0,39})$/;

const peopleSuggestionKey = new PluginKey('gitquirePeopleSuggestion');
const peopleHighlightKey = new PluginKey<DecorationSet>('gitquirePeopleHighlight');

function peopleMatcher(config: { $position: ResolvedPos }) {
  const { $position } = config;
  const before = $position.parent.textBetween(0, $position.parentOffset, undefined, '￼');
  const match = TRIGGER_RE.exec(before);
  if (match === null) return null;
  const query = match[2] ?? '';
  const at = $position.start() + (match.index ?? 0) + (match[1] ?? '').length;
  return { range: { from: at, to: $position.pos }, query, text: `@${query}` };
}

const PLACE_CLASS: Record<MentionPlace, string> = {
  page: 'gq-mention',
  'action-item': 'gq-mention gq-mention-notifies',
  'done-action-item': 'gq-mention gq-mention-task-done',
};

export function mentionDecorations(doc: PMNode, known: ReadonlySet<string>): DecorationSet {
  if (known.size === 0) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  for (const range of mentionRanges(doc)) {
    if (!known.has(range.login)) continue;
    decorations.push(
      Decoration.inline(range.from, range.to, {
        class: PLACE_CLASS[range.place],
        'data-gq-mention': range.login,
        'data-gq-mention-place': range.place,
      }),
    );
  }
  return DecorationSet.create(doc, decorations);
}

const flashKey = new PluginKey<DecorationSet>('gitquireMentionFlash');
const FLASH_MS = 2000;

export function flashRange(view: EditorView, from: number, to: number): void {
  view.dispatch(view.state.tr.setMeta(flashKey, { from, to }));
  window.setTimeout(() => {
    if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(flashKey, null));
  }, FLASH_MS);
}

function flashPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: flashKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, previous) => {
        const meta = tr.getMeta(flashKey) as { from: number; to: number } | null | undefined;
        if (meta === null) return DecorationSet.empty;
        if (meta === undefined) return previous.map(tr.mapping, tr.doc);
        if (meta.to > tr.doc.content.size) return DecorationSet.empty;
        return DecorationSet.create(tr.doc, [
          Decoration.inline(meta.from, meta.to, { class: 'gq-mention-flash' }),
        ]);
      },
    },
    props: {
      decorations: (state) => flashKey.getState(state),
    },
  });
}

function currentKnown(): ReadonlySet<string> {
  return knownLogins(getPeopleSnapshot().people);
}

function highlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: peopleHighlightKey,
    state: {
      init: (_config, state: EditorState) => mentionDecorations(state.doc, currentKnown()),
      apply: (tr, previous, _old, next) =>
        tr.docChanged || tr.getMeta(peopleHighlightKey) === 'refresh'
          ? mentionDecorations(next.doc, currentKnown())
          : previous,
    },
    props: {
      decorations: (state) => peopleHighlightKey.getState(state),
    },
    view: (view) => {
      const unsubscribe = subscribePeople(() => {
        if (view.isDestroyed) return;
        view.dispatch(view.state.tr.setMeta(peopleHighlightKey, 'refresh'));
      });
      return { destroy: unsubscribe };
    },
  });
}

function suggestionPlugin(editor: Parameters<typeof Suggestion>[0]['editor']) {
  return Suggestion<Person>({
    editor,
    pluginKey: peopleSuggestionKey,
    char: '@',
    allowedPrefixes: null,
    findSuggestionMatch: peopleMatcher,
    allow: suggestionAllow,
    items: async ({ query }) => {
      await loadPeople();
      return matchPeople(getPeopleSnapshot().people, query);
    },
    command: ({ editor: target, range, props: person }) => {
      target.chain().focus().deleteRange(range).insertContent(`@${person.login} `).run();
    },
    render: settledSuggestionRender(() => {
      let renderer: ReactRenderer<typeof PeopleSuggestionMenu> | null = null;
      let current: SuggestionProps<Person> | null = null;
      let selected = 0;
      const position: SuggestionPositionState = { popup: null, stopAutoUpdate: null };
      let place: (() => void) | null = null;

      const menuProps = () => ({
        people: current?.items ?? [],
        selectedIndex: selected,
        onSelect: (person: Person) => current?.command(person),
        onHover: (index: number) => {
          selected = index;
          update();
        },
      });

      function update() {
        if (renderer === null || current === null) return;
        renderer.updateProps(menuProps());
        if (position.popup !== null) {
          position.popup.style.display = current.items.length === 0 ? 'none' : '';
        }
      }

      return {
        onBeforeStart(props: SuggestionProps<Person>) {
          current = props;
          selected = 0;
          const popup = createSuggestionPopup(() => current, 'people-suggestion', {
            clipToEditorPane: true,
          });
          position.popup = popup.popup;
          place = popup.doPosition;
          renderer = new ReactRenderer(PeopleSuggestionMenu, {
            props: menuProps(),
            editor: props.editor,
          });
          popup.popup.appendChild(renderer.element);
          position.stopAutoUpdate = popup.startAutoUpdate();
          popup.reveal();
          update();
        },
        onStart(props: SuggestionProps<Person>) {
          current = props;
          selected = 0;
          update();
        },
        onUpdate(props: SuggestionProps<Person>) {
          current = props;
          selected = Math.min(selected, Math.max(0, props.items.length - 1));
          update();
          place?.();
        },
        onKeyDown({ event }: SuggestionKeyDownProps) {
          const items = current?.items ?? [];
          if (items.length === 0) return false;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const step = event.key === 'ArrowDown' ? 1 : -1;
            selected = (selected + step + items.length) % items.length;
            update();
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const person = items[selected];
            if (person === undefined) return false;
            current?.command(person);
            return true;
          }
          return false;
        },
        onExit() {
          destroySuggestionPopup(position);
          renderer?.destroy();
          renderer = null;
          current = null;
          place = null;
          selected = 0;
        },
      };
    }),
  });
}

export const GitQuirePeopleMentions = Extension.create({
  name: 'gitquirePeopleMentions',
  addProseMirrorPlugins() {
    return [suggestionPlugin(this.editor), highlightPlugin(), flashPlugin()];
  },
});
