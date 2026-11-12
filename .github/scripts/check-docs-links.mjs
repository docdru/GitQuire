#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ATTRIBUTE = /\s(?:href|src)="([^"]*)"/g;

export function listHtmlFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listHtmlFiles(full));
    else if (entry.name.endsWith('.html')) files.push(full);
  }
  return files;
}

export function extractTargets(html) {
  return [...html.matchAll(ATTRIBUTE)].map((match) => match[1].replaceAll('&amp;', '&'));
}

function isLocal(target) {
  return target.startsWith('/') && !target.startsWith('//');
}

function existsInOut(outDir, relative) {
  const candidate = path.join(outDir, relative);
  if (relative === '' || relative.endsWith('/')) return existsSync(path.join(candidate, 'index.html'));
  if (existsSync(candidate) && statSync(candidate).isFile()) return true;
  return existsSync(path.join(candidate, 'index.html')) || existsSync(`${candidate}.html`);
}

export function checkTarget(outDir, basePath, target) {
  if (!isLocal(target)) return null;
  const clean = decodeURI(target.split('#')[0].split('?')[0]);
  if (clean === '') return null;
  if (basePath && clean !== basePath && !clean.startsWith(`${basePath}/`)) {
    return 'missing the base path';
  }
  const relative = clean.slice(basePath.length).replace(/^\//, '');
  return existsInOut(outDir, relative) ? null : 'no such file in the build';
}

export function findBrokenLinks(outDir, basePath) {
  const broken = new Map();
  for (const file of listHtmlFiles(outDir)) {
    const page = `/${path.relative(outDir, file).split(path.sep).join('/')}`;
    for (const target of extractTargets(readFileSync(file, 'utf8'))) {
      const problem = checkTarget(outDir, basePath, target);
      if (!problem) continue;
      const key = `${target} (${problem})`;
      if (!broken.has(key)) broken.set(key, []);
      broken.get(key).push(page);
    }
  }
  return broken;
}

function main() {
  const [outDir = 'docs/out', basePath = ''] = process.argv.slice(2);
  const broken = findBrokenLinks(path.resolve(outDir), basePath.replace(/\/$/, ''));
  if (broken.size === 0) {
    console.log(`No broken internal links in ${outDir}.`);
    return;
  }
  for (const [key, pages] of broken) {
    const shown = pages.slice(0, 3).join(', ');
    const more = pages.length > 3 ? ` and ${pages.length - 3} more` : '';
    console.error(`::error::Broken link ${key} on ${shown}${more}`);
  }
  console.error(`${broken.size} broken internal link target(s).`);
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
