import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parseArgs } from './profile.ts';

describe('parseArgs — launch-mode defaults', () => {
  let originalHeaded: string | undefined;
  beforeEach(() => {
    originalHeaded = process.env.GITQUIRE_PERF_HEADED;
    delete process.env.GITQUIRE_PERF_HEADED;
  });
  afterEach(() => {
    if (originalHeaded === undefined) delete process.env.GITQUIRE_PERF_HEADED;
    else process.env.GITQUIRE_PERF_HEADED = originalHeaded;
  });

  test('default: headed=false (sweeps run headless to dodge focus-loss throttling)', () => {
    const args = parseArgs(['--scenario=foo']);
    expect(args.headed).toBe(false);
  });

  test('explicit --headed overrides the default', () => {
    const args = parseArgs(['--scenario=foo', '--headed']);
    expect(args.headed).toBe(true);
  });

  test('explicit --headless still works (idempotent with default)', () => {
    const args = parseArgs(['--scenario=foo', '--headless']);
    expect(args.headed).toBe(false);
  });

  test('GITQUIRE_PERF_HEADED=1 env var enables headed mode', () => {
    process.env.GITQUIRE_PERF_HEADED = '1';
    const args = parseArgs(['--scenario=foo']);
    expect(args.headed).toBe(true);
  });

  test('GITQUIRE_PERF_HEADED with non-"1" value does NOT enable headed', () => {
    process.env.GITQUIRE_PERF_HEADED = 'true';
    expect(parseArgs(['--scenario=foo']).headed).toBe(false);
    process.env.GITQUIRE_PERF_HEADED = '0';
    expect(parseArgs(['--scenario=foo']).headed).toBe(false);
    process.env.GITQUIRE_PERF_HEADED = '';
    expect(parseArgs(['--scenario=foo']).headed).toBe(false);
  });

  test('explicit --headless overrides GITQUIRE_PERF_HEADED=1', () => {
    process.env.GITQUIRE_PERF_HEADED = '1';
    const args = parseArgs(['--scenario=foo', '--headless']);
    expect(args.headed).toBe(false);
  });

  test('explicit --headed with GITQUIRE_PERF_HEADED unset still works', () => {
    const args = parseArgs(['--scenario=foo', '--headed']);
    expect(args.headed).toBe(true);
  });
});
