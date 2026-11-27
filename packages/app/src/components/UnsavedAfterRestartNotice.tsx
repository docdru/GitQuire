import { t } from '@lingui/core/macro';
import { useState, useSyncExternalStore } from 'react';
import {
  dismissUnsavedAfterRestart,
  subscribeUnsavedAfterRestart,
  unsavedAfterRestart,
} from '@/editor/unsaved-after-restart';
import { Button } from './ui/button';

export function UnsavedAfterRestartNotice({ docName }: { docName: string }) {
  const text = useSyncExternalStore(
    subscribeUnsavedAfterRestart,
    () => unsavedAfterRestart(docName),
    () => undefined,
  );
  const [copied, setCopied] = useState(false);
  if (text === undefined) return null;
  return (
    <div
      data-slot="unsaved-after-restart"
      role="alert"
      className="mx-4 my-3 flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50"
    >
      <p className="font-medium">{t`Some of your recent typing could not be saved`}</p>
      <p>
        {t`The server restarted while you were typing, and your latest changes could not be merged back into the page. Your version of the page is below: copy what is missing and paste it back.`}
      </p>
      <textarea
        readOnly
        aria-label={t`Your version of the page`}
        className="h-32 w-full resize-y rounded border bg-background p-2 font-mono text-xs text-foreground"
        value={text}
      />
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? t`Copied` : t`Copy`}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => dismissUnsavedAfterRestart(docName)}
        >
          {t`Dismiss`}
        </Button>
      </div>
    </div>
  );
}
