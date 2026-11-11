import { escapeInlineProse, markdownLink } from '@/lib/mdx-serializer';
import { SITE_DESCRIPTION, SITE_NAME } from '@/lib/site';

export interface LlmsTxtLink {
  readonly url: string;
  readonly name: string;
  readonly description?: string;
}

function inline(prose: string, { asLinkLabel = false } = {}): string {
  return escapeInlineProse(prose, { flattenLinks: asLinkLabel });
}

function bullet({ url, name, description }: LlmsTxtLink): string {
  const link = markdownLink(inline(name, { asLinkLabel: true }), url);
  return description ? `- ${link}: ${inline(description)}` : `- ${link}`;
}

export function buildLlmsTxt({ docs }: { docs: readonly LlmsTxtLink[] }): string {
  return [
    `# ${SITE_NAME}`,
    `> ${SITE_DESCRIPTION}`,
    '## Docs',
    docs.map(bullet).join('\n'),
  ].join('\n\n');
}
