import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MentionInbox } from '@/gitquire-comments/MentionInbox';
import type { MentionEmail } from '@/lib/gitquire/mentions-api';
import { MentionEmailSettings } from './MentionEmailSettings';

let email: MentionEmail;
const calls: { method: string; path: string; body: unknown }[] = [];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  calls.length = 0;
  email = { available: true, address: null, pending: null };
  window.location.hash = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input, 'https://wiki.example.com').pathname;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      if (path === '/api/gitquire/mentions') {
        return json({ enabled: true, login: 'alice', unread: 0, mentions: [], email });
      }
      if (path === '/api/gitquire/mentions/email' && method === 'PUT') {
        email = { ...email, pending: (body as { address: string }).address };
        return json(email);
      }
      if (path === '/api/gitquire/mentions/email/confirm') {
        email = { available: true, address: email.pending ?? null, pending: null };
        return json(email);
      }
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('mention email in Settings', () => {
  test('the @ panel only points to Settings when email is not set up', async () => {
    render(<MentionInbox />);
    await userEvent.click(await screen.findByTestId('mention-inbox-toggle'));
    const hint = await screen.findByTestId('mention-email-hint');
    expect(hint.textContent).toContain('Email for mentions is not set up.');
    expect(screen.queryByPlaceholderText('name@example.com')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Set it up in Settings' }));
    expect(window.location.hash).toBe('#settings/notifications');
  });

  test('sets up the address in Settings and the @ panel follows', async () => {
    render(
      <>
        <MentionInbox />
        <MentionEmailSettings />
      </>,
    );
    const field = await screen.findByLabelText('Email me new mentions');
    await userEvent.type(field, 'alice@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    const code = await screen.findByLabelText(
      'We sent a code to alice@example.com. Enter it to turn on email.',
    );
    await userEvent.type(code, 'ABCD-2345');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByLabelText('New mentions are emailed to alice@example.com');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
      'POST /api/gitquire/mentions/email/confirm',
    );

    await userEvent.click(screen.getByTestId('mention-inbox-toggle'));
    await waitFor(() =>
      expect(screen.getByTestId('mention-email-hint').textContent).toContain(
        'New mentions are emailed to alice@example.com.',
      ),
    );
  });

  test('says when the server cannot send email', async () => {
    email = { available: false, address: null, pending: null };
    render(<MentionEmailSettings />);
    expect((await screen.findByTestId('mention-email-unavailable')).textContent).toContain(
      'GITQUIRE_SMTP_URL',
    );
  });
});
