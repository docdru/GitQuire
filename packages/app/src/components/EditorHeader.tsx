import type { ReactNode } from 'react';
import { useDocumentContext } from '@/editor/DocumentContext';
import { useSingleFileMode } from '@/lib/single-file-mode';
import { cn } from '@/lib/utils';
import { EditorBreadcrumb } from './EditorBreadcrumb';

interface EditorHeaderProps {
  children?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
}

const TRAILING_WIDTH_CLASS = '@[15rem]/editor-header:[--editor-header-trailing-width:2rem]';

export function EditorHeader({ children, leading, trailing }: EditorHeaderProps) {
  const singleFile = useSingleFileMode();
  const { activeDocName } = useDocumentContext();

  return (
    <header
      data-editor-header=""
      data-dock-handle=""
      className="relative flex h-11 shrink-0 items-center bg-background @container/editor-header"
    >
      <div
        data-editor-header-tabs=""
        className={cn(
          'flex h-full min-w-0 w-[var(--editor-header-tabs-width,100%)] overflow-hidden',
          trailing != null && TRAILING_WIDTH_CLASS,
        )}
      >
        {leading == null ? null : (
          <div
            data-editor-header-leading=""
            className="hidden shrink-0 items-center ps-1 @[15rem]/editor-header:flex"
          >
            {leading}
          </div>
        )}
        {singleFile ? (
          <div className="flex min-w-0 items-center px-3">
            <EditorBreadcrumb docName={activeDocName} includeCurrentPage />
          </div>
        ) : (
          children
        )}
      </div>

      {trailing == null ? null : (
        <div
          data-editor-header-trailing=""
          className="absolute inset-y-0 end-0 z-10 hidden items-center @[15rem]/editor-header:flex"
        >
          {trailing}
        </div>
      )}
    </header>
  );
}
