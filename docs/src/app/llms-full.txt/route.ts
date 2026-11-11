import { getLLMText } from '@/lib/get-llm-text';
import { markdownResponse } from '@/lib/markdown-response';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

export async function GET() {
  const pages = source.getPages();
  const scanned = await Promise.all(pages.map((page) => getLLMText(page)));

  return markdownResponse(scanned.join('\n\n'));
}
