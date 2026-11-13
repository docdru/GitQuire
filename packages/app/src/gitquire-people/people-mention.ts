import { Extension } from '@tiptap/core';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { type EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
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
import { PeopleSuggestionMenu } from './PeopleSuggestionMenu';

const TRIGGER_RE = /(^|[\s(￼])@([A-Za-z0-9-]{0,39})$/;
const MENTION_RE = /(?<![\w@])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?![\w-])/g;

export const peopleSuggestionKey = new PluginKey('gitquirePeopleSuggestion');
const peopleHighlightKey = new PluginKey<DecorationSet>('gitquirePeopleHighlight');

export function peopleMatcher(config: { $position: ResolvedPos }) {
  const { $position } = config;
  const before = $position.parent.textBetween(0, $position.parentOffset, undefined, '￼');
  const match = TRIGGER_RE.exec(before);
  if (match === null) return null;
  const query = match[2] ?? '';
  const at = $position.start() + (match.index ?? 0) + (match[1] ?? '').length;
  return { range: { from: at, to: $position.pos }, query, text: `@${query}` };
}

function isCode(node: PMNode): boolean {
  return node.marks.some((mark) => mark.type.name === 'code');
}

export function mentionDecorations(
  doc: PMNode,
  known: ReadonlySet<string>,
): DecorationSet {
  if (known.size === 0) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.code === true) return false;
    if (!node.isText || isCode(node)) return true;
    const text = node.text ?? '';
    if (!text.includes('@')) return false;
    for (const match of text.matchAll(MENTION_RE)) {
      if (!known.has((match[1] as string).toLowerCase())) continue;
      const from = pos + (match.index ?? 0);
      decorations.push(
        Decoration.inline(from, from + match[0].length, {
          class: 'gq-mention',
          'data-gq-mention': (match[1] as string).toLowerCase(),
        }),
      );
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
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
    render: () => {
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
    },
  });
}

export const GitQuirePeopleMentions = Extension.create({
  name: 'gitquirePeopleMentions',
  addProseMirrorPlugins() {
    return [suggestionPlugin(this.editor), highlightPlugin()];
  },
});
