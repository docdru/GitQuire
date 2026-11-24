import { describe, expect, it } from 'vitest';
import {
  askClaudeAddress,
  askDestinations,
  askWorkspace,
  askWorkspaceChoice,
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

  it('behind the front door, points at the address of the wiki’s host and names the wiki', () => {
    const address = askClaudeAddress('https://wiki.example.com', '/w/github/team/handbook');
    expect(address).toEqual({
      wikiUrl: 'https://wiki.example.com/mcp/github',
      wiki: 'github/team/handbook',
    });
    const prompt = buildClaudePrompt({
      ...address,
      target: { kind: 'page', path: 'index.md' },
      request: 'Summarise',
    });
    expect(prompt.split('\n')[0]).toBe(
      'Use the GitQuire wiki tools (the MCP server for https://wiki.example.com/mcp/github) for this, in the wiki github/team/handbook: give "github/team/handbook" as the wiki argument of every call.',
    );
    expect(askClaudeAddress('https://wiki.example.com', '')).toEqual({
      wikiUrl: 'https://wiki.example.com',
    });
  });

  it('says which draft and branch the request was written in', () => {
    const prompt = buildClaudePrompt({
      wikiUrl: 'https://wiki.example.com',
      workspace: { kind: 'draft', title: 'Pricing page', branch: 'draft/pricing-page' },
      target: { kind: 'page', path: 'pricing.md' },
      request: 'Shorten the intro',
    });
    expect(prompt).toBe(
      [
        'Use the GitQuire wiki tools (the MCP server for https://wiki.example.com) for this.',
        '',
        'Workspace: the draft "Pricing page" (branch draft/pricing-page), not the live wiki. Check with the workspace tool before changing anything; if it reports a different place, stop and tell me.',
        'Page: pricing.md',
        '',
        'Shorten the intro',
      ].join('\n'),
    );
  });

  it('says so when the request was written in the live wiki', () => {
    const prompt = buildClaudePrompt({
      wikiUrl: 'https://w',
      workspace: { kind: 'live' },
      target: { kind: 'page', path: 'a.md' },
      request: 'x',
    });
    expect(prompt).toContain('Workspace: the live wiki\nPage: a.md');
  });

  it('takes the workspace from the draft the person has open', () => {
    const viewing = { title: 'Pricing page', branch: 'draft/pricing-page' };
    expect(askWorkspace({ list: { enabled: true }, current: { viewing } })).toEqual({
      kind: 'draft',
      title: 'Pricing page',
      branch: 'draft/pricing-page',
    });
    expect(askWorkspace({ list: { enabled: true }, current: { viewing: null } })).toEqual({
      kind: 'live',
    });
    expect(askWorkspace({ list: { enabled: false }, current: null })).toBeUndefined();
    expect(askWorkspace({ list: null, current: null })).toBeUndefined();
  });

  it('names the workspace argument behind the front door, from the choice made', () => {
    const viewing = { slug: 'pricing-page', title: 'Pricing page', branch: 'draft/pricing-page' };
    const on = { enabled: true };
    expect(askWorkspaceChoice({ list: on, current: { viewing } }, 'live')).toEqual({
      kind: 'live',
      argument: 'live',
    });
    expect(askWorkspaceChoice({ list: on, current: { viewing } }, 'draft')).toEqual({
      kind: 'draft',
      title: 'Pricing page',
      branch: 'draft/pricing-page',
      argument: 'draft:pricing-page',
    });
    expect(askWorkspaceChoice({ list: on, current: { viewing: null } }, 'draft')).toEqual({
      kind: 'own-draft',
      argument: 'draft',
    });
    expect(
      askWorkspaceChoice({ list: { enabled: false }, current: null }, 'draft'),
    ).toBeUndefined();

    const base = {
      wikiUrl: 'https://w',
      wiki: 'team/a',
      target: { kind: 'page' as const, path: 'a.md' },
      request: 'x',
    };
    expect(buildClaudePrompt({ ...base, workspace: { kind: 'live', argument: 'live' } })).toContain(
      'Workspace: the live wiki. Give "live" as the workspace argument of every call.\nPage: a.md',
    );
    expect(
      buildClaudePrompt({ ...base, workspace: { kind: 'own-draft', argument: 'draft' } }),
    ).toContain(
      'Workspace: a draft of your own for me to review, not the live wiki. Give "draft" as the workspace argument of every call. Check with the workspace tool',
    );
    expect(
      buildClaudePrompt({
        ...base,
        workspace: {
          kind: 'draft',
          title: 'Pricing page',
          branch: 'draft/pricing-page',
          argument: 'draft:pricing-page',
        },
      }),
    ).toContain(
      'not the live wiki. Give "draft:pricing-page" as the workspace argument of every call.',
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

  it('offers the in-app chat when the server has it', () => {
    const base = STANDALONE_FEATURES;
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
