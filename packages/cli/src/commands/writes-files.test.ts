import { Command } from 'commander';
import { describe, expect, test } from 'vitest';
import { writesFilesForARunningServer } from './writes-files.ts';

function parsed(argv: string[]): Command {
  let ran: Command | undefined;
  const program = new Command('gitquire').exitOverride();
  const record = (_opts: unknown, command: Command) => {
    ran = command;
  };
  const config = program.command('config');
  config.command('migrate').option('--dry-run').action(record);
  config.command('validate').action(record);
  program.command('lint').option('--fix').action(record);
  program
    .command('embeddings')
    .command('set-url <url>')
    .action((_url, opts, command) => {
      record(opts, command);
    });
  program.parse(['node', 'gitquire', ...argv]);
  if (!ran) throw new Error('no command ran');
  return ran;
}

describe('writesFilesForARunningServer', () => {
  test('names the commands that change files a running server reads', () => {
    expect(writesFilesForARunningServer(parsed(['config', 'migrate']))).toBe(true);
    expect(writesFilesForARunningServer(parsed(['embeddings', 'set-url', 'http://x']))).toBe(true);
    expect(writesFilesForARunningServer(parsed(['lint', '--fix']))).toBe(true);
  });

  test('leaves out read-only runs and dry runs', () => {
    expect(writesFilesForARunningServer(parsed(['config', 'validate']))).toBe(false);
    expect(writesFilesForARunningServer(parsed(['config', 'migrate', '--dry-run']))).toBe(false);
    expect(writesFilesForARunningServer(parsed(['lint']))).toBe(false);
  });
});
