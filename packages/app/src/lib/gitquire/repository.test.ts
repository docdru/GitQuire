import { describe, expect, test } from 'vitest';
import { parseRepository } from './repository';

describe('parseRepository', () => {
  test('reads the repository the server reports', () => {
    expect(
      parseRepository({
        repository: { owner: 'acme', name: 'team-wiki', url: 'https://github.com/acme/team-wiki' },
      }),
    ).toEqual({ owner: 'acme', name: 'team-wiki', url: 'https://github.com/acme/team-wiki' });
  });

  test('returns null without a usable repository', () => {
    expect(parseRepository(null)).toBeNull();
    expect(parseRepository({ repository: null })).toBeNull();
    expect(parseRepository({ repository: { owner: 'acme', name: 'wiki' } })).toBeNull();
    expect(
      parseRepository({ repository: { owner: 'acme', name: 'wiki', url: 'javascript:alert(1)' } }),
    ).toBeNull();
  });
});
