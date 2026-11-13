import { useLingui } from '@lingui/react/macro';
import { ChevronDown, ExternalLink, GitBranch, GitPullRequest, Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCurrentBranch } from '@/hooks/use-current-branch';
import {
  checkoutBranch,
  createBranch,
  fetchBranches,
  fetchPulls,
  type GitQuireBranches,
  type GitQuirePull,
  openPullRequest,
} from '@/lib/gitquire/branch-api';
import { classifyCheckoutOutcome } from '@/lib/share/branch-switch-flow';
import { triggerSync } from '@/lib/trigger-sync';

const MERGED_CHECK_MS = 60_000;

const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export function isPlausibleBranchName(name: string): boolean {
  return (
    BRANCH_NAME_PATTERN.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock')
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function GitQuireBranchMenu() {
  const { t } = useLingui();
  const liveBranch = useCurrentBranch();
  const [branches, setBranches] = useState<GitQuireBranches | null>(null);
  const [pulls, setPulls] = useState<GitQuirePull[]>([]);
  const [switchTarget, setSwitchTarget] = useState<string | null>(null);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [pullOpen, setPullOpen] = useState(false);

  const current = liveBranch ?? branches?.current ?? null;

  async function refresh() {
    try {
      const next = await fetchBranches();
      setBranches(next);
      if (next.github) setPulls((await fetchPulls()).pulls);
    } catch (err) {
      toast.error(t`Could not load branches`, { description: errorMessage(err) });
    }
  }

  async function switchTo(branch: string) {
    try {
      const outcome = classifyCheckoutOutcome(await checkoutBranch(branch));
      if (outcome.action === 'await-cc1') {
        toast.success(t`Switched to ${branch}`);
        return;
      }
      if (outcome.action === 'rerender-conflict') {
        toast.error(t`Unsaved changes block the switch`, {
          description: outcome.files.join(', '),
        });
        return;
      }
      toast.error(t`Could not switch to ${branch}`, { description: outcome.action });
    } catch (err) {
      toast.error(t`Could not switch to ${branch}`, { description: errorMessage(err) });
    }
  }

  const switchToRef = useRef(switchTo);
  switchToRef.current = switchTo;
  const followedMerge = useRef<string | null>(null);

  useEffect(() => {
    if (liveBranch === null) return;
    let stopped = false;
    async function followMergedBranch() {
      const next = await fetchBranches().catch(() => null);
      if (next === null || stopped) return;
      setBranches(next);
      const merged = next.current;
      if (next.currentMerged !== true || merged === null || followedMerge.current === merged) {
        return;
      }
      followedMerge.current = merged;
      toast.info(t`${merged} was merged on GitHub. Switching everyone to ${next.base}.`);
      await switchToRef.current(next.base);
    }
    void followMergedBranch();
    const timer = setInterval(() => void followMergedBranch(), MERGED_CHECK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [liveBranch, t]);

  if (liveBranch === null) return null;

  const onBase = current !== null && branches !== null && current === branches.base;
  const label = current ?? t`Branch`;
  const target = switchTarget ?? '';

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && void refresh()}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 gap-1 text-muted-foreground"
            data-testid="gitquire-branch-menu"
          >
            <GitBranch aria-hidden="true" />
            <span className="sr-only">{t`Branch`}</span>
            <span className="max-w-40 truncate">{label}</span>
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="max-h-96 min-w-64 overflow-y-auto">
          <DropdownMenuLabel>{t`Switch everyone to`}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={current ?? ''}
            onValueChange={(value) => value !== current && setSwitchTarget(value)}
          >
            {[...(branches?.local ?? []), ...(branches?.remoteOnly ?? [])].map((name) => (
              <DropdownMenuRadioItem key={name} value={name}>
                <span className="truncate">{name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setNewBranchOpen(true)}>
            <Plus aria-hidden="true" />
            {t`New branch…`}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={branches?.github !== true || onBase || current === null}
            onSelect={() => setPullOpen(true)}
          >
            <GitPullRequest aria-hidden="true" />
            {t`Open pull request…`}
          </DropdownMenuItem>
          {pulls.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t`Open pull requests`}</DropdownMenuLabel>
              {pulls.map((pull) => (
                <DropdownMenuItem key={pull.number} asChild>
                  <a href={pull.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink aria-hidden="true" />
                    <span className="truncate">
                      #{pull.number} {pull.title}
                    </span>
                  </a>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog
        open={switchTarget !== null}
        onOpenChange={(open) => !open && setSwitchTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Switch to ${target}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`Everyone editing this space moves to that branch.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (switchTarget !== null) void switchTo(switchTarget);
                setSwitchTarget(null);
              }}
            >
              {t`Switch`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <NewBranchDialog
        open={newBranchOpen}
        onOpenChange={setNewBranchOpen}
        from={current}
        existing={[...(branches?.local ?? []), ...(branches?.remoteOnly ?? [])]}
        onCreated={(name) => void switchTo(name)}
      />
      <OpenPullRequestDialog
        open={pullOpen}
        onOpenChange={setPullOpen}
        head={current}
        base={branches?.base ?? null}
      />
    </>
  );
}

interface NewBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  from: string | null;
  existing: readonly string[];
  onCreated: (name: string) => void;
}

function NewBranchDialog({ open, onOpenChange, from, existing, onCreated }: NewBranchDialogProps) {
  const { t } = useLingui();
  const inputId = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const valid = isPlausibleBranchName(trimmed) && !existing.includes(trimmed);

  async function submit(e: React.SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createBranch(trimmed, from ?? undefined);
      setBusy(false);
      onOpenChange(false);
      setName('');
      onCreated(trimmed);
    } catch (err) {
      setBusy(false);
      setError(errorMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t`New branch`}</DialogTitle>
            <DialogDescription>
              {from === null
                ? t`Everyone moves to the new branch once it is created.`
                : t`Starts from ${from}. Everyone moves to the new branch once it is created.`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-2">
            <Label htmlFor={inputId}>{t`Branch name`}</Label>
            <Input
              id={inputId}
              value={name}
              placeholder="report/q4-results"
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              aria-invalid={trimmed !== '' && !valid}
            />
            {error !== null && <p className="text-destructive text-sm">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {t`Create and switch`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface OpenPullRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  head: string | null;
  base: string | null;
}

function OpenPullRequestDialog({ open, onOpenChange, head, base }: OpenPullRequestDialogProps) {
  const { t } = useLingui();
  const titleId = useId();
  const bodyId = useId();
  const draftId = useId();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = title.trim() !== '' && !busy && head !== null;
  const headName = head ?? '';
  const baseName = base ?? '';

  async function submit(e: React.SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const pull = await openPullRequest(
        { title: title.trim(), body, draft },
        { push: () => triggerSync('push') },
      );
      onOpenChange(false);
      setTitle('');
      setBody('');
      setDraft(false);
      const number = pull.number;
      setBusy(false);
      toast.success(t`Opened pull request #${number}`, {
        action: { label: t`View`, onClick: () => window.open(pull.url, '_blank', 'noopener') },
      });
    } catch (err) {
      setBusy(false);
      setError(errorMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t`Open pull request`}</DialogTitle>
            <DialogDescription>
              {t`Proposes merging ${headName} into ${baseName}. Pending edits are pushed first.`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor={titleId}>{t`Title`}</Label>
              <Input id={titleId} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={bodyId}>{t`Description`}</Label>
              <Textarea
                id={bodyId}
                rows={5}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id={draftId}
                checked={draft}
                onCheckedChange={(value) => setDraft(value === true)}
              />
              <Label htmlFor={draftId}>{t`Draft`}</Label>
            </div>
            {error !== null && <p className="text-destructive text-sm">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy ? t`Opening…` : t`Open pull request`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
