import { okUserHomeDisplayPath } from '@inkeep/open-knowledge-core';
import { type ProcessStart, readProcessStart } from '@inkeep/open-knowledge-server';

type NativeFailureKind = 'unavailable' | 'query-failed';

export interface NativeFailure {
  kind: NativeFailureKind;
  reason: string;
}

export interface HolderProcessStartOptions {
  platform?: NodeJS.Platform;
  onNativeFailure?: (failure: NativeFailure) => void;
}

export function readHolderProcessStart(
  pid: number,
  options: HolderProcessStartOptions = {},
): ProcessStart | null {
  return readProcessStart(
    pid,
    options.platform === undefined ? {} : { platform: options.platform },
  );
}

export function describeHolderStartReadFailure(args: {
  platform: NodeJS.Platform;
  pid: number;
  nativeFailures: readonly NativeFailure[];
  causeRecorded: boolean;
}): string {
  const { platform, pid, nativeFailures, causeRecorded } = args;
  const componentUnavailable = nativeFailures.some((failure) => {
    switch (failure.kind) {
      case 'unavailable':
        return true;
      case 'query-failed':
        return false;
      default: {
        const exhaustive: never = failure.kind;
        return exhaustive;
      }
    }
  });
  const windowsRecovery =
    nativeFailures.length === 0
      ? ''
      : componentUnavailable
        ? 'Reinstall GitQuire to restore the Windows component that verifies process identity. '
        : 'The Windows component loaded but the operating system refused the query, so reinstalling will not help; retry from an account that can inspect that process. ';
  const probeRecovery =
    platform === 'linux'
      ? `Linux reads the process start from /proc/${pid}/stat and /proc/stat; restore read access to /proc and retry. `
      : platform === 'darwin'
        ? 'macOS reads the process start with ps, and that read failed, as it does inside some sandboxes; retry from a shell where ps can run. '
        : platform === 'win32'
          ? windowsRecovery
          : '';
  const causeRecord =
    nativeFailures.length > 0 && causeRecorded
      ? `The failure detail is recorded in the CLI log under ${okUserHomeDisplayPath('logs')}. `
      : '';
  return probeRecovery + causeRecord;
}
