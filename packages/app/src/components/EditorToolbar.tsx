// oxlint-disable ok/no-physical-direction-utility -- pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/ok-rules/README.md#no-physical-direction-utility

import { isEditableTextDocFile } from '@gitquire/core/constants/code-languages';
import { isExcalidrawDocFile } from '@gitquire/core/constants/upload';
import type { LintDiagnostic } from '@gitquire/core/markdown/lint';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { AddPropertiesButton } from '@/components/AddPropertiesButton';
import type { EditorModeValue } from '@/editor/use-editor-mode.ts';
import { NO_RESERVED_KEYS, withoutReservedProperties } from '@/lib/reserved-property-keys';
import { EditorBreadcrumb } from './EditorBreadcrumb';
import { EditorModeToggle } from './EditorModeToggle';
import { NotInSidebarIndicator } from './NotInSidebarIndicator';

const NO_FRONTMATTER_PROBLEMS: readonly LintDiagnostic[] = [];

interface EditorToolbarProps {
  activeDocName: string | null;
  activeProvider?: HocuspocusProvider | null;
  isSourceMode: boolean;
  sourceDisabled: boolean;
  onModeChange: (mode: EditorModeValue) => void;
  showAddPropertyButton: boolean;
  onAddProperty: () => void;
  frontmatterProblems?: readonly LintDiagnostic[];
}

export function EditorToolbar({
  activeDocName,
  isSourceMode,
  sourceDisabled,
  onModeChange,
  showAddPropertyButton,
  onAddProperty,
  frontmatterProblems = NO_FRONTMATTER_PROBLEMS,
}: EditorToolbarProps) {
  const stageableProblems = withoutReservedProperties(frontmatterProblems, NO_RESERVED_KEYS);
  const problemMessages = stageableProblems.map((diagnostic) => diagnostic.message);
  const showDocumentAddPropertyButton =
    showAddPropertyButton && (activeDocName === null || !isEditableTextDocFile(activeDocName));
  return (
    <div
      data-testid="editor-toolbar"
      className="pointer-events-none absolute inset-x-0 top-0 z-10 @container/toolbar"
    >
      <div className="editor-content-aligned bg-background py-2">
        <div className="grid grid-cols-3 items-center">
          <div className="pointer-events-auto flex min-w-0 items-center gap-2">
            <EditorBreadcrumb docName={activeDocName} />
            {activeDocName === null ? null : (
              <NotInSidebarIndicator
                entry={{ kind: 'document', docName: activeDocName }}
                className="shrink-0"
              />
            )}
          </div>
          <div className="pointer-events-auto flex justify-center">
            {activeDocName !== null &&
            (isEditableTextDocFile(activeDocName) || isExcalidrawDocFile(activeDocName)) ? null : (
              <EditorModeToggle
                isSourceMode={isSourceMode}
                onModeChange={onModeChange}
                sourceDisabled={sourceDisabled}
              />
            )}
          </div>
        </div>
      </div>
      <div className="pointer-events-auto absolute top-0 right-0 flex min-w-0 max-w-[calc(50%_-_3rem)] items-center justify-end gap-1 py-2 pr-2">
        {showDocumentAddPropertyButton && (
          <AddPropertiesButton
            onAddProperty={onAddProperty}
            problemCount={stageableProblems.length}
            problemMessages={problemMessages}
          />
        )}
      </div>
      <div
        aria-hidden
        className="pointer-events-none h-2 bg-linear-to-b from-background to-transparent"
      />
    </div>
  );
}
