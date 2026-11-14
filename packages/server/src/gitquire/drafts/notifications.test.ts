import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { encodeProxiedUser, PROXIED_PRINCIPAL_HEADER, proxiedUser } from '../access-gate.ts';
import { chatMessage, chatPayload } from '../chat-notifier.ts';
import { INTERNAL_REQUEST_HEADER, internalRequestHeaders } from '../internal-request.ts';
import { mentionMail } from '../mention-mailer.ts';
import type { Mention } from '../mentions.ts';

const request: Mention = {
  id: 'draft:plan:r1',
  path: '',
  docName: 'Q4 plan',
  threadId: '',
  commentId: 'r1',
  author: { id: 'github-42', login: 'alice', name: 'Alice A' },
  at: '2026-11-13T10:00:00Z',
  body: 'Please check the numbers',
  quote: 'Q4 plan',
  resolved: false,
  logins: ['bob'],
  draft: { slug: 'plan', title: 'Q4 plan' },
};

describe('review requests', () => {
  it('are mailed with a link that opens the draft', () => {
    const mail = mentionMail(
      { externalUrl: 'https://wiki.example.com' },
      'bob@example.com',
      request,
    );
    expect(mail.subject).toBe('Alice A asked you to review Q4 plan');
    expect(mail.text).toContain('Please check the numbers');
    expect(mail.text).toContain('Open the draft: https://wiki.example.com/?draft=plan');
  });

  it('are posted to chat as review requests', () => {
    const message = chatMessage({ externalUrl: 'https://wiki.example.com' }, request);
    expect(message).toMatchObject({ review: true, link: 'https://wiki.example.com/?draft=plan' });
    expect(chatPayload('slack', message)).toEqual({
      text: 'Alice A asked @bob to review <https://wiki.example.com/?draft=plan|Q4 plan>\n> Please check the numbers',
    });
    expect(chatPayload('generic', message)).toMatchObject({ event: 'review-request' });
  });
});

describe('agent requests forwarded to a draft', () => {
  const user = { id: 42, login: 'alice', name: 'Alice A', avatarUrl: '' };

  function req(headers: Record<string, string>): IncomingMessage {
    return { headers } as unknown as IncomingMessage;
  }

  it('carry the person only together with the internal secret', () => {
    const principal = { [PROXIED_PRINCIPAL_HEADER]: encodeProxiedUser(user) };
    expect(proxiedUser(req({ ...principal, ...internalRequestHeaders() }))).toEqual(user);
    expect(proxiedUser(req(principal))).toBeUndefined();
    expect(proxiedUser(req({ ...principal, [INTERNAL_REQUEST_HEADER]: 'guess' }))).toBeUndefined();
    expect(
      proxiedUser(req({ [PROXIED_PRINCIPAL_HEADER]: 'not-json', ...internalRequestHeaders() })),
    ).toBeUndefined();
  });

  it('keep the repository admin flag', () => {
    const admin = { ...user, repoAdmin: true };
    const principal = { [PROXIED_PRINCIPAL_HEADER]: encodeProxiedUser(admin) };
    expect(proxiedUser(req({ ...principal, ...internalRequestHeaders() }))).toEqual(admin);
  });
});
