import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  type ContractSpec,
  delivered,
  deliveriesFor,
  type ForkedContractProcess,
  type ForkedWatcherProcess,
  forkWatcherProcess,
  type LoggedError,
  type ReadinessScenario,
  type Recovery,
  reportOf,
  unlinked,
  type WatcherEntry,
  type WatcherProcessReport,
} from './forked-watcher-process.test-helper.ts';

interface WatchedFile {
  watch: string[];
  target: string;
}

interface EntryCase {
  watcher: string;
  entry: WatcherEntry;
}

interface UnreadableCase extends EntryCase {
  unreadable: 'directory';
}

interface RecoveryCase extends UnreadableCase {
  recovery: Recovery;
}

const ENTRIES: EntryCase[] = [
  { watcher: 'startConfigFileWatcher', entry: 'config' },
  { watcher: 'startMultiPathConfigFileWatcher', entry: 'multi-config' },
];

const UNREADABLE_CASES: UnreadableCase[] = [
  { watcher: 'startConfigFileWatcher', entry: 'config', unreadable: 'directory' },
  { watcher: 'startMultiPathConfigFileWatcher', entry: 'multi-config', unreadable: 'directory' },
];

const RECOVERY_CASES: RecoveryCase[] = UNREADABLE_CASES.flatMap((unreadableCase) =>
  (['readable', 'removed'] as const).map((recovery) => ({ ...unreadableCase, recovery })),
);

const INITIAL: Record<WatcherEntry, string> = {
  config: 'theme: light\n',
  'multi-config': '*.tmp\n',
};

const PARTIAL = 'half-writ';
const COMPLETE = 'half-written, then completed\n';
const HELD_CHANGE = 'changed while the next sample was held\n';
const READABLE_AGAIN = 'edited once readable\n';
const SAME_SIZE_REPLACEMENT = 'theme: dark!\n';

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

let fixture: string;
let harness: ForkedWatcherProcess | undefined;
const madeUnreadable: string[] = [];

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'ok-polled-contract-'));
});
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  for (const dir of madeUnreadable.splice(0)) chmodSync(dir, 0o755);
  rmSync(fixture, { recursive: true, force: true });
});

function watchedFile(entry: WatcherEntry, scenario: ReadinessScenario): WatchedFile {
  const project = join(fixture, 'project');
  const file: WatchedFile =
    entry === 'config'
      ? {
          watch: [join(project, '.ok', 'config.yml')],
          target: join(project, '.ok', 'config.yml'),
        }
      : {
          watch: [join(project, '.okignore'), join(project, '.gitignore')],
          target: join(project, '.okignore'),
        };
  mkdirSync(dirname(file.target), { recursive: true });
  if (entry === 'multi-config') write(join(project, '.gitignore'), 'dist/\n');
  if (scenario === 'edit') write(file.target, INITIAL[entry]);
  return file;
}

async function watchFrom(
  entry: WatcherEntry,
  watch: string[],
  coarseTimestampsAt?: string,
): Promise<ForkedContractProcess> {
  const spec: ContractSpec = { mode: 'contract', entry, watch, coarseTimestampsAt };
  const run = forkWatcherProcess(spec);
  harness = run;
  await run.until(
    'the watcher to start and every baseline it registered to be taken',
    (reports) => reportOf(reports, 'settled') !== undefined,
  );
  return run;
}

function unreadableScope(
  _case: UnreadableCase,
  { watch, target }: WatchedFile,
): { dir: string; failing: string[] } {
  return { dir: dirname(target), failing: watch };
}

function accessDenials(logged: readonly LoggedError[] = []): LoggedError[] {
  return logged.filter((entry) => entry.code === 'EACCES');
}

function asLogLines(logged: readonly LoggedError[]): string[] {
  return logged.map((entry) => `${entry.level} ${entry.code} ${entry.path}: ${entry.message}`);
}

function reportsFor(
  logged: readonly LoggedError[] | undefined,
  code: string,
  path: string,
): LoggedError[] {
  return (logged ?? []).filter((entry) => entry.code === code && entry.path === path);
}

function reportsBefore(
  reports: readonly WatcherProcessReport[],
  kind: WatcherProcessReport['kind'],
): readonly WatcherProcessReport[] {
  const at = reports.findIndex((report) => report.kind === kind);
  return at === -1 ? reports : reports.slice(0, at);
}

function failingSampleOf(_case: UnreadableCase, { target }: WatchedFile): string {
  return target;
}

function sampledEveryPollOf(_case: UnreadableCase, { target }: WatchedFile): string {
  return target;
}

function failingOnceMore(_case: RecoveryCase, failing: string[]): string[] {
  return failing;
}

describe('a file written in two steps is reported only once its size holds', () => {
  test.each(
    ENTRIES.flatMap((entryCase) =>
      (['create', 'edit'] as const).map((scenario) => ({ ...entryCase, scenario })),
    ),
  )(
    '$watcher never reports a $scenario half-written, and reports it once the second half lands',
    async ({ entry, scenario }) => {
      const { watch, target } = watchedFile(entry, scenario);
      const run = await watchFrom(entry, watch);

      run.send({ op: 'write-in-two-steps', path: target, partial: PARTIAL, complete: COMPLETE });
      await run.until(
        `the watcher to report ${target} with the contents of both halves, never the first half alone`,
        (reports) => {
          expect(
            deliveriesFor(reports, target),
            `the watcher reported ${target} holding only the first half of a two-step write ` +
              `(first half written at a startup timer tick: ${reportOf(reports, 'partial-written')?.atStartupTimerTick})`,
          ).not.toContain(PARTIAL);
          return delivered(reports, target, COMPLETE);
        },
      );
      expect(
        reportOf(run.reports(), 'partial-sampled'),
        'the second half is written only after the watcher has sampled the first',
      ).toBeDefined();
    },
  );
});

describe('closing a watcher', () => {
  test.each(ENTRIES)(
    '$watcher cleanup, called while the watcher samples a pending change, resolves when called twice, reports nothing once resolved, and leaves nothing that keeps the process alive',
    async ({ entry }) => {
      const { watch, target } = watchedFile(entry, 'edit');
      const run = await watchFrom(entry, watch);

      run.send({
        op: 'close-while-sampling',
        path: target,
        content: 'changed just before cleanup',
      });
      await run.until(
        `the watcher to sample the change to ${target} once and begin sampling it again, when cleanup is called`,
        (reports) => reportOf(reports, 'closing') !== undefined,
      );
      await run.until(
        'cleanup to resolve, twice',
        (reports) => reportOf(reports, 'closed') !== undefined,
      );
      await run.until(
        'the watcher process to fall idle on its own once cleanup resolved (a timer or handle the watcher left armed keeps it running)',
        (reports) => reportOf(reports, 'quiesced') !== undefined,
      );
      expect(
        reportOf(run.reports(), 'quiesced')?.eventsAfterClose,
        'the watcher called back after its cleanup resolved',
      ).toEqual([]);
      await run.until('the idle watcher process to exit', () => run.exitStatus() !== undefined);
      expect(run.exitStatus(), 'the watcher process exits by itself once idle').toEqual({
        code: 0,
        signal: null,
      });
    },
  );
});

describe.skipIf(process.platform === 'win32')(
  'a watcher never begins a sample of a path while its previous sample is in flight (the threadpool barrier is a POSIX FIFO)',
  () => {
    test.each(ENTRIES)(
      '$watcher begins no further sample of a changed file while that sample is held on the only libuv worker, then reports the change',
      async ({ entry }) => {
        const { watch, target } = watchedFile(entry, 'edit');
        const barrier = join(fixture, 'threadpool-barrier');
        execFileSync('mkfifo', [barrier]);
        const run = await watchFrom(entry, watch);

        run.send({ op: 'hold-next-sample', path: target, content: HELD_CHANGE, barrier });
        await run.until(
          `the watcher to begin sampling ${target} after it changed`,
          (reports) => reportOf(reports, 'sample-held') !== undefined,
        );
        await run.until(
          'every timer the watcher had pending while that sample was held to fire or be cleared (this over-constrains, by design, a watcher that keeps a timer pending for longer than the test budget)',
          (reports) => reportOf(reports, 'overlap-checked') !== undefined,
        );
        const checked = reportOf(run.reports(), 'overlap-checked');
        expect(
          checked?.samplesBegunWhileHeld,
          `the watcher began another sample of ${target} (or another listing of its skills root) while the previous sample was still in flight ` +
            `(${checked?.timersWaitedOut} pending timer(s) waited out): a slow filesystem would pile samples up behind the libuv threadpool the server shares`,
        ).toBe(0);

        await run.until(
          `onChange to report the change to ${target} once the held sample was released`,
          (reports) => delivered(reports, target, HELD_CHANGE),
        );
      },
    );
  },
);

describe.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
  'an error the watcher keeps silent to its callers is reported at some logger level, and not again while it persists (EACCES; chmod does not bind root or Windows)',
  () => {
    test.each(UNREADABLE_CASES)(
      '$watcher reports the EACCES of every path it cannot read while its $unreadable is unreadable, at least once, and not again in a further poll',
      async (unreadableCase) => {
        const file = watchedFile(unreadableCase.entry, 'edit');
        const { dir, failing } = unreadableScope(unreadableCase, file);
        const run = await watchFrom(unreadableCase.entry, file.watch);

        madeUnreadable.push(dir);
        run.send({ op: 'unreadable-across-polls', dir, path: file.target });
        await run.until(
          `the watcher to sample ${file.target} in polls that fail with EACCES, until a poll begun with the ${unreadableCase.unreadable} already unreadable and one more poll have both settled`,
          (reports) => {
            expect(
              unlinked(reports, file.target),
              `onUnlink reported ${file.target} although only its ${unreadableCase.unreadable} was unreadable: ` +
                'the watcher read the EACCES as a deletion instead of keeping the last observation and reporting the error',
            ).toBe(false);
            return reportOf(reports, 'error-reports') !== undefined;
          },
        );

        const errorReports = reportOf(run.reports(), 'error-reports');
        const onceEstablished = accessDenials(errorReports?.onceEstablished);
        const afterAnotherPoll = accessDenials(errorReports?.afterAnotherPoll);
        for (const path of failing) {
          expect(
            afterAnotherPoll.filter((entry) => entry.path === path),
            `the watcher never reported the EACCES of ${path} at any logger level: an error it keeps silent to its callers must be reported, not swallowed`,
          ).not.toEqual([]);
        }
        expect(
          asLogLines(afterAnotherPoll),
          'the watcher reported the EACCES again in a further poll while it persisted, instead of once per path and error code',
        ).toEqual(asLogLines(onceEstablished));
      },
    );
  },
);

describe.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
  'an error the watcher reported is reported again once the path has read as present or absent and then fails once more (EACCES; chmod does not bind root or Windows)',
  () => {
    test.each(RECOVERY_CASES)(
      '$watcher reports the EACCES of every path it cannot read in each episode when its $unreadable is unreadable, then $recovery, then unreadable once more',
      async (recoveryCase) => {
        const { unreadable, recovery } = recoveryCase;
        const file = watchedFile(recoveryCase.entry, 'edit');
        const { dir, failing } = unreadableScope(recoveryCase, file);
        const run = await watchFrom(recoveryCase.entry, file.watch);

        madeUnreadable.push(dir);
        run.send({
          op: 'unreadable-again-after-recovery',
          dir,
          failingAt: failingSampleOf(recoveryCase, file),
          sampledEveryPoll: sampledEveryPollOf(recoveryCase, file),
          recovery,
          aside: join(fixture, 'aside'),
        });
        await run.until(
          `the watcher to sample through an unreadable episode of its ${unreadable}, its recovery (${recovery}) and a second unreadable episode, each established by a poll begun with it in place`,
          (reports) => {
            expect(
              unlinked(reportsBefore(reports, 'removed'), file.target),
              `onUnlink reported ${file.target} while its ${unreadable} was only unreadable: ` +
                'the watcher read the EACCES as a deletion instead of keeping the last observation and reporting the error',
            ).toBe(false);
            return reportOf(reports, 'error-reports-across-recovery') !== undefined;
          },
        );

        const episodes = reportOf(run.reports(), 'error-reports-across-recovery');
        for (const path of failing) {
          expect(
            reportsFor(episodes?.firstEpisode, 'EACCES', path),
            `the watcher never reported the EACCES of ${path} in the first unreadable episode, at any logger level`,
          ).not.toEqual([]);
        }
        for (const path of failingOnceMore(recoveryCase, failing)) {
          expect(
            reportsFor(episodes?.afterRecovery, 'EACCES', path),
            `the watcher reported the EACCES of ${path} in the first unreadable episode but not in the one after its ${unreadable} was ${recovery}: ` +
              'a path that reads as present or absent again must have its next failure reported, or a second episode is kept silent',
          ).not.toEqual([]);
        }
      },
    );
  },
);

describe.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
  'an error the watcher keeps silent to its callers is reported once per error code, so a path that keeps failing with a new code is reported again (EACCES, then ELOOP; chmod does not bind root or Windows)',
  () => {
    test.each(UNREADABLE_CASES)(
      '$watcher reports the ELOOP of every path it cannot read once its $unreadable, unreadable until then, becomes a symlink loop, and not again while it stays one',
      async (unreadableCase) => {
        const { unreadable } = unreadableCase;
        const file = watchedFile(unreadableCase.entry, 'edit');
        const { dir, failing } = unreadableScope(unreadableCase, file);
        const failingAt = failingSampleOf(unreadableCase, file);
        const run = await watchFrom(unreadableCase.entry, file.watch);

        madeUnreadable.push(dir);
        run.send({
          op: 'error-code-changes-while-failing',
          dir,
          failingAt,
          aside: join(fixture, 'aside'),
        });
        await run.until(
          `the watcher to sample ${failingAt} in polls that fail with EACCES and then, once the ${unreadable} is a symlink loop, with ELOOP, each established by a poll begun with it in place`,
          (reports) => {
            expect(
              unlinked(reports, file.target),
              `onUnlink reported ${file.target} while its ${unreadable} was only unreadable and then a symlink loop: ` +
                'the watcher read EACCES or ELOOP as a deletion instead of keeping the last observation and reporting the error',
            ).toBe(false);
            return reportOf(reports, 'error-reports-across-code-change') !== undefined;
          },
        );

        const codes = reportOf(run.reports(), 'error-reports-across-code-change');
        for (const path of failing) {
          expect(
            reportsFor(codes?.beforeChange, 'EACCES', path),
            `the watcher never reported the EACCES of ${path} before its error code changed, at any logger level`,
          ).not.toEqual([]);
          expect(
            reportsFor(codes?.afterChange, 'ELOOP', path),
            `the watcher reported the EACCES of ${path} but not the ELOOP it failed with next: ` +
              'reports are once per path and error code, so a new code on a path that keeps failing must be reported',
          ).not.toEqual([]);
          expect(
            asLogLines(reportsFor(codes?.whileItPersists, 'ELOOP', path)),
            `the watcher reported the ELOOP of ${path} again in further polls while it persisted, instead of once per path and error code`,
          ).toEqual([]);
        }
      },
    );
  },
);

describe('closing a watcher between polls', () => {
  test('startConfigFileWatcher cleanup, called while no sample is in flight, leaves no poll armed to sample again', async () => {
    const { watch, target } = watchedFile('config', 'edit');
    const run = await watchFrom('config', watch);

    run.send({ op: 'close-between-polls', path: target });
    await run.until(
      'the watcher process to fall idle on its own once cleanup resolved between two polls',
      (reports) => reportOf(reports, 'idle-after-close') !== undefined,
    );
    expect(
      reportOf(run.reports(), 'idle-after-close')?.samplesAfterClose,
      `the watcher sampled ${target} again after its cleanup resolved: cleanup left its next poll armed`,
    ).toBe(0);
  });
});

describe.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
  'a watcher started while its file is unreadable (EACCES; chmod does not bind root or Windows)',
  () => {
    test.each(ENTRIES.filter(({ entry }) => entry !== 'multi-config'))(
      '$watcher resolves its start and reports an edit made once the file is readable',
      async ({ entry }) => {
        const { watch, target } = watchedFile(entry, 'edit');
        const dir = dirname(target);
        const mode = statSync(dir).mode & 0o7777;
        madeUnreadable.push(dir);
        chmodSync(dir, 0o000);
        const run = await watchFrom(entry, watch);

        chmodSync(dir, mode);
        writeFileSync(target, READABLE_AGAIN, 'utf-8');
        await run.until(
          `onChange to report the edit of ${target} made once its directory was readable, after a start that met it unreadable`,
          (reports) => delivered(reports, target, READABLE_AGAIN),
        );
        expect(delivered(run.reports(), target, READABLE_AGAIN)).toBe(true);
      },
    );
  },
);

describe('a file whose two-step write is interrupted between its halves is reported only once its size holds after the interruption', () => {
  test.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
    'startConfigFileWatcher never reports an edit half-written when a sample between the halves fails with EACCES (chmod does not bind root or Windows)',
    async () => {
      const { watch, target } = watchedFile('config', 'edit');
      const dir = dirname(target);
      madeUnreadable.push(dir);
      const run = await watchFrom('config', watch);

      run.send({
        op: 'two-step-write-across-interruption',
        path: target,
        dir,
        partial: PARTIAL,
        complete: COMPLETE,
        interruption: 'unreadable',
      });
      await run.until(
        `the watcher to report ${target} with both halves after a sample between them failed with EACCES, never the first half alone`,
        (reports) => {
          expect(
            deliveriesFor(reports, target),
            `the watcher reported ${target} holding only the first half once a sample between the halves had failed: a failed sample must drop the size it was waiting to see hold`,
          ).not.toContain(PARTIAL);
          return delivered(reports, target, COMPLETE);
        },
      );
      expect(
        reportOf(run.reports(), 'interrupted'),
        'a watcher sample between the two halves failed with EACCES',
      ).toBeDefined();
    },
  );

  test('startConfigFileWatcher never reports a creation half-written when the file is deleted and created again with its first half', async () => {
    const { watch, target } = watchedFile('config', 'create');
    const run = await watchFrom('config', watch);

    run.send({
      op: 'two-step-write-across-interruption',
      path: target,
      dir: dirname(target),
      partial: PARTIAL,
      complete: COMPLETE,
      interruption: 'removed',
    });
    await run.until(
      `the watcher to report ${target} with both halves after a sample between them found it deleted, never the first half alone`,
      (reports) => {
        expect(
          deliveriesFor(reports, target),
          `the watcher reported ${target} holding only the first half once a sample between the halves had found it absent: an absent sample must drop the size it was waiting to see hold`,
        ).not.toContain(PARTIAL);
        return delivered(reports, target, COMPLETE);
      },
    );
    expect(
      reportOf(run.reports(), 'interrupted'),
      'a watcher sample between the two halves found the file absent',
    ).toBeDefined();
  });
});

describe('a watched file replaced by one of the same size and modification time', () => {
  test('startConfigFileWatcher reports the replacement', async () => {
    const { watch, target } = watchedFile('config', 'edit');
    const { mtime } = statSync(target);
    utimesSync(target, mtime, mtime);
    const run = await watchFrom('config', watch);

    const replacement = `${target}.replacement`;
    write(replacement, SAME_SIZE_REPLACEMENT);
    utimesSync(replacement, mtime, mtime);
    expect(
      statSync(replacement, { bigint: true }).size,
      'the replacement has the size of the file it replaces',
    ).toBe(statSync(target, { bigint: true }).size);
    expect(
      statSync(replacement, { bigint: true }).mtimeNs,
      'the replacement has the modification time of the file it replaces',
    ).toBe(statSync(target, { bigint: true }).mtimeNs);
    renameSync(replacement, target);
    await run.until(
      `onChange to report the replacement of ${target}, which kept its size and modification time but not its inode or change time`,
      (reports) => delivered(reports, target, SAME_SIZE_REPLACEMENT),
    );
  });
});

describe.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
  'an error the watcher reported is reported again once its directory has been a regular file (EACCES, then ENOTDIR, then EACCES; chmod does not bind root or Windows)',
  () => {
    test.each(UNREADABLE_CASES.filter(({ entry }) => entry !== 'multi-config'))(
      '$watcher reports the EACCES of every path it cannot read in each episode when its $unreadable is unreadable, then a regular file, then unreadable once more',
      async (unreadableCase) => {
        const { unreadable } = unreadableCase;
        const file = watchedFile(unreadableCase.entry, 'edit');
        const { dir, failing } = unreadableScope(unreadableCase, file);
        const run = await watchFrom(unreadableCase.entry, file.watch);

        madeUnreadable.push(dir);
        run.send({
          op: 'unreadable-again-after-recovery',
          dir,
          failingAt: failingSampleOf(unreadableCase, file),
          sampledEveryPoll: sampledEveryPollOf(unreadableCase, file),
          recovery: 'replaced-by-file',
          aside: join(fixture, 'aside'),
        });
        await run.until(
          `the watcher to sample through an unreadable episode of its ${unreadable}, a spell as a regular file and a second unreadable episode, each established by a poll begun with it in place`,
          (reports) => {
            expect(
              unlinked(reportsBefore(reports, 'removed'), file.target),
              `onUnlink reported ${file.target} while its ${unreadable} was only unreadable: ` +
                'the watcher read the EACCES as a deletion instead of keeping the last observation and reporting the error',
            ).toBe(false);
            return reportOf(reports, 'error-reports-across-recovery') !== undefined;
          },
        );

        const episodes = reportOf(run.reports(), 'error-reports-across-recovery');
        for (const path of failing) {
          expect(
            reportsFor(episodes?.firstEpisode, 'EACCES', path),
            `the watcher never reported the EACCES of ${path} in the first unreadable episode, at any logger level`,
          ).not.toEqual([]);
          expect(
            reportsFor(episodes?.afterRecovery, 'EACCES', path),
            `the watcher reported the EACCES of ${path} before its ${unreadable} was a regular file but not after: ` +
              'a sample that fails with ENOTDIR reads as absent, so the next failure must be reported again',
          ).not.toEqual([]);
        }
      },
    );
  },
);

describe.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
  'closing a watcher whose in-flight sample has not settled (the threadpool barrier is a POSIX FIFO; chmod does not bind root or Windows)',
  () => {
    test.each(ENTRIES)(
      '$watcher cleanup resolves while its sample of a watched file is held on the only libuv worker, and reports nothing once that sample fails',
      async ({ entry }) => {
        const { watch, target } = watchedFile(entry, 'edit');
        const dir = dirname(target);
        const barrier = join(fixture, 'threadpool-barrier');
        execFileSync('mkfifo', [barrier]);
        madeUnreadable.push(dir);
        const run = await watchFrom(entry, watch);

        run.send({ op: 'close-while-sample-held', path: target, dir, barrier });
        await run.until(
          `the watcher process to fall idle once cleanup was called while its sample of ${target} was held, and that sample then failed with EACCES`,
          (reports) => reportOf(reports, 'idle-after-held-close') !== undefined,
        );
        const idle = reportOf(run.reports(), 'idle-after-held-close');
        expect(
          idle?.resolvedWhileHeld,
          `cleanup waited on the watcher's in-flight sample of ${target}: a sample that never settles, on a stalled mount, keeps server shutdown from reaching its document flush`,
        ).toBe(true);
        expect(
          idle?.eventsAfterClose,
          'the watcher called back after its cleanup resolved',
        ).toEqual([]);
        expect(
          asLogLines(idle?.loggedAfterClose ?? []),
          'the watcher reported an error from a sample that landed after its cleanup resolved',
        ).toEqual([]);
      },
    );
  },
);
