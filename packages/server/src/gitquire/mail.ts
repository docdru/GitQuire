import { randomBytes } from 'node:crypto';
import { connect as connectPlain, isIP, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';

type Env = Readonly<Record<string, string | undefined>>;

const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const MAX_EMAIL_LENGTH = 254;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_DEADLINE_MS = 60_000;
const QUIT_GRACE_MS = 1000;
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_SUBJECT_CHARS = 150;
const PLAIN_SUBJECT_CHARS = 60;
const ENCODED_WORD_BYTES = 30;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

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
  allowedDomains: string[] | undefined;
}

export function isAllowedRecipient(
  config: Pick<MailConfig, 'allowedDomains'>,
  to: string,
): boolean {
  if (config.allowedDomains === undefined) return true;
  const domain = to.slice(to.lastIndexOf('@') + 1).toLowerCase();
  return config.allowedDomains.includes(domain);
}

function decoded(part: string): string | undefined {
  if (part === '') return undefined;
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function queryValue(url: URL, name: string): string | undefined {
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() === name) return value.toLowerCase();
  }
  return undefined;
}

function domainList(raw: string | undefined): string[] | undefined {
  const domains = (raw ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain !== '');
  return domains.length === 0 ? undefined : domains;
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
  const startTls = !implicitTls && queryValue(url, 'starttls') !== 'off';
  const user = decoded(url.username);
  const password = decoded(url.password);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '') return { kind: 'invalid', reason: 'GITQUIRE_SMTP_URL has no host.' };
  if (user === undefined && password !== undefined) {
    return { kind: 'invalid', reason: 'GITQUIRE_SMTP_URL has a password but no user name.' };
  }
  if (user !== undefined && !implicitTls && !startTls && !LOOPBACK_HOSTS.has(host)) {
    return {
      kind: 'invalid',
      reason: 'GITQUIRE_SMTP_URL has a password but turns encryption off for a remote host.',
    };
  }
  const port = url.port === '' ? (implicitTls ? 465 : 587) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { kind: 'invalid', reason: 'GITQUIRE_SMTP_URL has an invalid port.' };
  }
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
      allowedDomains: domainList(env.GITQUIRE_MAIL_DOMAINS),
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
    .slice(0, MAX_SUBJECT_CHARS)
    .join('')
    .trim();
  if (flat.length <= PLAIN_SUBJECT_CHARS && isPlainHeaderText(flat)) return flat;
  const words: string[] = [];
  let chunk = '';
  for (const char of flat) {
    if (Buffer.byteLength(chunk + char, 'utf8') > ENCODED_WORD_BYTES) {
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
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
  }
}

export function isPermanentMailFailure(err: unknown): boolean {
  return err instanceof SmtpError && err.code !== undefined && err.code >= 500 && err.code < 600;
}

interface ReplyReader {
  next: () => Promise<Reply>;
  idle: () => boolean;
  detach: () => void;
}

function createReplyReader(socket: Socket): ReplyReader {
  let buffer = '';
  let received = 0;
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
    received += chunk.length;
    if (received > MAX_REPLY_BYTES) {
      fail(new SmtpError('The mail server sent too much data.'));
      socket.destroy();
      return;
    }
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

  function onError(err: Error): void {
    fail(err);
  }
  function onClose(): void {
    fail(new SmtpError('The mail server closed the connection.'));
  }
  function onTimeout(): void {
    fail(new SmtpError('The mail server did not answer in time.'));
    socket.destroy();
  }
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
    idle: () => ready.length === 0 && lines.length === 0 && buffer === '',
    detach: () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('timeout', onTimeout);
    },
  };
}

async function expectReply(
  reader: ReplyReader,
  accepted: readonly number[],
  step: string,
): Promise<Reply> {
  const reply = await reader.next();
  if (!accepted.includes(reply.code)) {
    const detail = reply.lines.join(' ').slice(0, 200);
    throw new SmtpError(`The mail server refused ${step}: ${detail}`, reply.code);
  }
  return reply;
}

function opened(socket: Socket, event: 'connect' | 'secureConnect'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    function cleanup(): void {
      socket.off(event, onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('timeout', onTimeout);
    }
    function onOpen(): void {
      cleanup();
      resolve();
    }
    function onError(err: Error): void {
      cleanup();
      reject(err);
    }
    function onClose(): void {
      cleanup();
      reject(new SmtpError('The mail server closed the connection.'));
    }
    function onTimeout(): void {
      cleanup();
      socket.destroy();
      reject(new SmtpError('The mail server did not answer in time.'));
    }
    socket.on(event, onOpen);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('timeout', onTimeout);
  });
}

function dotStuffed(body: string): string {
  return body.replace(/^\./gm, '..');
}

function tlsName(host: string): { servername?: string } {
  return isIP(host) === 0 ? { servername: host } : {};
}

export interface SendMailOptions {
  timeoutMs?: number;
  deadlineMs?: number;
  now?: () => Date;
  clientName?: string;
}

function ignoreSocketErrors(): void {}

async function deliver(
  config: MailConfig,
  message: MailMessage,
  options: SendMailOptions,
  sockets: Socket[],
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const domain = config.from.slice(config.from.lastIndexOf('@') + 1);
  const clientName = options.clientName ?? domain;

  function track(socket: Socket): Socket {
    socket.on('error', ignoreSocketErrors);
    socket.setTimeout(timeoutMs);
    sockets.push(socket);
    return socket;
  }

  let socket = track(
    config.implicitTls
      ? connectTls({ host: config.host, port: config.port, ...tlsName(config.host) })
      : connectPlain({ host: config.host, port: config.port }),
  );
  await opened(socket, config.implicitTls ? 'secureConnect' : 'connect');
  let reader = createReplyReader(socket);

  function send(line: string): void {
    if (!reader.idle()) throw new SmtpError('The mail server sent a reply nobody asked for.');
    socket.write(`${line}\r\n`);
  }

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
    if (!reader.idle()) throw new SmtpError('The mail server sent data before encryption started.');
    reader.detach();
    socket = track(connectTls({ socket, ...tlsName(config.host) }));
    await opened(socket, 'secureConnect');
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
  const messageId = `${randomBytes(12).toString('hex')}@${domain}`;
  socket.write(`${dotStuffed(buildMimeMessage(config, message, now, messageId))}.\r\n`);
  await expectReply(reader, [250], 'the message');
  socket.end('QUIT\r\n');
}

export async function sendMail(
  config: MailConfig,
  message: MailMessage,
  options: SendMailOptions = {},
): Promise<void> {
  if (!isEmailAddress(message.to)) throw new SmtpError('The recipient is not an email address.');
  const sockets: Socket[] = [];
  const delivery = deliver(config, message, options, sockets);
  delivery.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new SmtpError('Sending the mail took too long.'));
    }, options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  });
  function closeAll(): void {
    for (const socket of sockets) socket.destroy();
  }
  let delivered = false;
  try {
    await Promise.race([delivery, deadline]);
    delivered = true;
  } finally {
    clearTimeout(timer);
    if (delivered) {
      setTimeout(closeAll, QUIT_GRACE_MS).unref();
    } else {
      closeAll();
    }
  }
}
