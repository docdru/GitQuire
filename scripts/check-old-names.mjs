#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const OLD_NAME_PATTERNS = [
  { id: 'inkeep-scope', label: 'the @inkeep/ package scope', re: /@inkeep\//g },
  {
    id: 'open-knowledge',
    label: 'the OpenKnowledge name',
    re: /OpenKnowledge|open-knowledge|openknowledge/gi,
  },
  {
    id: 'ok-command',
    label: 'the ok command',
    re: /(?<![\w./@$-])ok (?:auth|clone|comments|config|diagnose|init|lint|migrate|preview|ps|pull|push|seed|share|start|status|stop|sync)\b/g,
  },
  { id: 'ok-folder', label: 'the .ok data folder', re: /(?<![\w.-])\.ok(?=\/|$|['"`\s)\]])/gm },
  { id: 'ok-env', label: 'an OK_ name', re: /\bOK_[A-Z][A-Z0-9_]*/g },
  { id: 'ok-style-token', label: 'an --ok- style token', re: /--ok-/g },
  { id: 'ok-rules', label: 'the ok-rules lint plugin', re: /ok-rules/g },
];

export const ALWAYS_ALLOWED = [
  'LICENSE',
  'README.md',
  'UPSTREAM-README.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  'THIRD_PARTY_NOTICES.md',
  '.github/SECURITY.md',
  'DEPLOY.md',
  'docs/CHANGELOG.md',
  'pnpm-lock.yaml',
  'scripts/check-old-names.mjs',
  'scripts/check-old-names.test.mjs',
  'scripts/old-names-baseline.json',
  'packages/cli/src/legacy-command-name.ts',
  'packages/cli/src/legacy-command-name.test.ts',
  'packages/cli/src/legacy-env.ts',
  'packages/cli/src/legacy-env.test.ts',
  'packages/server/src/gitquire/legacy-data-folder.ts',
  'packages/server/src/gitquire/legacy-data-folder.test.ts',
];

const BINARY = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|zip|gz|tgz|pdf|mp4|webm|wasm)$/i;

export function countOldNames(text) {
  const counts = {};
  for (const { id, re } of OLD_NAME_PATTERNS) {
    const found = text.match(re)?.length ?? 0;
    if (found > 0) counts[id] = found;
  }
  return counts;
}

export function compareWithBaseline(current, baseline) {
  const grown = [];
  for (const [file, counts] of Object.entries(current)) {
    for (const [id, count] of Object.entries(counts)) {
      const allowed = baseline[file]?.[id] ?? 0;
      if (count > allowed) grown.push({ file, id, count, allowed });
    }
  }
  return grown.sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
}

export function scanTree(root, files) {
  const allowed = new Set(ALWAYS_ALLOWED);
  const current = {};
  for (const file of files) {
    if (allowed.has(file) || BINARY.test(file)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    const counts = countOldNames(text);
    if (Object.keys(counts).length > 0) current[file] = counts;
  }
  return current;
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function main() {
  const root = process.cwd();
  const baselinePath = path.join(root, 'scripts', 'old-names-baseline.json');
  const current = scanTree(root, trackedFiles(root));
  if (process.argv.includes('--update')) {
    const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
    process.stdout.write(`Wrote ${baselinePath} (${Object.keys(sorted).length} files).\n`);
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const grown = compareWithBaseline(current, baseline);
  if (grown.length === 0) {
    process.stdout.write('No new occurrences of the old OpenKnowledge names.\n');
    return;
  }
  const labels = Object.fromEntries(OLD_NAME_PATTERNS.map(({ id, label }) => [id, label]));
  for (const { file, id, count, allowed } of grown) {
    process.stderr.write(`${file}: ${count} × ${labels[id]} (allowed ${allowed})\n`);
  }
  process.stderr.write(
    '\nUse the GitQuire names (gq/gitquire, @gitquire/*, GITQUIRE_*, .gitquire/, GQ_*, --gq-*). If an old name is needed on purpose (compatibility, history), run `node scripts/check-old-names.mjs --update` and explain it in the pull request.\n',
  );
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
