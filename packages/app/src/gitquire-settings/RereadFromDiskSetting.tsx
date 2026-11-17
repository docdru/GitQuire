import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

interface RereadResult {
  status?: string;
  found?: number;
}

export function RereadFromDiskSetting({ fetchImpl = fetch }: { fetchImpl?: typeof fetch }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);

  async function reread() {
    setBusy(true);
    try {
      const response = await fetchImpl('/api/documents/reread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error(String(response.status));
      const result = (await response.json()) as RereadResult;
      const found = result.found ?? 0;
      if (result.status !== 'completed') toast.warning(t`The re-read did not finish. Try again.`);
      else if (found === 0) toast.success(t`Re-read the files. Nothing had changed.`);
      else toast.success(t`Re-read the files and took in ${found} changes.`);
    } catch {
      toast.error(t`Couldn't re-read the files. Try again.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
      data-testid="reread-from-disk-setting"
    >
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-medium">{t`Re-read files from disk`}</div>
        <p className="text-muted-foreground text-1sm">
          {t`GitQuire picks up changes that come in through sync. If someone changed files in the content folder directly on the server, re-read them here.`}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void reread()}
        data-testid="reread-from-disk-button"
      >
        {busy ? t`Re-reading…` : t`Re-read files`}
      </Button>
    </div>
  );
}
