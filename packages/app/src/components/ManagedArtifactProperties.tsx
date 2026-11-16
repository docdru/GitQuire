// oxlint-disable ok/no-raw-error-toast -- pre-rule backlog: toasts here show raw error text; delete this line once the file maps each failure to written copy. See https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/ok-rules/README.md#no-raw-error-toast

import { parseTemplateContentDocName, templateContentDocName } from '@gitquire/core/constants/cc1';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { TemplateProperties } from '@/components/TemplateProperties';
import { useDocumentContext } from '@/editor/DocumentContext';
import { docNameForTabId } from '@/editor/editor-tabs';
import { hashFromDocName, replaceHashWithoutNavigation } from '@/lib/doc-hash';
import { moveTemplate } from '@/lib/folder-config-api';

export function ManagedArtifactProperties({
  docName,
  provider,
}: {
  docName: string;
  provider: HocuspocusProvider;
}) {
  const parsedTemplate = parseTemplateContentDocName(docName);
  if (parsedTemplate) {
    return (
      <TemplatePropertiesPanel
        provider={provider}
        docName={docName}
        folder={parsedTemplate.folder}
        name={parsedTemplate.name}
      />
    );
  }
  return null;
}

export function useManagedArtifactRetarget(): (
  fromDocName: string,
  toDocName: string,
  opts?: {
    sourceWasActive?: boolean;
  },
) => void {
  const { openTarget, closeDocument, activeDocName, openTabs } = useDocumentContext();
  return (fromDocName, toDocName, opts) => {
    if (fromDocName === toDocName) return;
    const dest = { kind: 'doc', target: toDocName, docName: toDocName } as const;
    if (activeDocName === fromDocName || opts?.sourceWasActive === true) {
      openTarget(dest, { tabBehavior: 'replace-active', disposition: 'preview' });
      replaceHashWithoutNavigation(hashFromDocName(toDocName), 'preview');
    } else if (openTabs.some((id) => docNameForTabId(id) === fromDocName)) {
      openTarget(dest);
      closeDocument(fromDocName);
    }
  };
}

function TemplatePropertiesPanel({
  provider,
  docName,
  folder,
  name,
}: {
  provider: HocuspocusProvider;
  docName: string;
  folder: string;
  name: string;
}) {
  const { t } = useLingui();
  const retarget = useManagedArtifactRetarget();
  const [renameError, setRenameError] = useState<string | null>(null);

  async function handleRename(next: string) {
    setRenameError(null);
    const result = await moveTemplate({
      fromFolder: folder,
      fromName: name,
      toFolder: folder,
      toName: next,
    });
    if (!result.ok) {
      setRenameError(result.error);
      toast.error(t`Couldn't rename template: ${result.error}`);
      return;
    }
    toast.success(t`Template renamed`);
    retarget(docName, templateContentDocName(folder, next));
  }

  return (
    <TemplateProperties
      provider={provider}
      name={name}
      folder={folder}
      onRename={handleRename}
      nameError={renameError}
    />
  );
}
