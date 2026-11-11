import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const docPages = source.getPages().map((page) => ({
    url: `${SITE_URL}${page.url}/`,
    changeFrequency: 'weekly' as const,
    priority: 0.7,
  }));
  return [{ url: `${SITE_URL}/`, changeFrequency: 'weekly', priority: 1.0 }, ...docPages];
}
