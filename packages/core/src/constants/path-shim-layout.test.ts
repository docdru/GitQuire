import { describe, expect, test } from 'vitest';
import {
  pathShimBinDir,
  pathShimBlockLabel,
  pathShimFishConfFileName,
  pathShimHomeDirName,
  pathShimMarkerPath,
} from './path-shim-layout.ts';

describe('path shim layout', () => {
  test('Stable keeps its historical names and paths', () => {
    expect(pathShimHomeDirName('stable')).toBe('.gitquire');
    expect(pathShimBinDir('stable', '/Users/a/')).toBe('/Users/a/.gitquire/bin');
    expect(pathShimMarkerPath('stable', '/Users/a')).toBe(
      '/Users/a/Library/Application Support/OpenKnowledge/path-install.json',
    );
    expect(pathShimBlockLabel('stable')).toBe('open-knowledge cli');
    expect(pathShimFishConfFileName('stable')).toBe('open-knowledge.fish');
  });

  test('Beta lives under ~/.gitquire-beta with its own block and fish file', () => {
    expect(pathShimHomeDirName('beta')).toBe('.gitquire-beta');
    expect(pathShimBinDir('beta', '/Users/a')).toBe('/Users/a/.gitquire-beta/bin');
    expect(pathShimMarkerPath('beta', '/Users/a')).toBe(
      '/Users/a/.gitquire-beta/path-install.json',
    );
    expect(pathShimBlockLabel('beta')).toBe('open-knowledge beta cli');
    expect(pathShimFishConfFileName('beta')).toBe('open-knowledge-beta.fish');
  });
});

describe('Stable Linux marker layout', () => {
  test.each([
    [undefined, '/home/a/.config/OpenKnowledge/path-install.json'],
    ['', '/home/a/.config/OpenKnowledge/path-install.json'],
    ['relative', '/home/a/.config/OpenKnowledge/path-install.json'],
    ['../relative', '/home/a/.config/OpenKnowledge/path-install.json'],
    ['/settings', '/settings/OpenKnowledge/path-install.json'],
    ['/settings/', '/settings/OpenKnowledge/path-install.json'],
  ])('uses the Linux config directory for XDG_CONFIG_HOME=%s', (xdg, expected) => {
    expect(pathShimMarkerPath('stable', '/home/a', 'linux', xdg)).toBe(expected);
  });

  test('leaves macOS and isolated channels unchanged', () => {
    expect(pathShimMarkerPath('stable', '/Users/a', 'darwin', '/settings')).toBe(
      '/Users/a/Library/Application Support/OpenKnowledge/path-install.json',
    );
    expect(pathShimMarkerPath('beta', '/home/a', 'linux', '/settings')).toBe(
      '/home/a/.gitquire-beta/path-install.json',
    );
    expect(pathShimMarkerPath('dev', '/home/a', 'linux', '/settings')).toBe(
      '/home/a/.gitquire-dev/path-install.json',
    );
  });
});
