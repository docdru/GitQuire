import Link from 'next/link';
import type { ReactNode } from 'react';
import type { SerializerApi } from '@/lib/mdx-serializer';

const CONNECTING_AGENTS_HREF = '/docs/remote-control/connecting-agents';

interface McpInstallMarkdownApi extends Pick<SerializerApi, 'url'> {
  link(label: string, url: string): string;
}

export function mcpInstallMarkdown(editor: string, api: McpInstallMarkdownApi): string {
  return [
    `GitQuire runs on a server, so ${editor} connects to it as a remote MCP server: your wiki's address with \`/mcp\` at the end, such as \`https://wiki.example.com/mcp\`. See ${api.link('Connecting agents', api.url(CONNECTING_AGENTS_HREF))} for the setup.`,
    '',
    `If you also run the \`ok\` CLI on your own computer, \`ok init\` registers a local MCP server with ${editor} and the other editors it detects.`,
  ].join('\n');
}

export function McpInstall({ editor, children }: { editor: string; children?: ReactNode }) {
  return (
    <>
      <p>
        GitQuire runs on a server, so {editor} connects to it as a remote MCP server: your wiki's
        address with <code>/mcp</code> at the end, such as{' '}
        <code>https://wiki.example.com/mcp</code>. See{' '}
        <Link href={CONNECTING_AGENTS_HREF}>Connecting agents</Link> for the setup.
      </p>
      <p>
        If you also run the <code>ok</code> CLI on your own computer, <code>ok init</code> registers
        a local MCP server with {editor} and the other editors it detects.
      </p>
      {children}
    </>
  );
}
