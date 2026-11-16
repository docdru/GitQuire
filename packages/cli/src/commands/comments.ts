import type { Dirent } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { convertCommentsToFootnotes } from '@inkeep/open-knowledge-core/gitquire/comment-threads';
import { type Config, resolveContentDir, simpleGit } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'out', 'vendor']);
const PAGE_EXTENSIONS = ['.md', '.mdx'];

export const CONVERT_COMMIT_MESSAGE = 'Convert comments to footnote threads';

async function markdownPagesUnder(root: string): Promise<string[]> {
  const pages: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(path);
      } else if (entry.isFile() && PAGE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        pages.push(path);
      }
    }
  }
  return pages.sort();
}

export interface ConvertResult {
  converted: string[];
  committed: boolean;
}

export async function convertAllPages(
  contentDir: string,
  options: { dryRun: boolean; commit: boolean },
): Promise<ConvertResult> {
  const converted: string[] = [];
  for (const path of await markdownPagesUnder(contentDir)) {
    const before = await readFile(path, 'utf8');
    const after = convertCommentsToFootnotes(before);
    if (after === before) continue;
    converted.push(relative(contentDir, path));
    if (!options.dryRun) await writeFile(path, after);
  }
  if (options.dryRun || !options.commit || converted.length === 0) {
    return { converted, committed: false };
  }
  const git = simpleGit(contentDir);
  if (!(await git.checkIsRepo().catch(() => false))) return { converted, committed: false };
  await git.add(converted);
  await git.commit(CONVERT_COMMIT_MESSAGE, converted);
  return { converted, committed: true };
}

export function commentsCommand(getConfig: () => Config): Command {
  const comments = new Command('comments').description('Work with comment threads in pages');
  comments
    .command('convert')
    .description(
      'Rewrite every page that still holds comments in the old hidden block as footnote threads, in one commit',
    )
    .option('--dry-run', 'List the pages that would change without writing them', false)
    .option('--no-commit', 'Write the pages but leave committing to you or the server')
    .action(async (opts: { dryRun: boolean; commit: boolean }) => {
      const contentDir = resolveContentDir(getConfig(), process.cwd());
      const result = await convertAllPages(contentDir, opts);
      for (const page of result.converted) process.stdout.write(`${page}\n`);
      const count = result.converted.length;
      const noun = count === 1 ? 'page' : 'pages';
      if (opts.dryRun) {
        process.stdout.write(`${count} ${noun} would be converted.\n`);
      } else if (result.committed) {
        process.stdout.write(
          `${count} ${noun} converted in one commit: "${CONVERT_COMMIT_MESSAGE}".\n`,
        );
      } else {
        process.stdout.write(`${count} ${noun} converted.\n`);
      }
    });
  return comments;
}
