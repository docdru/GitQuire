import { COMMAND_IDENTITIES, MENU_LABELS } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { matchesCommandQuery } from '@/components/command-palette-search';

const renderableLabels = (command: (typeof COMMAND_IDENTITIES)[number]): string[] => {
  const keys = [
    command.labelKey,
    command.stateToggle?.showKey,
    command.stateToggle?.hideKey,
    command.stateToggle?.overrideKey,
  ].filter((key) => key !== undefined);
  const resolved = [...new Set(keys)].map((key) => MENU_LABELS[key]).filter((label) => !!label);
  return resolved.length > 0 ? resolved : [''];
};

const paletteRows = COMMAND_IDENTITIES.filter((command) => command.palette).map((command) => ({
  id: command.id,
  labels: renderableLabels(command),
  keywords: command.keywords,
}));

const commandsMatching = (query: string): string[] =>
  paletteRows
    .filter((row) => row.labels.every((label) => matchesCommandQuery(label, query, row.keywords)))
    .map((row) => row.id);

const commandsMatchingSomeState = (query: string): string[] =>
  paletteRows
    .filter((row) => row.labels.some((label) => matchesCommandQuery(label, query, row.keywords)))
    .map((row) => row.id);

const INTENTS: ReadonlyArray<readonly [string, string]> = [
  ['new document', 'new-file'],
  ['create note', 'new-file'],
  ['new note', 'new-file'],
  ['new directory', 'new-folder'],
  ['create directory', 'new-folder'],
  ['create from template', 'new-from-template'],

  ['move chat left', 'move-agents-left'],
  ['move ai to bottom', 'move-agents-bottom'],
  ['move document right', 'move-editor-right'],
  ['open chat', 'toggle-agent-panel'],
  ['open agents', 'toggle-agent-panel'],
  ['show ai', 'toggle-agent-panel'],
  ['document info', 'toggle-doc-panel'],
  ['show properties', 'toggle-doc-panel'],
  ['hide files', 'toggle-sidebar'],
  ['files panel', 'toggle-sidebar'],
  ['show graph', 'open-graph'],
  ['graph view', 'open-graph'],

  ['expand folders', 'expand-all-tree'],
  ['collapse folders', 'collapse-all-tree'],
  ['show dotfiles', 'toggle-show-hidden-files'],
  ['hidden files', 'toggle-show-hidden-files'],
  ['only markdown', 'toggle-show-only-markdown-files'],
  ['show ok folders', 'toggle-show-ok-folders'],
  ['show sidebar', 'toggle-sidebar'],
  ['hide document panel', 'toggle-doc-panel'],
  ['hide agents', 'toggle-agent-panel'],

  ['open settings', 'settings'],
  ['open preferences', 'settings'],
  ['view source', 'open-github'],
  ['give feedback', 'send-feedback'],
  ['send suggestion', 'send-feedback'],
  ['starter pack', 'initialize-starter-pack'],
  ['play game', 'open-blob-run'],
];

describe('command palette vocabulary', () => {
  test.each(INTENTS)('"%s" reaches %s', (query, expectedId) => {
    expect(commandsMatching(query)).toContain(expectedId);
  });

  test('no intent is answered in only some of a command’s render states', () => {
    const stateDependent = INTENTS.filter(
      ([query, id]) =>
        commandsMatchingSomeState(query).includes(id) && !commandsMatching(query).includes(id),
    ).map(([query, id]) => `${query} -> ${id}`);

    expect(stateDependent).toEqual([]);
  });

  test('every intent resolves to a usefully short list', () => {
    const tooBroad = INTENTS.map(([query]) => [query, commandsMatching(query).length] as const)
      .filter(([, count]) => count > 2)
      .map(([query, count]) => `${query} -> ${count} rows`);

    expect(tooBroad).toEqual([]);
  });

  test('a broad single word stays inside a committed ceiling', () => {
    const ceilings: ReadonlyArray<readonly [string, number]> = [
      ['open', 13],
      ['file', 11],
      ['show', 12],
      ['new', 9],
      ['create', 7],
      ['folder', 10],
      ['view', 3],
      ['go', 3],
    ];
    const over = ceilings
      .map(([word, max]) => [word, commandsMatchingSomeState(word).length, max] as const)
      .filter(([, count, max]) => count > max)
      .map(([word, count, max]) => `${word} -> ${count} rows (ceiling ${max})`);

    expect(over).toEqual([]);
  });

  test('a query whose terms match nothing returns nothing', () => {
    expect(commandsMatching('zzzznomatch')).toEqual([]);
    expect(commandsMatching('bug zzzznomatch')).toEqual([]);
  });
});
