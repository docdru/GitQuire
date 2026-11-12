import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsSidebarItem } from '@/components/docs-sidebar-item';
import { DocsSidebarSeparator } from '@/components/docs-sidebar-separator';
import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <DocsLayout
      tree={source.pageTree}
      sidebar={{
        components: { Item: DocsSidebarItem, Separator: DocsSidebarSeparator },
      }}
      {...baseOptions({ wordmarkClassName: 'h-7 w-auto text-(--slide-text)' })}
    >
      {children}
    </DocsLayout>
  );
}
