import { parseTemplateContentDocName } from '@gitquire/core/constants/cc1';
import { MoreHorizontalIcon } from 'lucide-react';
import { Fragment } from 'react';
import { UserText } from '@/components/UserText';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { tabParts } from '@/editor/editor-tabs';
import { cn } from '@/lib/utils';

interface EditorBreadcrumbProps {
  docName: string | null;
  className?: string;
}

const LEADING_VISIBLE = 1;
const TRAILING_VISIBLE = 2;
const COLLAPSE_THRESHOLD = 4;

type BreadcrumbNode =
  | { kind: 'segment'; value: string; key: string }
  | { kind: 'ellipsis'; hidden: readonly string[] };

export function EditorBreadcrumb({ docName, className }: EditorBreadcrumbProps) {
  if (!docName) return null;
  const template = parseTemplateContentDocName(docName);
  const folderSegments = template
    ? template.folder.split('/').filter(Boolean)
    : tabParts(docName, '').prefix.replace(/\/$/, '').split('/').filter(Boolean);
  const segments = folderSegments;
  if (segments.length === 0) return null;

  const segmentNode = (value: string, absoluteIndex: number): BreadcrumbNode => ({
    kind: 'segment',
    value,
    key: segments.slice(0, absoluteIndex + 1).join('/'),
  });

  const collapsed = segments.length > COLLAPSE_THRESHOLD;
  const nodes: BreadcrumbNode[] = collapsed
    ? [
        ...segments.slice(0, LEADING_VISIBLE).map((value, i) => segmentNode(value, i)),
        { kind: 'ellipsis', hidden: segments.slice(LEADING_VISIBLE, -TRAILING_VISIBLE) },
        ...segments
          .slice(-TRAILING_VISIBLE)
          .map((value, i) => segmentNode(value, segments.length - TRAILING_VISIBLE + i)),
      ]
    : segments.map((value, i) => segmentNode(value, i));

  return (
    <Breadcrumb className={cn('flex min-w-0 items-center', className)}>
      <BreadcrumbList className="min-w-0 flex-nowrap gap-1 overflow-hidden text-muted-foreground/70 text-xs">
        {nodes.map((node, index) => {
          const key = node.kind === 'segment' ? node.key : 'ellipsis';
          return (
            <Fragment key={key}>
              {index > 0 && (
                <BreadcrumbSeparator className="shrink-0 text-muted-foreground/70 [&>svg]:size-3" />
              )}
              {node.kind === 'ellipsis' ? (
                <BreadcrumbItem className="shrink-0">
                  <span
                    aria-hidden="true"
                    title={node.hidden.join(' / ')}
                    className="flex size-4 items-center justify-center text-muted-foreground/70"
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </span>
                  <span className="sr-only">
                    <UserText>{node.hidden.join(' / ')}</UserText>
                  </span>
                </BreadcrumbItem>
              ) : (
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage
                    current={false}
                    className="min-w-0 truncate font-normal text-muted-foreground/70"
                    title={node.value}
                  >
                    <UserText>{node.value}</UserText>
                  </BreadcrumbPage>
                </BreadcrumbItem>
              )}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
