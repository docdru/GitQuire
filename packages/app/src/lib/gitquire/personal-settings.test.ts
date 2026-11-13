import { bindConfigDoc } from '@inkeep/open-knowledge-core/config/bind-config-doc';
import { describe, expect, test, vi } from 'vitest';
import { createPersonalSettingsProvider, probePersonalSettings } from './personal-settings';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('probePersonalSettings', () => {
  test('returns the signed-in person and their settings', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ personal: true, login: 'alice', yaml: 'appearance:\n  theme: dark\n' }),
    );
    expect(await probePersonalSettings(fetchFn as unknown as typeof fetch)).toEqual({
      personal: true,
      login: 'alice',
      yaml: 'appearance:\n  theme: dark\n',
    });
  });

  test('falls back to shared settings without sign-in, on errors and on non-JSON answers', async () => {
    const answers: Array<() => Promise<Response>> = [
      async () => jsonResponse({ personal: false }),
      async () => jsonResponse({ error: 'not-found' }, 404),
      async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      async () => {
        throw new TypeError('offline');
      },
    ];
    for (const answer of answers) {
      expect(await probePersonalSettings(answer as unknown as typeof fetch)).toEqual({
        personal: false,
      });
    }
  });
});

describe('createPersonalSettingsProvider', () => {
  test('a config binding reads the loaded settings and saves changes', async () => {
    const saved: string[] = [];
    const provider = createPersonalSettingsProvider({
      saveDelayMs: 0,
      save: async (yaml) => {
        saved.push(yaml);
      },
    });
    const binding = bindConfigDoc(provider, 'user');
    expect(binding.hasSynced()).toBe(false);
    provider.load('appearance:\n  theme: dark\n');
    expect(binding.hasSynced()).toBe(true);
    expect(binding.current().appearance?.theme).toBe('dark');
    expect(saved).toEqual([]);

    const result = binding.patch({ appearance: { theme: 'light' } });
    expect(result.ok).toBe(true);
    await provider.flush();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain('theme: light');

    binding.dispose();
    provider.destroy();
  });

  test('reports a failed save', async () => {
    const failures: unknown[] = [];
    const provider = createPersonalSettingsProvider({
      saveDelayMs: 0,
      save: async () => {
        throw new Error('HTTP 500');
      },
      onSaveFailed: (error) => failures.push(error),
    });
    const binding = bindConfigDoc(provider, 'user');
    provider.load('');
    binding.patch({ appearance: { theme: 'light' } });
    await provider.flush();
    expect(failures).toHaveLength(1);
    binding.dispose();
    provider.destroy();
  });
});
