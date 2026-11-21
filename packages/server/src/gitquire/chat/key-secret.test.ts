import { describe, expect, it } from 'vitest';
import { CHAT_KEY_SECRET_ENV, chatKeySecretFromEnv, deriveChatKeySecret } from './key-secret.ts';

const SESSION = 's'.repeat(40);
const DERIVED = deriveChatKeySecret(SESSION, 'github-5');

describe('the AI chat key secret', () => {
  it('is the session secret with one wiki, and ignores a derived key there', () => {
    expect(chatKeySecretFromEnv({ GITQUIRE_SESSION_SECRET: SESSION })).toBe(SESSION);
    expect(
      chatKeySecretFromEnv({ GITQUIRE_SESSION_SECRET: SESSION, [CHAT_KEY_SECRET_ENV]: DERIVED }),
    ).toBe(SESSION);
    expect(chatKeySecretFromEnv({ [CHAT_KEY_SECRET_ENV]: DERIVED })).toBeUndefined();
    expect(chatKeySecretFromEnv({ GITQUIRE_SESSION_SECRET: 'short' })).toBeUndefined();
  });

  it('is the derived key behind the front door, never the session secret', () => {
    const behind = { GITQUIRE_BEHIND_FRONT_DOOR: 'on' };
    expect(chatKeySecretFromEnv({ ...behind, [CHAT_KEY_SECRET_ENV]: DERIVED })).toBe(DERIVED);
    expect(chatKeySecretFromEnv({ ...behind, GITQUIRE_SESSION_SECRET: SESSION })).toBeUndefined();
  });

  it('differs per wiki and per session secret', () => {
    expect(deriveChatKeySecret(SESSION, 'github-6')).not.toBe(DERIVED);
    expect(deriveChatKeySecret('t'.repeat(40), 'github-5')).not.toBe(DERIVED);
    expect(DERIVED).not.toContain(SESSION);
  });
});
