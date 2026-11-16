import { afterEach, describe, expect, test, vi } from 'vitest';
import { MissingOkConfigError, missingOkConfigMessage } from './missing-ok-config-error.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MissingOkConfigError', () => {
  test('carries the canonical message verbatim for both kinds', () => {
    const a = new MissingOkConfigError('okdir', '/tmp/proj-a');
    const b = new MissingOkConfigError('config', '/tmp/proj-b');
    expect(a.message).toBe(missingOkConfigMessage());
    expect(b.message).toBe(missingOkConfigMessage());
  });

  test('tells a Stable user to run gq init', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'stable');
    expect(new MissingOkConfigError('okdir', '/tmp/proj').message).toBe(
      'GitQuire config not found at .gitquire/config.yml. Run gq init to scaffold OK in this directory.',
    );
  });

  test('tells a Beta user to run gq-beta init', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'beta');
    expect(new MissingOkConfigError('okdir', '/tmp/proj').message).toBe(
      'GitQuire config not found at .gitquire/config.yml. Run gq-beta init to scaffold OK in this directory.',
    );
  });

  test('discriminator + projectDir are queryable as readonly fields', () => {
    const e = new MissingOkConfigError('config', '/tmp/proj');
    expect(e.kind).toBe('config');
    expect(e.projectDir).toBe('/tmp/proj');
    expect(e.name).toBe('MissingOkConfigError');
  });

  test('forwards `cause` to the Error options bag', () => {
    const cause = new Error('underlying');
    const e = new MissingOkConfigError('okdir', '/tmp/proj', { cause });
    expect(e.cause).toBe(cause);
  });
});
