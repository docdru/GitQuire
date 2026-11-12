import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMimeMessage,
  encodeHeaderText,
  isAllowedRecipient,
  isEmailAddress,
  isPermanentMailFailure,
  type MailConfig,
  resolveMailConfig,
  SmtpError,
  sendMail,
} from './mail.ts';

interface FakeSmtp {
  port: number;
  commands: string[];
  data: string[];
  server: Server;
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

function answerFor(line: string, rejectRecipient: boolean): string | undefined {
  if (line.startsWith('EHLO')) return '250-test.local\r\n250 AUTH PLAIN\r\n';
  if (line.startsWith('AUTH PLAIN')) return '235 ok\r\n';
  if (line.startsWith('MAIL FROM')) return '250 ok\r\n';
  if (line.startsWith('RCPT TO')) return rejectRecipient ? '550 no such user\r\n' : '250 ok\r\n';
  if (line === 'DATA') return '354 go ahead\r\n';
  if (line === 'QUIT') return '221 bye\r\n';
  return undefined;
}

async function fakeSmtp(options: { rejectRecipient?: boolean } = {}): Promise<FakeSmtp> {
  const commands: string[] = [];
  const data: string[] = [];
  const server = createServer((socket) => {
    let buffer = '';
    let inData = false;
    socket.on('error', () => {});
    socket.write('220 test.local ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end = buffer.indexOf('\r\n');
      while (end !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\r\n');
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 queued\r\n');
          } else {
            data.push(line);
          }
          continue;
        }
        commands.push(line);
        if (line === 'DATA') inData = true;
        const answer = answerFor(line, options.rejectRecipient === true);
        if (answer !== undefined) socket.write(answer);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP port');
  return { port: address.port, commands, data, server };
}

function configFor(url: string): MailConfig {
  const result = resolveMailConfig({
    GITQUIRE_SMTP_URL: url,
    GITQUIRE_MAIL_FROM: 'wiki@example.com',
  });
  if (result.kind !== 'on') throw new Error(`expected mail to be on, got ${result.kind}`);
  return result.config;
}

function kindOf(url: string, from: string | undefined): string {
  return resolveMailConfig({ GITQUIRE_SMTP_URL: url, GITQUIRE_MAIL_FROM: from }).kind;
}

describe('mail settings', () => {
  it('is off without a server and reports what is wrong otherwise', () => {
    const from = 'wiki@example.com';
    expect(resolveMailConfig({})).toEqual({ kind: 'off' });
    expect(kindOf('http://mail.example.com', from)).toBe('invalid');
    expect(kindOf('smtp://mail.example.com', undefined)).toBe('invalid');
    expect(kindOf('smtp://user:secret@mail.example.com?starttls=off', from)).toBe('invalid');
    expect(kindOf('smtp://user:secret@mail.example.com', from)).toBe('on');
    expect(kindOf('smtp://:secret@mail.example.com', from)).toBe('invalid');
    expect(kindOf('smtp://mail.example.com:0', from)).toBe('invalid');
    expect(kindOf('smtp://user:50%off@mail.example.com', from)).toBe('on');
  });

  it('reads host, port, encryption, sign-in and the public address', () => {
    const result = resolveMailConfig({
      GITQUIRE_SMTP_URL: 'smtp://wiki%40example.com:p%40ss@mail.example.com',
      GITQUIRE_MAIL_FROM: ' wiki@example.com ',
      OK_EXTERNAL_URL: 'https://brain.example.com/',
    });
    expect(result).toEqual({
      kind: 'on',
      config: {
        host: 'mail.example.com',
        port: 587,
        implicitTls: false,
        startTls: true,
        user: 'wiki@example.com',
        password: 'p@ss',
        from: 'wiki@example.com',
        externalUrl: 'https://brain.example.com',
        allowedDomains: undefined,
      },
    });
    expect(configFor('smtps://mail.example.com')).toMatchObject({ port: 465, implicitTls: true });
    expect(configFor('smtp://[::1]:2525?STARTTLS=OFF')).toMatchObject({
      host: '::1',
      port: 2525,
      startTls: false,
    });
  });

  it('limits recipients to the listed domains when a list is set', () => {
    const result = resolveMailConfig({
      GITQUIRE_SMTP_URL: 'smtps://mail.example.com',
      GITQUIRE_MAIL_FROM: 'wiki@example.com',
      GITQUIRE_MAIL_DOMAINS: ' Example.com, example.org ',
    });
    if (result.kind !== 'on') throw new Error('expected mail to be on');
    expect(result.config.allowedDomains).toEqual(['example.com', 'example.org']);
    expect(isAllowedRecipient(result.config, 'alice@EXAMPLE.org')).toBe(true);
    expect(isAllowedRecipient(result.config, 'alice@elsewhere.net')).toBe(false);
    expect(isAllowedRecipient({ allowedDomains: undefined }, 'alice@elsewhere.net')).toBe(true);
  });

  it('accepts ordinary addresses only', () => {
    expect(isEmailAddress('alice@example.com')).toBe(true);
    expect(isEmailAddress('alice+wiki@mail.example.co.uk')).toBe(true);
    expect(isEmailAddress('alice@example')).toBe(false);
    expect(isEmailAddress('alice@example.com\r\nBcc: eve@example.com')).toBe(false);
    expect(isEmailAddress('alice <alice@example.com>')).toBe(false);
  });
});

describe('mail message', () => {
  it('keeps plain subjects and encodes others without line breaks from the input', () => {
    expect(encodeHeaderText('bob mentioned you in report')).toBe('bob mentioned you in report');
    expect(encodeHeaderText('a\r\nBcc: eve@example.com')).toBe('a  Bcc: eve@example.com');
    const subject = 'Zoë mentioned you in Übersicht der Quartalszahlen';
    const words = encodeHeaderText(subject).split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(`Subject: ${word}`.length).toBeLessThanOrEqual(76);
    }
    const text = words
      .map((word) => Buffer.from(word.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'))
      .join('');
    expect(text).toBe(subject);
    const long = encodeHeaderText(`${'a'.repeat(400)} report`);
    expect(long.split('\r\n ').every((line) => line.length <= 76)).toBe(true);
    expect(long.length).toBeLessThan(400);
  });

  it('builds headers and a base64 body', () => {
    const mime = buildMimeMessage(
      { from: 'wiki@example.com' },
      { to: 'alice@example.com', subject: 'Hello', text: 'Line one\n.Line two\n' },
      new Date('2026-11-11T12:00:00Z'),
      'abc@example.com',
    );
    const [head, body] = mime.split('\r\n\r\n');
    expect(head?.split('\r\n')).toEqual([
      'From: GitQuire <wiki@example.com>',
      'To: <alice@example.com>',
      'Subject: Hello',
      'Date: Wed, 11 Nov 2026 12:00:00 +0000',
      'Message-ID: <abc@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      'Auto-Submitted: auto-generated',
    ]);
    expect(Buffer.from(body ?? '', 'base64').toString('utf8')).toBe('Line one\n.Line two\n');
  });
});

describe('sending mail', () => {
  it('signs in and delivers a message to a local server', async () => {
    const smtp = await fakeSmtp();
    const config = configFor(`smtp://user:secret@127.0.0.1:${smtp.port}?starttls=off`);
    await sendMail(
      config,
      { to: 'alice@example.com', subject: 'Hello', text: 'A mention for you.\n' },
      { clientName: 'gitquire.test', timeoutMs: 5000 },
    );
    expect(smtp.commands.slice(0, 5)).toEqual([
      'EHLO gitquire.test',
      `AUTH PLAIN ${Buffer.from('\0user\0secret').toString('base64')}`,
      'MAIL FROM:<wiki@example.com>',
      'RCPT TO:<alice@example.com>',
      'DATA',
    ]);
    expect(smtp.data).toContain('Subject: Hello');
    const body = smtp.data.slice(smtp.data.indexOf('') + 1).join('');
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('A mention for you.\n');
  });

  it('reports a refused recipient', async () => {
    const smtp = await fakeSmtp({ rejectRecipient: true });
    const config = configFor(`smtp://127.0.0.1:${smtp.port}?starttls=off`);
    const message = { to: 'nobody@example.com', subject: 'Hello', text: 'Hi\n' };
    const failure = await sendMail(config, message, { timeoutMs: 5000 }).catch((err) => err);
    expect(failure).toBeInstanceOf(SmtpError);
    expect(String(failure)).toMatch(/refused the recipient/);
    expect(isPermanentMailFailure(failure)).toBe(true);
  });

  it('gives up when the server accepts the connection and then says nothing', async () => {
    const silent = createServer((socket) => {
      socket.on('error', () => {});
    });
    servers.push(silent);
    await new Promise<void>((resolve) => {
      silent.listen(0, '127.0.0.1', () => resolve());
    });
    const address = silent.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP port');
    const config = configFor(`smtp://127.0.0.1:${address.port}?starttls=off`);
    const message = { to: 'alice@example.com', subject: 'Hello', text: 'Hi\n' };
    const started = Date.now();
    const options = { timeoutMs: 60_000, deadlineMs: 200 };
    const failure = await sendMail(config, message, options).catch((err) => err);
    expect(String(failure)).toMatch(/took too long/);
    expect(isPermanentMailFailure(failure)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('stops when the server sends a reply nobody asked for', async () => {
    const chatty = createServer((socket) => {
      socket.on('error', () => {});
      socket.write('220 test.local ESMTP\r\n250 surprise\r\n');
    });
    servers.push(chatty);
    await new Promise<void>((resolve) => {
      chatty.listen(0, '127.0.0.1', () => resolve());
    });
    const address = chatty.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP port');
    const config = configFor(`smtp://127.0.0.1:${address.port}?starttls=off`);
    const message = { to: 'alice@example.com', subject: 'Hello', text: 'Hi\n' };
    await expect(sendMail(config, message, { timeoutMs: 5000 })).rejects.toThrow(
      /nobody asked for/,
    );
  });

  it('refuses to continue when encryption is required but not offered', async () => {
    const smtp = await fakeSmtp();
    const config = configFor(`smtp://127.0.0.1:${smtp.port}`);
    const message = { to: 'alice@example.com', subject: 'Hello', text: 'Hi\n' };
    await expect(sendMail(config, message, { timeoutMs: 5000 })).rejects.toThrow(
      /does not offer STARTTLS/,
    );
    expect(smtp.commands).toHaveLength(1);
    expect(smtp.commands[0]).toMatch(/^EHLO /);
  });
});
