import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { refuseFrontDoorVolume } from '../index.ts';
import { refuseSingleWikiVolume, startFrontDoor } from './start.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function volume(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gq-volume-'));
  dirs.push(dir);
  return dir;
}

describe('one volume, one mode', () => {
  it('the front door refuses a volume with a single-wiki checkout', () => {
    const dir = volume();
    expect(() => refuseSingleWikiVolume(dir)).not.toThrow();
    mkdirSync(join(dir, '.git'));
    expect(() => refuseSingleWikiVolume(dir)).toThrow(
      /volume of the single-wiki mode \(it has \.git\).*Nothing on it was changed.*new, empty volume/,
    );
  });

  it.each(['.gitquire', '.ok', '.gitquire-moving-in', '.gitquire-moving-back'])(
    'the front door refuses a volume with %s and changes nothing on it',
    (marker) => {
      const dir = volume();
      mkdirSync(join(dir, marker));
      writeFileSync(join(dir, 'index.md'), '# Home\n');
      const before = readdirSync(dir).sort();
      expect(() => refuseSingleWikiVolume(dir)).toThrow(`it has ${marker}`);
      expect(readdirSync(dir).sort()).toEqual(before);
    },
  );

  it('a single wiki refuses a volume of the front door', () => {
    const dir = volume();
    expect(() => refuseFrontDoorVolume(dir)).not.toThrow();
    mkdirSync(join(dir, 'server'));
    writeFileSync(join(dir, 'server', 'wikis.json'), '{}');
    expect(() => refuseFrontDoorVolume(dir)).toThrow(/Start it with GITQUIRE_WIKIS=on/);
  });

  it('a single wiki whose own repository has a top-level server/wikis.json still starts', () => {
    const dir = volume();
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'server'));
    writeFileSync(join(dir, 'server', 'wikis.json'), '{}');
    expect(() => refuseFrontDoorVolume(dir)).not.toThrow();
  });

  it('startFrontDoor stops on a single-wiki volume before it writes anything (O2)', async () => {
    const dir = volume();
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'index.md'), '# Home\n');
    const before = readdirSync(dir).sort();
    const env = {
      GITQUIRE_HOSTS: 'forgejo',
      GITQUIRE_HOST_FORGEJO_URL: 'https://code.example.org',
      GITQUIRE_HOST_FORGEJO_CLIENT_ID: 'id',
      GITQUIRE_HOST_FORGEJO_CLIENT_SECRET: 'secret',
      GITQUIRE_HOST_FORGEJO_TOKEN: 'bot',
      GITQUIRE_HOST_FORGEJO_ALLOWED_OWNERS: 'team',
      GITQUIRE_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
      GITQUIRE_EXTERNAL_URL: 'https://wiki.example.org',
    };
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    await expect(startFrontDoor(dir, env, { log, cli: [] })).rejects.toThrow(
      /volume of the single-wiki mode/,
    );
    expect(readdirSync(dir).sort()).toEqual(before);
  });
});
