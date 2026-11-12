import { createRelativeLink } from 'fumadocs-ui/mdx';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { metaDescription, SITE_NAME } from '@/lib/site';
import { source } from '@/lib/source';
import { getMDXComponents } from '@/mdx-components';

export default async function Page(props: PageProps<'/docs/[...slug]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const hideFooter = page.data.footer === false;

  return (
    <DocsPage
      toc={page.data.toc}
      full={page.data.full}
      footer={hideFooter ? { enabled: false } : undefined}
      article={hideFooter ? { className: 'pb-12' } : undefined}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<'/docs/[...slug]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const keywords = page.data.keywords
    ?.split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  const description = metaDescription(page.data.description);

  return {
    title: page.data.title,
    description,
    keywords,
    alternates: {
      canonical: `${page.url}/`,
    },
    openGraph: {
      type: 'article',
      siteName: SITE_NAME,
      title: page.data.title,
      description,
      url: `${page.url}/`,
    },
  };
}
