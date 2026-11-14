import type { ReactNode } from 'react';
import { hashFromDocName } from '@/lib/doc-hash';

type Block =
  | { kind: 'code'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'paragraph'; text: string };

const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const NUMBER_RE = /^\s*\d+[.)]\s+(.*)$/;
const HEADING_RE = /^(#{1,4})\s+(.*)$/;

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    if (line.trimStart().startsWith('```')) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] as string).trimStart().startsWith('```')) {
        body.push(lines[index] as string);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] as string).length,
        text: heading[2] as string,
      });
      index += 1;
      continue;
    }
    const ordered = NUMBER_RE.test(line);
    if (ordered || BULLET_RE.test(line)) {
      const pattern = ordered ? NUMBER_RE : BULLET_RE;
      const items: string[] = [];
      while (index < lines.length) {
        const match = pattern.exec(lines[index] as string);
        if (match !== null) {
          items.push(match[1] as string);
        } else if (/^\s{2,}\S/.test(lines[index] as string) && items.length > 0) {
          items[items.length - 1] += ` ${(lines[index] as string).trim()}`;
        } else {
          break;
        }
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (index < lines.length && (lines[index] as string).startsWith('>')) {
        body.push((lines[index] as string).replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }
    const body: string[] = [];
    while (
      index < lines.length &&
      (lines[index] as string).trim() !== '' &&
      !(lines[index] as string).trimStart().startsWith('```') &&
      !HEADING_RE.test(lines[index] as string) &&
      !BULLET_RE.test(lines[index] as string) &&
      !NUMBER_RE.test(lines[index] as string)
    ) {
      body.push(lines[index] as string);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: body.join('\n') });
  }
  return blocks;
}

const INLINE_RE =
  /(\[\[([^\]|]+)(?:\|([^\]]+))?\]\])|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*([^*\s][^*]*)\*)|(_([^_\s][^_]*)_)/g;

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let count = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const key = `${keyPrefix}-${count++}`;
    if (match[1] !== undefined) {
      const target = (match[2] as string).trim().replace(/\.mdx?$/i, '');
      out.push(
        <a
          key={key}
          href={hashFromDocName(target)}
          className="text-primary underline-offset-2 hover:underline"
        >
          {(match[3] ?? match[2] ?? '').trim()}
        </a>,
      );
    } else if (match[4] !== undefined) {
      out.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {match[5]}
        </code>,
      );
    } else if (match[6] !== undefined) {
      out.push(<strong key={key}>{renderInline(match[7] as string, key)}</strong>);
    } else if (match[8] !== undefined) {
      out.push(
        <a
          key={key}
          href={match[10]}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline-offset-2 hover:underline"
        >
          {match[9]}
        </a>,
      );
    } else {
      out.push(<em key={key}>{match[12] ?? match[14]}</em>);
    }
    last = start + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(text: string, key: string): ReactNode[] {
  return text.split('\n').flatMap((line, index) => {
    const parts = renderInline(line, `${key}-${index}`);
    const breakKey = `${key}-br-${index}`;
    return index === 0 ? parts : [<br key={breakKey} />, ...parts];
  });
}

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 break-words text-sm leading-relaxed">
      {parseBlocks(text).map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'code':
            return (
              <pre key={key} className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
                {block.text}
              </pre>
            );
          case 'heading':
            return (
              <p key={key} className="font-semibold">
                {renderInline(block.text, key)}
              </p>
            );
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag key={key} className={block.ordered ? 'list-decimal ps-5' : 'list-disc ps-5'}>
                {block.items.map((item, itemIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity beyond their position in this reply
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote key={key} className="border-s-2 ps-3 text-muted-foreground">
                {withBreaks(block.text, key)}
              </blockquote>
            );
          default:
            return <p key={key}>{withBreaks(block.text, key)}</p>;
        }
      })}
    </div>
  );
}

export function ChatPlainText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap break-words text-sm">{text}</p>;
}
