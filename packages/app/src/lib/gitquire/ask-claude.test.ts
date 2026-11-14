import { describe, expect, it } from 'vitest';
import {
  askDestinations,
  buildClaudePrompt,
  claudeLink,
  defaultAskDestination,
  defaultDestination,
  isClaudeDestination,
  MAX_REQUEST_CHARS,
} from './ask-claude';
import { STANDALONE_FEATURES } from './features';

describe('Ask Claude', () => {
  it('names the wiki and the page in the prompt', () => {
    const prompt = buildClaudePrompt({
      wikiUrl: 'https://wiki.example.com',
      target: { kind: 'page', path: 'meetings/2026-11-11.md' },
      request: '  Turn the action items into a checklist  ',
    });
    expect(prompt).toBe(
      [
        'Use the GitQuire wiki tools (the MCP server for https://wiki.example.com) for this.',
        '',
        'Page: meetings/2026-11-11.md',
        '',
        'Turn the action items into a checklist',
      ].join('\n'),
    );
  });

  it('describes a folder, or the whole wiki at the root', () => {
    const base = { wikiUrl: 'https://w', request: 'x' };
    expect(buildClaudePrompt({ ...base, target: { kind: 'folder', path: 'specs' } })).toContain(
      'Folder: specs',
    );
    expect(buildClaudePrompt({ ...base, target: { kind: 'folder', path: '' } })).toContain(
      'Folder: (the whole wiki)',
    );
  });

  it('caps the request length', () => {
    const prompt = buildClaudePrompt({
      wikiUrl: 'https://w',
      target: { kind: 'page', path: 'a.md' },
      request: 'y'.repeat(MAX_REQUEST_CHARS + 500),
    });
    expect(prompt.endsWith('y'.repeat(MAX_REQUEST_CHARS))).toBe(true);
    expect(prompt).not.toContain('y'.repeat(MAX_REQUEST_CHARS + 1));
  });

  it('builds the documented Claude links', () => {
    expect(claudeLink('claude-web', 'a b&c')).toBe('https://claude.ai/new?q=a%20b%26c');
    expect(claudeLink('claude-app', 'hi')).toBe('claude://claude.ai/new?q=hi');
    expect(claudeLink('claude-code', 'hi')).toBe('claude://code/new?q=hi');
  });

  it('picks a destination from what the person has connected', () => {
    expect(defaultDestination({ agentToken: false, connector: true }, null)).toBe('claude-web');
    expect(defaultDestination({ agentToken: true, connector: false }, null)).toBe('claude-code');
    expect(defaultDestination({ agentToken: true, connector: true }, 'claude-app')).toBe(
      'claude-app',
    );
    expect(defaultDestination({ agentToken: true, connector: false }, 'nonsense')).toBe(
      'claude-code',
    );
    expect(isClaudeDestination('claude-web')).toBe(true);
    expect(isClaudeDestination('chatgpt')).toBe(false);
  });

  it('offers the in-app chat when it takes the place of in-app agents', () => {
    const base = { ...STANDALONE_FEATURES, askAi: false };
    const chatOnly = { ...base, aiChat: true };
    const both = { ...base, aiChat: true, connector: true };
    expect(askDestinations(chatOnly)).toEqual(['gitquire-chat']);
    expect(askDestinations(both)).toEqual([
      'gitquire-chat',
      'claude-web',
      'claude-app',
      'claude-code',
    ]);
    expect(askDestinations({ ...base, connector: true })).toEqual([
      'claude-web',
      'claude-app',
      'claude-code',
    ]);
    expect(defaultAskDestination(both, null)).toBe('gitquire-chat');
    expect(defaultAskDestination(both, 'claude-app')).toBe('claude-app');
    expect(defaultAskDestination(chatOnly, 'claude-app')).toBe('gitquire-chat');
    expect(defaultAskDestination({ ...base, connector: true }, 'gitquire-chat')).toBe('claude-web');
  });
});
