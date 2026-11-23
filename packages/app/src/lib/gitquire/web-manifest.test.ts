import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

const publicDir = new URL('../../../public/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', publicDir), 'utf8')) as {
  id?: string;
  start_url: string;
  scope?: string;
  display: string;
  icons: ManifestIcon[];
};

function png(src: string): { width: number; height: number; opaque: boolean } {
  const bytes = readFileSync(new URL(src.replace(/^\//, ''), publicDir));
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  const colorType = bytes[25];
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    opaque: colorType === 0 || colorType === 2,
  };
}

const withPurpose = (purpose: string) =>
  manifest.icons.filter((icon) => (icon.purpose ?? 'any').split(' ').includes(purpose));

describe('home-screen icons', () => {
  it('lists only PNG icons, which every Android launcher can use', () => {
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) expect(icon.type).toBe('image/png');
  });

  it('has regular icons at 192 and 512 pixels', () => {
    expect(withPurpose('any').map((icon) => icon.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    );
  });

  it('has full-bleed maskable icons for adaptive Android launchers', () => {
    const maskable = withPurpose('maskable');
    expect(maskable.map((icon) => icon.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    );
    for (const icon of maskable) expect(png(icon.src).opaque).toBe(true);
  });

  it('points at files whose size matches the manifest', () => {
    for (const icon of manifest.icons) {
      const { width, height } = png(icon.src);
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });

  it('keeps the app id of a server at the root and opens standalone', () => {
    const atRoot = 'https://wiki.example/manifest.webmanifest';
    expect(manifest.id).toBeUndefined();
    expect(new URL(manifest.start_url, atRoot).href).toBe('https://wiki.example/');
    expect(new URL(manifest.scope ?? '', atRoot).href).toBe('https://wiki.example/');
    expect(manifest.display).toBe('standalone');
  });

  it('stays inside the wiki when it is served under a prefix', () => {
    const underPrefix = 'https://wiki.example/w/team/wiki/manifest.webmanifest';
    expect(new URL(manifest.start_url, underPrefix).href).toBe('https://wiki.example/w/team/wiki/');
    expect(new URL(manifest.scope ?? '', underPrefix).href).toBe(
      'https://wiki.example/w/team/wiki/',
    );
    for (const icon of manifest.icons) {
      expect(new URL(icon.src, underPrefix).pathname.startsWith('/w/team/wiki/icons/')).toBe(true);
    }
  });

  it('gives iPhones a full-bleed 180 pixel icon', () => {
    expect(png('/icons/gitquire-180.png')).toEqual({ width: 180, height: 180, opaque: true });
  });
});
