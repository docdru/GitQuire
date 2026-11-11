import { fileURLToPath } from 'node:url';
import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const basePath = process.env.DOCS_BASE_PATH ?? '';

const nextConfig: NextConfig = {
  output: 'export',
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  reactStrictMode: true,
  reactCompiler: {
    panicThreshold: 'all_errors',
  },
  turbopack: {
    root: fileURLToPath(new URL('..', import.meta.url)),
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
