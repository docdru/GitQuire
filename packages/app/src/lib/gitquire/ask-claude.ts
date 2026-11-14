import { agentsPaneIsChat, type GitQuireFeatures, hasClaudeAccess } from './features';

export type ClaudeDestination = 'claude-web' | 'claude-app' | 'claude-code';
export type AskDestination = ClaudeDestination | 'gitquire-chat';

export const CLAUDE_DESTINATIONS: readonly ClaudeDestination[] = [
  'claude-web',
  'claude-app',
  'claude-code',
];

export function askDestinations(features: GitQuireFeatures): AskDestination[] {
  return [
    ...(agentsPaneIsChat(features) ? (['gitquire-chat'] as const) : []),
    ...(hasClaudeAccess(features) ? CLAUDE_DESTINATIONS : []),
  ];
}

export function isAskDestination(value: unknown): value is AskDestination {
  return value === 'gitquire-chat' || isClaudeDestination(value);
}

export function defaultAskDestination(
  features: GitQuireFeatures,
  stored: string | null,
): AskDestination {
  const available = askDestinations(features);
  if (isAskDestination(stored) && available.includes(stored)) return stored;
  if (available.includes('gitquire-chat')) return 'gitquire-chat';
  return defaultDestination(features, null);
}

export const MAX_REQUEST_CHARS = 4000;
const DESTINATION_STORAGE_KEY = 'gitquire.askClaude.destination';

export interface ClaudePromptInput {
  wikiUrl: string;
  target: { kind: 'page' | 'folder'; path: string };
  request: string;
}

export function buildClaudePrompt(input: ClaudePromptInput): string {
  const where =
    input.target.kind === 'page'
      ? `Page: ${input.target.path}`
      : `Folder: ${input.target.path === '' ? '(the whole wiki)' : input.target.path}`;
  const request = input.request.trim().slice(0, MAX_REQUEST_CHARS);
  return [
    `Use the GitQuire wiki tools (the MCP server for ${input.wikiUrl}) for this.`,
    '',
    where,
    '',
    request,
  ].join('\n');
}

export function claudeLink(destination: ClaudeDestination, prompt: string): string {
  const q = encodeURIComponent(prompt);
  switch (destination) {
    case 'claude-web':
      return `https://claude.ai/new?q=${q}`;
    case 'claude-app':
      return `claude://claude.ai/new?q=${q}`;
    case 'claude-code':
      return `claude://code/new?q=${q}`;
    default: {
      const unreachable: never = destination;
      throw new Error(`Unknown destination ${String(unreachable)}`);
    }
  }
}

export function isClaudeDestination(value: unknown): value is ClaudeDestination {
  return typeof value === 'string' && (CLAUDE_DESTINATIONS as readonly string[]).includes(value);
}

export function defaultDestination(
  features: Pick<GitQuireFeatures, 'agentToken' | 'connector'>,
  stored: string | null,
): ClaudeDestination {
  if (isClaudeDestination(stored)) return stored;
  return features.connector ? 'claude-web' : 'claude-code';
}

export function loadStoredDestination(): string | null {
  try {
    return window.localStorage.getItem(DESTINATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeDestination(destination: AskDestination): void {
  try {
    window.localStorage.setItem(DESTINATION_STORAGE_KEY, destination);
  } catch {}
}

export function openClaudeLink(url: string): void {
  if (url.startsWith('https://')) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  window.location.assign(url);
}
