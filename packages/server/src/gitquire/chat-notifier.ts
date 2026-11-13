import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GateLogger } from './access-gate.ts';
import { pageLink } from './mention-mailer.ts';
import type { Mention, MentionIndex } from './mentions.ts';

type Env = Readonly<Record<string, string | undefined>>;

export type ChatFormat = 'slack' | 'teams' | 'discord' | 'generic';

const FORMATS: readonly ChatFormat[] = ['slack', 'teams', 'discord', 'generic'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const MAX_POSTS_PER_ROUND = 10;
const MAX_POSTS_PER_HOUR = 60;
const POST_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 300;
const HOUR_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = HOUR_MS;

export interface ChatConfig {
  url: string;
  format: ChatFormat;
  externalUrl: string | undefined;
}

export type ChatConfigResult =
  | { kind: 'off' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'on'; config: ChatConfig };

export function guessChatFormat(url: URL): ChatFormat {
  const host = url.hostname.toLowerCase();
  if (host === 'hooks.slack.com') return 'slack';
  const discord = ['discord.com', 'discordapp.com'];
  if (discord.some((name) => host === name || host.endsWith(`.${name}`))) return 'discord';
  if (
    host.endsWith('.webhook.office.com') ||
    host.endsWith('.logic.azure.com') ||
    host.endsWith('.powerplatform.com')
  ) {
    return 'teams';
  }
  if (url.pathname.includes('/hooks/')) return 'slack';
  return 'generic';
}

export function resolveChatConfig(env: Env): ChatConfigResult {
  const raw = env.GITQUIRE_CHAT_WEBHOOK_URL?.trim() ?? '';
  if (raw === '') return { kind: 'off' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'invalid', reason: 'GITQUIRE_CHAT_WEBHOOK_URL is not a valid URL.' };
  }
  const local = LOCAL_HOSTS.has(url.hostname.replace(/^\[|\]$/g, '').toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return { kind: 'invalid', reason: 'GITQUIRE_CHAT_WEBHOOK_URL must use https://.' };
  }
  const wanted = env.GITQUIRE_CHAT_FORMAT?.trim().toLowerCase() ?? '';
  if (wanted !== '' && !FORMATS.includes(wanted as ChatFormat)) {
    return {
      kind: 'invalid',
      reason: `GITQUIRE_CHAT_FORMAT must be one of ${FORMATS.join(', ')}.`,
    };
  }
  const externalUrl = env.OK_EXTERNAL_URL?.trim().replace(/\/+$/, '');
  return {
    kind: 'on',
    config: {
      url: url.toString(),
      format: wanted === '' ? guessChatFormat(url) : (wanted as ChatFormat),
      externalUrl: externalUrl === undefined || externalUrl === '' ? undefined : externalUrl,
    },
  };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_TEXT_CHARS ? flat : `${flat.slice(0, MAX_TEXT_CHARS - 1)}…`;
}

function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface ChatMessage {
  who: string;
  page: string;
  docName: string;
  link: string | undefined;
  mentioned: string[];
  quote: string;
  comment: string;
}

export function chatMessage(
  config: Pick<ChatConfig, 'externalUrl'>,
  mention: Mention,
): ChatMessage {
  return {
    who: clip(mention.author.name?.trim() || mention.author.login || '') || 'Someone',
    page: clip(mention.docName.slice(mention.docName.lastIndexOf('/') + 1)),
    docName: mention.docName,
    link: pageLink(config.externalUrl, mention.docName),
    mentioned: mention.logins.map((login) => `@${login}`),
    quote: clip(mention.quote),
    comment: mention.kind === 'task' ? `☐ ${clip(mention.body)}` : clip(mention.body),
  };
}

function plainText(message: ChatMessage): string {
  const where = message.link === undefined ? message.page : `${message.page} (${message.link})`;
  const who = `${message.who} mentioned ${message.mentioned.join(', ')}`;
  return `${who} in ${where}: "${message.comment}"`;
}

export function chatPayload(format: ChatFormat, message: ChatMessage): unknown {
  if (format === 'slack') {
    const page =
      message.link === undefined
        ? `*${slackEscape(message.page)}*`
        : `<${message.link}|${slackEscape(message.page)}>`;
    const who = slackEscape(`${message.who} mentioned ${message.mentioned.join(', ')}`);
    const lines = [`${who} in ${page}`, `> ${slackEscape(message.comment)}`];
    return { text: lines.join('\n') };
  }
  if (format === 'discord') {
    return { content: plainText(message), allowed_mentions: { parse: [] } };
  }
  if (format === 'teams') {
    const body: unknown[] = [
      {
        type: 'TextBlock',
        text: `${message.who} mentioned ${message.mentioned.join(', ')} in ${message.page}`,
        weight: 'Bolder',
        wrap: true,
      },
      { type: 'TextBlock', text: message.comment, wrap: true },
      { type: 'TextBlock', text: `On the text: "${message.quote}"`, isSubtle: true, wrap: true },
    ];
    const open = { type: 'Action.OpenUrl', title: 'Open page', url: message.link };
    const actions = message.link === undefined ? [] : [open];
    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body,
            actions,
          },
        },
      ],
    };
  }
  return {
    text: plainText(message),
    event: 'mention',
    author: message.who,
    mentioned: message.mentioned,
    page: message.page,
    docName: message.docName,
    url: message.link ?? null,
    quote: message.quote,
    comment: message.comment,
  };
}

export class ChatPostError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ChatPostError';
    this.status = status;
  }
}

export type ChatPost = (url: string, payload: unknown) => Promise<void>;

export const postToChat: ChatPost = async (url, payload) => {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err) {
    throw new ChatPostError(networkReason(err));
  }
  if (res.ok) {
    await res.body?.cancel();
    return;
  }
  const detail = (await res.text().catch(() => '')).trim().slice(0, 200);
  const message = `The chat webhook answered ${res.status}${detail === '' ? '' : `: ${detail}`}.`;
  throw new ChatPostError(message, res.status);
};

function networkReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${err.message} (${code})` : err.message;
}

const WEBHOOK_GONE = new Set([401, 403, 404, 408, 410, 429]);

function isPermanent(err: unknown): boolean {
  return (
    err instanceof ChatPostError &&
    err.status !== undefined &&
    err.status >= 400 &&
    err.status < 500 &&
    !WEBHOOK_GONE.has(err.status)
  );
}

interface ChatState {
  version: 1;
  since: string;
  posted: string[];
}

export function chatStatePath(projectDir: string): string {
  return join(projectDir, '.ok', 'local', 'gitquire', 'chat.json');
}

function loadChatState(file: string, log: Pick<GateLogger, 'warn'>): ChatState | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ChatState> | null;
    if (typeof parsed?.since === 'string' && Array.isArray(parsed.posted)) {
      const posted = parsed.posted.filter((id): id is string => typeof id === 'string');
      return { version: 1, since: parsed.since, posted };
    }
  } catch {}
  log.warn({ file }, '[gitquire-chat] the chat state file is damaged; starting again from now');
  return undefined;
}

function saveChatState(file: string, state: ChatState): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export interface ChatNotifierDeps {
  index: MentionIndex;
  config: ChatConfig;
  stateFile: string;
  post?: ChatPost;
  log: Pick<GateLogger, 'warn' | 'info'>;
  now?: () => number;
}

export interface ChatNotifier {
  round: () => Promise<number>;
}

export function createChatNotifier(deps: ChatNotifierDeps): ChatNotifier {
  const post = deps.post ?? postToChat;
  const now = deps.now ?? Date.now;
  let state = loadChatState(deps.stateFile, deps.log);
  let running = false;
  let sentTimes: number[] = [];
  let failures = 0;
  let retryAt = 0;

  function remember(ids: readonly string[], live?: ReadonlySet<string>): void {
    const kept = (state?.posted ?? []).filter((id) => live === undefined || live.has(id));
    const merged = new Set([...kept, ...ids]);
    const since = state?.since ?? new Date(now()).toISOString();
    state = { version: 1, since, posted: [...merged] };
    saveChatState(deps.stateFile, state);
  }

  async function postOne(mention: Mention): Promise<boolean> {
    const payload = chatPayload(deps.config.format, chatMessage(deps.config, mention));
    try {
      await post(deps.config.url, payload);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (isPermanent(err)) {
        deps.log.warn({ reason }, '[gitquire-chat] the chat webhook refused a mention');
        remember([mention.id]);
        return false;
      }
      failures += 1;
      retryAt = now() + Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** failures);
      deps.log.warn({ reason }, '[gitquire-chat] could not post a mention');
      throw err;
    }
    failures = 0;
    sentTimes.push(now());
    remember([mention.id]);
    return true;
  }

  async function round(): Promise<number> {
    if (running || now() < retryAt) return 0;
    running = true;
    let sent = 0;
    try {
      const all = deps.index.all();
      if (state === undefined) {
        remember(all.map((mention) => mention.id));
        deps.log.info({ existing: all.length }, '[gitquire-chat] posting new mentions from now on');
        return 0;
      }
      const live = new Set(all.map((mention) => mention.id));
      if (state.posted.some((id) => !live.has(id))) remember([], live);
      const since = Date.parse(state.since);
      const posted = new Set(state.posted);
      const due = all
        .filter((mention) => !(Date.parse(mention.at) < since) && !posted.has(mention.id))
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
        .slice(0, MAX_POSTS_PER_ROUND);
      for (const mention of due) {
        sentTimes = sentTimes.filter((time) => now() - time < HOUR_MS);
        if (sentTimes.length >= MAX_POSTS_PER_HOUR) break;
        if (await postOne(mention)) sent += 1;
      }
    } catch (err) {
      if (!(err instanceof ChatPostError)) {
        const reason = err instanceof Error ? err.message : String(err);
        deps.log.warn({ reason }, '[gitquire-chat] a chat round failed');
      }
      return sent;
    } finally {
      running = false;
    }
    return sent;
  }

  return { round };
}
