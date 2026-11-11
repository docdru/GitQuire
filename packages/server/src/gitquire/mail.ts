import { randomBytes } from 'node:crypto';
import { connect as connectPlain, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { connect as connectTls } from 'node:tls';

type Env = Readonly<Record<string, string | undefined>>;

const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const MAX_EMAIL_LENGTH = 254;
const DEFAULT_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isEmailAddress(value: string): boolean {
  return value.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(value);
}

export interface MailConfig {
  host: string;
  port: number;
  implicitTls: boolean;
  startTls: boolean;
  user: string | undefined;
  password: string | undefined;
  from: string;
  externalUrl: string | undefined;
}

export type MailConfigResult =
  | { kind: 'off' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'on'; config: MailConfig };

export function resolveMailConfig(env: Env): MailConfigResult {
  const raw = env.GITQUIRE_SMTP_URL?.trim() ?? '';
  if (raw === '') return { kind: 'off' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'invalid', reason: 'GITQUIRE_SMTP_URL is not a valid URL.' };
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
    return { kind: 'invalid', reason: 'GITQUIRE_SMTP_URL must start with smtp:// or smtps://.' };
  }
  const from = env.GITQUIRE_MAIL_FROM?.trim() ?? '';
  if (!isEmailAddress(from)) {
    return { kind: 'invalid', reason: 'GITQUIRE_MAIL_FROM must be an email address.' };
  }
  const implicitTls = url.protocol === 'smtps:';
  const startTls = !implicitTls && url.searchParams.get('starttls') !== 'off';
  const user = url.username === '' ? undefined : decodeURIComponent(url.username);
  const password = url.password === '' ? undefined : decodeURIComponent(url.password);
  const host = url.hostname;
  if (host === '') return { kind: 'invalid', reason: 'GITQUIRE_SMTP_URL has no host.' };
  if (user !== undefined && !implicitTls && !startTls && !LOOPBACK_HOSTS.has(host)) {
    return {
      kind: 'invalid',
      reason: 'GITQUIRE_SMTP_URL has a password but turns encryption off for a remote host.',
    };
  }
  const port = url.port === '' ? (implicitTls ? 465 : 587) : Number(url.port);
  const externalUrl = env.OK_EXTERNAL_URL?.trim().replace(/\/+$/, '');
  return {
    kind: 'on',
    config: {
      host,
      port,
      implicitTls,
      startTls,
      user,
      password,
      from,
      externalUrl: externalUrl === undefined || externalUrl === '' ? undefined : externalUrl,
    },
  };
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

function isPlainHeaderText(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

export function encodeHeaderText(text: string): string {
  const flat = [...text]
    .map((char) => ((char.codePointAt(0) ?? 0) < 0x20 ? ' ' : char))
    .join('')
    .trim();
  if (isPlainHeaderText(flat)) return flat;
  const words: string[] = [];
  let chunk = '';
  for (const char of flat) {
    if (Buffer.byteLength(chunk + char, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk !== '') words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

function wrapBase64(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join('\r\n');
}

export function buildMimeMessage(
  config: Pick<MailConfig, 'from'>,
  message: MailMessage,
  now: Date,
  messageId: string,
): string {
  const headers = [
    `From: GitQuire <${config.from}>`,
    `To: <${message.to}>`,
    `Subject: ${encodeHeaderText(message.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${wrapBase64(message.text)}\r\n`;
}

interface Reply {
  code: number;
  lines: string[];
}

export class SmtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpError';
  }
}

function createReplyReader(socket: Socket): { next: () => Promise<Reply>; detach: () => void } {
  let buffer = '';
  let lines: string[] = [];
  const ready: Reply[] = [];
  let waiting: { resolve: (reply: Reply) => void; reject: (err: Error) => void } | undefined;
  let failure: Error | undefined;

  function fail(err: Error): void {
    failure ??= err;
    waiting?.reject(failure);
    waiting = undefined;
  }

  function onData(chunk: Buffer): void {
    buffer += chunk.toString('utf8');
    let end = buffer.indexOf('\n');
    while (end !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines };
        lines = [];
        if (waiting === undefined) {
          ready.push(reply);
        } else {
          waiting.resolve(reply);
          waiting = undefined;
        }
      }
      end = buffer.indexOf('\n');
    }
  }

  const onError = (err: Error): void => fail(err);
  const onClose = (): void => fail(new SmtpError('The mail server closed the connection.'));
  const onTimeout = (): void => {
    fail(new SmtpError('The mail server did not answer in time.'));
    socket.destroy();
  };
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  socket.on('timeout', onTimeout);

  return {
    next: () => {
      const reply = ready.shift();
      if (reply !== undefined) return Promise.resolve(reply);
      if (failure !== undefined) return Promise.reject(failure);
      return new Promise<Reply>((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    detach: () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('timeout', onTimeout);
    },
  };
}

async function expectReply(
  reader: { next: () => Promise<Reply> },
  accepted: readonly number[],
  step: string,
): Promise<Reply> {
  const reply = await reader.next();
  if (!accepted.includes(reply.code)) {
    throw new SmtpError(`The mail server refused ${step}: ${reply.lines.join(' ').slice(0, 200)}`);
  }
  return reply;
}

function opened(socket: Socket, event: 'connect' | 'secureConnect'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.once(event, () => resolve());
    socket.once('error', reject);
  });
}

function dotStuffed(body: string): string {
  return body.replace(/^\./gm, '..');
}

export interface SendMailOptions {
  timeoutMs?: number;
  now?: () => Date;
  clientName?: string;
}

export async function sendMail(
  config: MailConfig,
  message: MailMessage,
  options: SendMailOptions = {},
): Promise<void> {
  if (!isEmailAddress(message.to)) throw new SmtpError('The recipient is not an email address.');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clientName = options.clientName ?? (hostname() || 'localhost');
  let socket: Socket = config.implicitTls
    ? connectTls({ host: config.host, port: config.port, servername: config.host })
    : connectPlain({ host: config.host, port: config.port });
  socket.setTimeout(timeoutMs);
  try {
    await opened(socket, config.implicitTls ? 'secureConnect' : 'connect');
    let reader = createReplyReader(socket);
    const send = (line: string): void => {
      socket.write(`${line}\r\n`);
    };
    await expectReply(reader, [220], 'the connection');
    send(`EHLO ${clientName}`);
    const hello = await expectReply(reader, [250], 'EHLO');
    let encrypted = config.implicitTls;
    if (config.startTls) {
      if (!hello.lines.some((line) => /^250[ -]STARTTLS\b/i.test(line))) {
        throw new SmtpError('The mail server does not offer STARTTLS.');
      }
      send('STARTTLS');
      await expectReply(reader, [220], 'STARTTLS');
      reader.detach();
      const secured = connectTls({ socket, servername: config.host });
      secured.setTimeout(timeoutMs);
      await opened(secured, 'secureConnect');
      socket = secured;
      reader = createReplyReader(socket);
      send(`EHLO ${clientName}`);
      await expectReply(reader, [250], 'EHLO');
      encrypted = true;
    }
    if (config.user !== undefined) {
      if (!encrypted && !LOOPBACK_HOSTS.has(config.host)) {
        throw new SmtpError('Refusing to send a password over an unencrypted connection.');
      }
      const token = Buffer.from(`\0${config.user}\0${config.password ?? ''}`, 'utf8');
      send(`AUTH PLAIN ${token.toString('base64')}`);
      await expectReply(reader, [235], 'the sign-in');
    }
    send(`MAIL FROM:<${config.from}>`);
    await expectReply(reader, [250], 'the sender');
    send(`RCPT TO:<${message.to}>`);
    await expectReply(reader, [250, 251], 'the recipient');
    send('DATA');
    await expectReply(reader, [354], 'DATA');
    const now = options.now?.() ?? new Date();
    const domain = config.from.slice(config.from.lastIndexOf('@') + 1);
    const messageId = `${randomBytes(12).toString('hex')}@${domain}`;
    socket.write(`${dotStuffed(buildMimeMessage(config, message, now, messageId))}.\r\n`);
    await expectReply(reader, [250], 'the message');
    send('QUIT');
    reader.detach();
  } finally {
    socket.on('error', () => {});
    socket.destroy();
  }
}
