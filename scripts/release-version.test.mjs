import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  compareReleaseVersions,
  currentVersion,
  imageTags,
  NOTICES_FILE,
  parseReleaseVersion,
  setVersion,
  UNRELEASED_VERSION,
  VERSION_FILES,
} from './release-version.mjs';

const roots = [];

function fixture(version = UNRELEASED_VERSION) {
  const root = mkdtempSync(join(tmpdir(), 'gq-release-version-'));
  roots.push(root);
  for (const file of VERSION_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(
      join(root, file),
      `{\n  "name": "x",\n  "version": "${version}",\n  "dependencies": {\n    "y": { "version": "9.9.9" }\n  }\n}\n`,
    );
  }
  writeFileSync(
    join(root, NOTICES_FILE),
    `- \`@gitquire/app@${version}\` — GPL-3.0-or-later\n- \`@gitquire/core@${version}\` — GPL-3.0-or-later\n- \`left-pad@1.3.0\` — MIT\n`,
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release versions', () => {
  test('accepts plain and pre-release versions and nothing else', () => {
    expect(parseReleaseVersion('0.1.0')).toEqual({
      major: 0,
      minor: 1,
      patch: 0,
      prerelease: null,
    });
    expect(parseReleaseVersion('1.2.3-rc.1')?.prerelease).toBe('rc.1');
    for (const bad of ['v0.1.0', '0.1', '1.2.3.4', '1.2.x', '', '1.2.3-']) {
      expect(parseReleaseVersion(bad)).toBeNull();
    }
  });

  test('orders versions, with a pre-release before its release', () => {
    expect(compareReleaseVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareReleaseVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareReleaseVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareReleaseVersions('1.0.0-rc.10', '1.0.0-rc.9')).toBe(1);
    expect(compareReleaseVersions('1.0.0', '1.0.0')).toBe(0);
  });

  test('a release gets its own image tag and the minor one; a pre-release only its own', () => {
    expect(imageTags('0.3.1')).toEqual(['0.3.1', '0.3']);
    expect(imageTags('0.3.1-rc.2')).toEqual(['0.3.1-rc.2']);
    expect(imageTags(UNRELEASED_VERSION)).toEqual([]);
  });
});

describe('setVersion', () => {
  test('writes the version to every package and to the notices, and nowhere else', () => {
    const root = fixture();
    expect(setVersion('0.1.0', root)).toEqual({ previous: UNRELEASED_VERSION, version: '0.1.0' });
    expect(currentVersion(root)).toBe('0.1.0');
    for (const file of VERSION_FILES) {
      expect(readFileSync(join(root, file), 'utf8')).toContain('"y": { "version": "9.9.9" }');
    }
    const notices = readFileSync(join(root, NOTICES_FILE), 'utf8');
    expect(notices).toContain('`@gitquire/app@0.1.0`');
    expect(notices).toContain('`@gitquire/core@0.1.0`');
    expect(notices).toContain('`left-pad@1.3.0`');
  });

  test('refuses a version that is not newer, or not a release version', () => {
    const root = fixture('0.2.0');
    expect(() => setVersion('0.2.0', root)).toThrow(/not newer/);
    expect(() => setVersion('0.1.9', root)).toThrow(/not newer/);
    expect(() => setVersion('v0.3.0', root)).toThrow(/not a release version/);
    expect(currentVersion(root)).toBe('0.2.0');
  });

  test('reports packages that disagree', () => {
    const root = fixture('0.2.0');
    writeFileSync(join(root, VERSION_FILES[0]), '{\n  "version": "0.1.0"\n}\n');
    expect(() => currentVersion(root)).toThrow(/do not carry one version/);
  });
});

describe('this repository', () => {
  test('all packages carry one version', () => {
    expect(() => currentVersion()).not.toThrow();
  });
});
