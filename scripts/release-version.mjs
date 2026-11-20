#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const UNRELEASED_VERSION = '0.0.0-unknown';
export const VERSION_FILES = [
  'packages/app/package.json',
  'packages/cli/package.json',
  'packages/core/package.json',
  'packages/server/package.json',
  'docs/package.json',
];
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md';

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;
const VERSION_LINE = /^( {2}"version": ")([^"]*)(",?)$/m;
const NOTICES_WORKSPACE_ENTRY = /(`@gitquire\/[a-z-]+@)[^`]+(`)/g;

export function parseReleaseVersion(version) {
  const match = RELEASE_VERSION.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[i]);
    const rightNumeric = /^\d+$/.test(right[i]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left[i]) - Number(right[i]);
      if (difference !== 0) return Math.sign(difference);
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  return 0;
}

export function compareReleaseVersions(a, b) {
  const left = parseReleaseVersion(a);
  const right = parseReleaseVersion(b);
  if (!left || !right) throw new Error(`Cannot compare "${a}" with "${b}".`);
  for (const part of ['major', 'minor', 'patch']) {
    if (left[part] !== right[part]) return Math.sign(left[part] - right[part]);
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function readVersions(root = REPO_ROOT) {
  return VERSION_FILES.map((file) => {
    const match = VERSION_LINE.exec(readFileSync(join(root, file), 'utf8'));
    if (!match) throw new Error(`${file} has no top-level "version" line.`);
    return { file, version: match[2] };
  });
}

export function currentVersion(root = REPO_ROOT) {
  const versions = readVersions(root);
  const distinct = [...new Set(versions.map((entry) => entry.version))];
  if (distinct.length !== 1) {
    const listing = versions.map((entry) => `  ${entry.file}: ${entry.version}`).join('\n');
    throw new Error(`The packages do not carry one version:\n${listing}`);
  }
  return distinct[0];
}

export function imageTags(version) {
  if (version === UNRELEASED_VERSION) return [];
  const parsed = parseReleaseVersion(version);
  if (!parsed) throw new Error(`"${version}" is not a release version.`);
  if (parsed.prerelease !== null) return [version];
  return [version, `${parsed.major}.${parsed.minor}`];
}

export function setVersion(version, root = REPO_ROOT) {
  if (!parseReleaseVersion(version)) {
    throw new Error(`"${version}" is not a release version. Use the form 1.2.3 or 1.2.3-rc.1.`);
  }
  const previous = currentVersion(root);
  if (previous !== UNRELEASED_VERSION && compareReleaseVersions(version, previous) <= 0) {
    throw new Error(`${version} is not newer than the current version ${previous}.`);
  }
  for (const file of VERSION_FILES) {
    const path = join(root, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(VERSION_LINE, `$1${version}$3`));
  }
  const noticesPath = join(root, NOTICES_FILE);
  writeFileSync(
    noticesPath,
    readFileSync(noticesPath, 'utf8').replace(NOTICES_WORKSPACE_ENTRY, `$1${version}$2`),
  );
  return { previous, version };
}

function main(argv) {
  const [argument] = argv;
  if (argument === '--print') {
    process.stdout.write(`${currentVersion()}\n`);
    return 0;
  }
  if (argument === '--image-tags') {
    process.stdout.write(`${imageTags(currentVersion()).join(' ')}\n`);
    return 0;
  }
  if (argument === undefined || argument.startsWith('-')) {
    process.stderr.write(
      'Usage: node scripts/release-version.mjs <version> | --print | --image-tags\n',
    );
    return 2;
  }
  const { previous, version } = setVersion(argument);
  process.stdout.write(
    `Version ${previous} -> ${version}. Commit the change as "Release ${version}" and open a pull request.\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
