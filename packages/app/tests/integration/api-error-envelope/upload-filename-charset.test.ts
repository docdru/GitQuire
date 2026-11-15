import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
const base = () => `http://127.0.0.1:${server.port}`;

const NNBSP = '\u202F';

interface UploadCase {
  id: string;
  uploaded: string;
  expected: string;
  requiredCodePoints: number[];
}

const UPLOAD_CASES: readonly UploadCase[] = [
  {
    id: 'macos-screenshot-nnbsp',
    uploaded: `Screenshot 2026-08-12 at 10.48.44${NNBSP}AM.png`,
    expected: 'Screenshot 2026-08-12 at 10.48.44_AM.png',
    requiredCodePoints: [0x202f],
  },
  {
    id: 'cjk-japanese',
    uploaded: '\u4F1A\u8B70\u30E1\u30E2.png',
    expected: '\u4F1A\u8B70\u30E1\u30E2.png',
    requiredCodePoints: [0x4f1a, 0x8b70, 0x30e1, 0x30e2],
  },
  {
    id: 'hangul',
    uploaded: '\uBB38\uC11C.png',
    expected: '\uBB38\uC11C.png',
    requiredCodePoints: [0xbb38, 0xc11c],
  },
  {
    id: 'cyrillic',
    uploaded: '\u041F\u0440\u043E\u0435\u043A\u0442.png',
    expected: '\u041F\u0440\u043E\u0435\u043A\u0442.png',
    requiredCodePoints: [0x041f, 0x0442],
  },
  {
    id: 'arabic',
    uploaded: '\u0642\u0635\u0629.png',
    expected: '\u0642\u0635\u0629.png',
    requiredCodePoints: [0x0642, 0x0635, 0x0629],
  },
  {
    id: 'emoji-astral',
    uploaded: 'party \u{1F389}.png',
    expected: 'party \u{1F389}.png',
    requiredCodePoints: [0x1f389],
  },
  {
    id: 'latin-precomposed',
    uploaded: 'caf\u00E9.png',
    expected: 'caf\u00E9.png',
    requiredCodePoints: [0x00e9],
  },
  {
    id: 'latin-decomposed',
    uploaded: 'cafe\u0301.png',
    expected: 'cafe\u0301.png',
    requiredCodePoints: [0x0301],
  },
  {
    id: 'plain-ascii',
    uploaded: 'plain-ascii.png',
    expected: 'plain-ascii.png',
    requiredCodePoints: [],
  },
];

function pngFixture(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRElEQrkJggg==',
    'base64',
  );
}

function codePointsOf(s: string): number[] {
  return [...s].map((c) => c.codePointAt(0) as number);
}

function hexPointsOf(s: string): string {
  return codePointsOf(s)
    .map((p) => p.toString(16).toUpperCase().padStart(4, '0'))
    .join(' ');
}

function assertFixtureIntact(id: string, value: string, required: number[]): void {
  const points = codePointsOf(value);
  for (const cp of required) {
    expect(points, `fixture ${id} lost U+${cp.toString(16).toUpperCase()}`).toContain(cp);
  }
  const hasNonAscii = points.some((p) => p > 0x7f);
  expect(hasNonAscii, `fixture ${id} non-ASCII presence`).toBe(required.length > 0);
}

beforeAll(async () => {
  server = await createTestServer();
  for (const c of UPLOAD_CASES) {
    const dir = join(server.contentDir, 'docs', c.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'guide.md'), '# Guide\n');
  }
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('multipart filename charset -- POST /api/upload', () => {
  test('fixture integrity: the uploaded names still carry their non-ASCII code points', () => {
    expect(codePointsOf(NNBSP)).toEqual([0x202f]);
    expect([...Buffer.from(NNBSP, 'utf8')]).toEqual([0xe2, 0x80, 0xaf]);

    for (const c of UPLOAD_CASES) {
      assertFixtureIntact(c.id, c.uploaded, c.requiredCodePoints);
    }
  });

  for (const c of UPLOAD_CASES) {
    test(`${c.id}: the uploaded filename survives the multipart decode`, async () => {
      const form = new FormData();
      form.append('parentDocName', `docs/${c.id}/guide.md`);
      form.append('file', new Blob([pngFixture()]), c.uploaded);

      const res = await fetch(`${base()}/api/upload`, { method: 'POST', body: form });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { src: string; path: string; deduped: boolean };
      expect(body.deduped).toBe(false);
      expect(
        hexPointsOf(body.src),
        `sent U+ ${hexPointsOf(c.uploaded)}\nas string "${c.uploaded}" -> got "${body.src}"`,
      ).toBe(hexPointsOf(c.expected));
      expect(body.src).toBe(c.expected);
      expect(body.path).toBe(`docs/${c.id}/guide.assets/${c.expected}`);

      const entries = readdirSync(join(server.contentDir, 'docs', c.id, 'guide.assets'));
      expect(entries.map((e) => e.normalize('NFC'))).toContain(c.expected.normalize('NFC'));
    });
  }
});
