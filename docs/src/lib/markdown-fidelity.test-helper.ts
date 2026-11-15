import type { Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

type FidelityViolationKind =
  | 'jsx-element'
  | 'indented-code'
  | 'base64-attribute'
  | 'source-form-link'
  | 'unparseable';

export interface FidelityViolation {
  readonly kind: FidelityViolationKind;
  readonly message: string;
}

const asMarkdown = unified().use(remarkParse).use(remarkGfm);
const asMdx = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);

const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//;

const SOURCE_EXTENSION = /\.mdx($|[#?])/;

const BASE64_ATTRIBUTE = /([A-Za-z][\w-]*)=(["'])([A-Za-z0-9+/]{64,}={0,2})\2/g;

type Range = readonly [number, number];

export function markdownFidelityViolations(name: string, markdown: string): FidelityViolation[] {
  const violations: FidelityViolation[] = [];
  const report = (
    kind: FidelityViolationKind,
    line: number,
    construct: string,
    fix: string,
  ): void => {
    violations.push({ kind, message: `${name}:${line} — ${construct}. Fix: ${fix}` });
  };

  let tree: Root;
  try {
    tree = asMarkdown.parse(markdown);
  } catch (error) {
    report(
      'unparseable',
      1,
      `the document does not parse as Markdown (${(error as Error).message})`,
      'find the producer that emitted this document and correct what it wrote',
    );
    return violations;
  }

  const literalRegions: Range[] = [];

  visit(tree, (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const line = node.position?.start.line ?? 1;

    if (node.type === 'code' || node.type === 'inlineCode') {
      if (start !== undefined && end !== undefined) literalRegions.push([start, end]);
    } else if (node.type === 'html' && node.value.trimStart().startsWith('<!--')) {
      if (start !== undefined && end !== undefined) literalRegions.push([start, end]);
    } else if (node.type === 'link' && start !== undefined && markdown[start] === '<') {
      if (end !== undefined) literalRegions.push([start, end]);
    }

    if (node.type === 'code') {
      const opener = start === undefined ? '' : markdown[start];
      if (opener !== '`' && opener !== '~') {
        report(
          'indented-code',
          line,
          'a code block reached the four-space column instead of being fenced, so CommonMark reads the prose around it as code',
          'fence the block; if a custom serializer wrote it, that output is emitted verbatim and has to carry its own fence',
        );
      }
    }

    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
      if (!ABSOLUTE_URL.test(node.url)) {
        report(
          'source-form-link',
          line,
          `the link target ${JSON.stringify(node.url)} is relative, so it breaks as soon as the Markdown is read away from its own URL`,
          'absolutise it against the page URL, as the serializer does for every link it rewrites',
        );
      } else if (SOURCE_EXTENSION.test(node.url)) {
        report(
          'source-form-link',
          line,
          `the link target ${JSON.stringify(node.url)} still points at MDX source rather than at a page`,
          'drop the source extension so the target is the URL a reader can open',
        );
      }
    }
  });

  const masked = maskRanges(markdown, literalRegions);

  try {
    visit(asMdx.parse(masked), (node) => {
      if (node.type !== 'mdxJsxFlowElement' && node.type !== 'mdxJsxTextElement') return;
      report(
        'jsx-element',
        node.position?.start.line ?? 1,
        `<${node.name ?? 'fragment'}> survived into the served Markdown as a raw tag`,
        'give the component a serializer disposition that renders what it contributes, or drop it',
      );
    });
  } catch (error) {
    report(
      'unparseable',
      1,
      `the document does not parse as MDX (${(error as Error).message})`,
      'escape the raw markup the producer interpolated; author prose reaches the document as Markdown, not as HTML',
    );
  }

  for (const match of masked.matchAll(BASE64_ATTRIBUTE)) {
    report(
      'base64-attribute',
      lineAt(masked, match.index),
      `the attribute ${match[1]} carries ${match[3].length} bytes of base64 rather than content`,
      'restore what the attribute encodes — a preview fence belongs in the document as a fence',
    );
  }

  return violations;
}

function maskRanges(source: string, ranges: readonly Range[]): string {
  if (ranges.length === 0) return source;
  const chars = source.split('');
  for (const [start, end] of ranges) {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source[i] === '\n') line += 1;
  return line;
}
