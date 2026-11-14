import type { SessionUser } from '../access-gate.ts';
import type { ChatRecord } from './history.ts';
import { PROVIDER_INFO } from './models.ts';

const SEGMENT_RE = /^[\p{L}\p{N} _.,()'&+-]+$/u;
const MAX_PATH_LENGTH = 200;

export class InvalidPagePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPagePathError';
  }
}

export function normalizePagePath(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidPagePathError('Choose where to save the page.');
  const path = raw
    .trim()
    .replace(/\.mdx?$/i, '')
    .replace(/\/+$/, '');
  if (path === '') throw new InvalidPagePathError('Choose where to save the page.');
  if (path.length > MAX_PATH_LENGTH) throw new InvalidPagePathError('That page name is too long.');
  const segments = path.split('/');
  if (segments.some((segment) => segment.trim() === '' || segment.startsWith('.'))) {
    throw new InvalidPagePathError('Use folder/page names separated by "/".');
  }
  if (!segments.every((segment) => SEGMENT_RE.test(segment))) {
    throw new InvalidPagePathError(
      'Use letters, numbers, spaces and - _ . , ( ) in page and folder names.',
    );
  }
  return path;
}

export function suggestedPagePath(chat: ChatRecord): string {
  const day = chat.createdAt.slice(0, 10);
  const title = chat.title
    .replace(/[^\p{L}\p{N} _-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return `AI chats/${day} ${title === '' ? 'Chat' : title}`;
}

function quoteBlock(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

function toolLine(name: string, input: Record<string, unknown>): string {
  const document = input.document as Record<string, unknown> | undefined;
  const target =
    typeof document?.path === 'string'
      ? document.path
      : typeof input.query === 'string'
        ? input.query
        : typeof input.command === 'string'
          ? input.command
          : undefined;
  return target === undefined
    ? `*Used ${name}.*`
    : `*Used ${name}: \`${target.replace(/`/g, "'")}\`*`;
}

export function chatTranscript(chat: ChatRecord, user: SessionUser): string {
  const assistant =
    PROVIDER_INFO[chat.provider].models.find((model) => model.id === chat.model)?.label ??
    chat.model;
  const lines: string[] = [
    `# ${chat.title}`,
    '',
    `AI chat between @${user.login} and ${assistant}, started ${chat.createdAt.slice(0, 16).replace('T', ' ')} UTC.`,
    '',
  ];
  for (const message of chat.messages) {
    if (message.role === 'user') {
      lines.push(`**@${user.login}:**`, '', quoteBlock(message.text), '');
    } else if (message.role === 'assistant') {
      const tools = message.toolCalls.map((call) => toolLine(call.name, call.input));
      if (message.text.trim() !== '') lines.push(`**${assistant}:**`, '', message.text.trim(), '');
      if (tools.length > 0) lines.push(...tools.map((line) => `- ${line}`), '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
