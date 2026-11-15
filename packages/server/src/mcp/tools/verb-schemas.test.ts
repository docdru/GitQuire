import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ConfigSchema } from '../../config/schema.ts';
import { SUPPORTED_DOC_EXTENSIONS } from '../../doc-extensions.ts';
import { installPrettyZodErrors } from '../pretty-zod-errors.ts';
import { DocExtensionArg, FrontmatterArg, resolveTemplatePath } from './verb-schemas.ts';
import { register as registerWrite } from './write.ts';

describe('FrontmatterArg — recursive value contract (PRD-6947)', () => {
  test('flat scalar values still parse (regression guard for the pre-PRD-6947 contract)', () => {
    const result = FrontmatterArg.safeParse({
      title: 'Q3 Planning',
      done: true,
      score: 0.95,
      tags: ['planning', 'q3'],
    });
    expect(result.success).toBe(true);
  });

  test('nested-object value at a top-level key parses', () => {
    const result = FrontmatterArg.safeParse({
      metadata: { version: '1.0.0', author: 'Inkeep' },
    });
    expect(result.success).toBe(true);
  });

  test('arbitrarily deep nesting (map in map in map) parses', () => {
    const result = FrontmatterArg.safeParse({
      metadata: { outer: { inner: { leaf: 'deep' } } },
    });
    expect(result.success).toBe(true);
  });

  test('array-of-objects value parses; element objects pass through unchanged (NOT String()-coerced)', () => {
    const input = {
      plugins: [
        { name: 'alpha', version: '1.0' },
        { name: 'beta', version: '2.0' },
      ],
    };
    const result = FrontmatterArg.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
    }
  });

  test('top-level null parses (RFC 7396 delete sentinel preserved)', () => {
    const result = FrontmatterArg.safeParse({ metadata: null });
    expect(result.success).toBe(true);
  });

  test('nested null INSIDE a subtree is rejected (D9: wire stays additive, no path syntax)', () => {
    const result = FrontmatterArg.safeParse({ metadata: { version: null } });
    expect(result.success).toBe(false);
  });

  test('mixed flat + nested keys in one patch parse together', () => {
    const result = FrontmatterArg.safeParse({
      title: 'Skill',
      tags: ['demo'],
      metadata: { version: '1.0.0', author: 'Inkeep' },
    });
    expect(result.success).toBe(true);
  });

  test('description text reflects recursive value contract (no stale "flat mapping" claim)', () => {
    const description = FrontmatterArg.description ?? '';
    expect(description).toContain('nested');
    expect(description).not.toContain('flat key→value');
  });
});

describe('frontmatter key refusal at MCP admission', () => {
  test.each([
    ['top-level', '{"__proto__":0,"keep":1}'],
    ['nested object', '{"key":{"__proto__":0,"keep":1}}'],
    ['literal list', '{"key":[{"__proto__":0}]}'],
    ['nested lists', '{"key":[[{"__proto__":0,"keep":1}]]}'],
  ])('rejects %s records', (_name, raw) => {
    expect(FrontmatterArg.safeParse(JSON.parse(raw)).success).toBe(false);
  });

  test('preserves ordinary values before downstream storage conversion', () => {
    const input = { key: { number: 7, flag: false, list: [0, true, { count: 3 }] } };
    expect(FrontmatterArg.parse(input)).toEqual(input);
  });
});

function countedLeafChain(depth: number, wrap: (child: unknown) => unknown) {
  let inspections = 0;
  const leaf = new Proxy(
    { leaf: 'value' },
    {
      ownKeys(target) {
        inspections += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        inspections += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get(target, key, receiver) {
        inspections += 1;
        return Reflect.get(target, key, receiver);
      },
      has(target, key) {
        inspections += 1;
        return Reflect.has(target, key);
      },
    },
  );
  let root: unknown = leaf;
  for (let level = 0; level < depth; level += 1) root = { child: wrap(root) };
  return { root, inspections: () => inspections };
}

describe('FrontmatterArg validation cost', () => {
  test.each([
    { name: 'nested objects', wrap: (child: unknown) => child },
    { name: 'objects inside lists', wrap: (child: unknown) => [child] },
  ])('inspects the innermost record of $name as often at depth 40 as at depth 4', ({ wrap }) => {
    const leafInspectionsAt = (depth: number) => {
      const chain = countedLeafChain(depth, wrap);
      expect(FrontmatterArg.safeParse(chain.root).success).toBe(true);
      return chain.inspections();
    };
    const shallow = leafInspectionsAt(4);
    expect(shallow).toBeGreaterThan(0);
    expect(leafInspectionsAt(40)).toBe(shallow);
  });
});

describe('frontmatter key refusal in the MCP write argument error', () => {
  let root: string;
  let mcp: McpServer;
  let client: Client;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ok-frontmatter-key-refusal-mcp-'));
    mcp = new McpServer({ name: 'frontmatter-key-refusal', version: '1' });
    installPrettyZodErrors(mcp);
    registerWrite(mcp, {
      config: ConfigSchema.parse({ content: { dir: '.' } }),
      resolveCwd: async () => root,
      serverUrl: 'http://127.0.0.1:9',
    });
    client = new Client({ name: 'frontmatter-key-refusal', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client?.close();
    await mcp?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test.each([
    ['top-level', '{"__proto__":0,"keep":1}', 'document.frontmatter.__proto__'],
    ['nested object', '{"key":{"__proto__":0,"keep":1}}', 'document.frontmatter.key.__proto__'],
    ['literal list', '{"key":[{"__proto__":0}]}', 'document.frontmatter.key[0].__proto__'],
    [
      'nested lists',
      '{"key":[[{"__proto__":0,"keep":1}]]}',
      'document.frontmatter.key[0][0].__proto__',
    ],
  ])('names the %s field and the unsupported key', async (_name, raw, field) => {
    const result = await client.callTool({
      name: 'write',
      arguments: { document: { path: 'note', content: 'Body.', frontmatter: JSON.parse(raw) } },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: expect.any(String) }]);
    const [{ text }] = result.content as [{ type: 'text'; text: string }];
    expect.soft(text).toContain('Unsupported frontmatter key');
    expect.soft(text).toContain(field);
    expect.soft(text).not.toContain('invalid frontmatter value');
    expect.soft(text).not.toContain('Invalid input');
  });
});

describe('DocExtensionArg — explicit on-create file format', () => {
  test('accepts every supported extension', () => {
    for (const ext of SUPPORTED_DOC_EXTENSIONS) {
      expect(DocExtensionArg.safeParse(ext).success).toBe(true);
    }
  });

  test('rejects unsupported extensions', () => {
    for (const bad of ['.markdown', '.txt', 'mdx', '.MDX', '']) {
      expect(DocExtensionArg.safeParse(bad).success).toBe(false);
    }
  });

  test('enum is single-sourced from SUPPORTED_DOC_EXTENSIONS (no drift)', () => {
    expect(DocExtensionArg.options).toEqual([...SUPPORTED_DOC_EXTENSIONS]);
  });

  test('description names .mdx + default and is part of the agent-facing wire contract', () => {
    const description = DocExtensionArg.description ?? '';
    expect(description).toContain('.mdx');
    expect(description).toContain('default');
  });
});

describe('resolveTemplatePath — template name grammar', () => {
  test('accepts a name written in any script', () => {
    expect(resolveTemplatePath('meetings/議事録')).toEqual({
      ok: true,
      folder: 'meetings',
      name: '議事録',
    });
    expect(resolveTemplatePath('notas-reunión')).toEqual({
      ok: true,
      folder: '',
      name: 'notas-reunión',
    });
  });

  test('keeps the spelling the caller wrote', () => {
    expect(resolveTemplatePath('menus/cafe\u{0301}')).toEqual({
      ok: true,
      folder: 'menus',
      name: 'cafe\u{0301}',
    });
  });

  test('rejects dots, spaces and invisible characters in the name', () => {
    for (const path of ['x/a.b', 'x/a b', 'x/a\u200bb']) {
      expect(resolveTemplatePath(path).ok, path).toBe(false);
    }
  });
});
