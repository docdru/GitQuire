import { describe, expect, it } from 'vitest';
import { wikisCommand } from './wikis.ts';

describe('gitquire wikis', () => {
  it('offers adopt and unadopt on /data with a dry run and --force', () => {
    const command = wikisCommand();
    expect(command.commands.map((sub) => sub.name())).toEqual(['adopt', 'unadopt']);
    for (const sub of command.commands) {
      expect(sub.options.map((option) => option.long)).toEqual(['--dry-run', '--force']);
      expect(sub.registeredArguments[0]?.defaultValue).toBe('/data');
    }
  });
});
