import { afterEach, describe, expect, test, vi } from 'vitest';

async function loadWithBasePath(basePath: string | undefined) {
  vi.resetModules();
  if (basePath === undefined) vi.stubEnv('NEXT_PUBLIC_BASE_PATH', undefined);
  else vi.stubEnv('NEXT_PUBLIC_BASE_PATH', basePath);
  return import('./base-path.ts');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('withBasePath', () => {
  test('prefixes root-absolute paths with the base path', async () => {
    const { withBasePath } = await loadWithBasePath('/GitQuire');
    expect(withBasePath('/images/skills-studio/skills-dock.png')).toBe(
      '/GitQuire/images/skills-studio/skills-dock.png',
    );
  });

  test('leaves paths that already carry the base path alone', async () => {
    const { withBasePath } = await loadWithBasePath('/GitQuire');
    expect(withBasePath('/GitQuire/images/a.png')).toBe('/GitQuire/images/a.png');
    expect(withBasePath('/GitQuire')).toBe('/GitQuire');
  });

  test('leaves relative, protocol-relative and absolute URLs alone', async () => {
    const { withBasePath } = await loadWithBasePath('/GitQuire');
    expect(withBasePath('./a.png')).toBe('./a.png');
    expect(withBasePath('//cdn.example.com/a.png')).toBe('//cdn.example.com/a.png');
    expect(withBasePath('https://example.com/a.png')).toBe('https://example.com/a.png');
  });

  test('is a no-op without a base path', async () => {
    const { withBasePath } = await loadWithBasePath(undefined);
    expect(withBasePath('/images/a.png')).toBe('/images/a.png');
  });
});
