import { buildLlmsTxt, type LlmsTxtLink } from '@/lib/llms-txt';
import { markdownResponse } from '@/lib/markdown-response';
import { absoluteSiteUrl } from '@/lib/site';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

export function GET() {
  const docs: LlmsTxtLink[] = source.getPages().map((page) => ({
    url: absoluteSiteUrl(`${page.url}/`),
    name: page.data.title,
    description: page.data.description || undefined,
  }));

  return markdownResponse(buildLlmsTxt({ docs }));
}
