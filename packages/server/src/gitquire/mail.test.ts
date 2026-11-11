import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMimeMessage,
  encodeHeaderText,
  isEmailAddress,
  type MailConfig,
  resolveMailConfig,
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
      },
    });
    expect(configFor('smtps://mail.example.com')).toMatchObject({ port: 465, implicitTls: true });
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
    const subject = 'Zoë mentioned you in Übersicht';
    const encoded = encodeHeaderText(subject);
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const payload = encoded.slice('=?UTF-8?B?'.length, -2);
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe(subject);
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
    await expect(sendMail(config, message, { timeoutMs: 5000 })).rejects.toThrow(
      /refused the recipient/,
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
