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

function state(next: Partial<MentionEmail>): MentionEmail {
  return {
    available: true,
    address: null,
    pending: null,
    use: null,
    account: { address: 'alice@example.org', why: null },
    other: null,
    stopped: null,
    ...next,
  };
}

beforeEach(() => {
  calls.length = 0;
  email = state({});
  window.location.hash = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input, 'https://wiki.example.com').pathname;
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ method, path, body });
      if (path === '/api/gitquire/mentions') {
        return json({ enabled: true, login: 'alice', unread: 0, mentions: [] });
      }
      if (path === '/api/gitquire/mentions/email' && method === 'GET') return json(email);
      if (path === '/api/gitquire/mentions/email' && method === 'PUT') {
        if (body.use === 'account') {
          email = { ...email, use: 'account', address: email.account?.address ?? null };
        } else if (body.use === null || body.address === null) {
          email = { ...email, use: null, address: null };
        } else if (typeof body.address === 'string') {
          email = { ...email, pending: body.address };
        }
        return json(email);
      }
      if (path === '/api/gitquire/mentions/email/confirm') {
        email = {
          ...email,
          use: 'other',
          other: email.pending ?? null,
          address: email.pending ?? null,
          pending: null,
        };
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
  test('the @ panel only points to Settings when email is off', async () => {
    render(<MentionInbox />);
    await userEvent.click(await screen.findByTestId('mention-inbox-toggle'));
    const hint = await screen.findByTestId('mention-email-hint');
    expect(hint.textContent).toContain('Email for mentions is not set up.');
    await userEvent.click(screen.getByRole('button', { name: 'Set it up in Settings' }));
    expect(window.location.hash).toBe('#settings/notifications');
  });

  test('offers the account address as one switch, off until chosen, without a code', async () => {
    render(
      <>
        <MentionInbox />
        <MentionEmailSettings />
      </>,
    );
    const toggle = await screen.findByRole('switch', {
      name: 'Email me mentions at alice@example.org',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(calls.filter((call) => call.method !== 'GET').map((call) => call.body)).toEqual([
      { use: 'account' },
    ]);
    await userEvent.click(screen.getByTestId('mention-inbox-toggle'));
    await waitFor(() =>
      expect(screen.getByTestId('mention-email-hint').textContent).toContain(
        'New mentions are emailed to alice@example.org.',
      ),
    );
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(calls.at(-1)?.body).toEqual({ use: null });
  });

  test('says why there is no account address and keeps another address with a code', async () => {
    email = state({ account: { address: null, why: 'refused' } });
    render(<MentionEmailSettings />);
    expect((await screen.findByTestId('mention-email-account')).textContent).toContain(
      'does not let GitQuire read',
    );
    expect(screen.queryByRole('switch')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Use another address' }));
    await userEvent.type(
      screen.getByLabelText('Email me new mentions at another address'),
      'alice@example.com',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    const code = await screen.findByLabelText(
      'We sent a code to alice@example.com. Enter it to turn on email.',
    );
    await userEvent.type(code, 'ABCD-2345');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByLabelText('New mentions are emailed to alice@example.com');
  });

  test('says when mail stopped because the account address is gone', async () => {
    email = state({
      use: 'account',
      account: { address: null, why: 'none' },
      stopped: 'account-gone',
    });
    render(<MentionEmailSettings />);
    const account = await screen.findByTestId('mention-email-account');
    expect(account.textContent).toContain('Mention email is stopped.');
    expect(account.textContent).toContain('no verified address');
  });

  test('says when the server cannot send email', async () => {
    email = state({ available: false });
    render(<MentionEmailSettings />);
    expect((await screen.findByTestId('mention-email-unavailable')).textContent).toContain(
      'GITQUIRE_SMTP_URL',
    );
  });

  test('asks to sign in when signed out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'sign-in-required' }, 401)),
    );
    render(<MentionEmailSettings />);
    expect(await screen.findByText('Sign in to get mentions by email.')).toBeTruthy();
  });
});
