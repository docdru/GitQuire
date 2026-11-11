import type { Metadata } from 'next';
import { DM_Sans, Inter, JetBrains_Mono } from 'next/font/google';
import type { WebSite, WithContext } from 'schema-dts';
import { JsonLd } from '@/components/seo/json-ld';
import {
  metaDescription,
  SITE_DESCRIPTION,
  SITE_HEADLINE,
  SITE_NAME,
  SITE_URL,
} from '@/lib/site';
import './global.css';
import { Provider } from './provider';

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const siteLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: SITE_NAME,
  alternateName: 'GitQuire Docs',
  url: SITE_URL,
  description: SITE_DESCRIPTION,
} satisfies WithContext<WebSite>;

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const SITE_META_DESCRIPTION = metaDescription(SITE_DESCRIPTION);

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — ${SITE_HEADLINE}`,
    template: '%s · GitQuire',
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  icons: {
    icon: `${BASE_PATH}/gitquire.svg`,
  },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: `${SITE_NAME} — ${SITE_HEADLINE}`,
    description: SITE_META_DESCRIPTION,
    url: SITE_URL,
    locale: 'en_US',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${dmSans.variable} ${inter.variable} ${jetbrainsMono.variable} antialiased scrollbar-thin scrollbar-track-transparent scrollbar-thumb-fd-muted-foreground/30 dark:scrollbar-thumb-fd-muted-foreground/50`}
    >
      <body>
        <JsonLd json={[siteLd]} />
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
