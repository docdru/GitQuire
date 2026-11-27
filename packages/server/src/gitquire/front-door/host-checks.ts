import type { GateLogger } from '../access-gate.ts';
import type { DoorHostEntry } from './door-hosts.ts';
import { FrontDoorConfigError } from './settings.ts';

export function hostSummary(entry: DoorHostEntry, externalUrl: URL): Record<string, unknown> {
  const settings = entry.settings;
  return {
    host: entry.key,
    kind: settings.kind,
    label: settings.label,
    address: settings.webUrl,
    callback: `${externalUrl.origin}${entry.paths.callback}`,
    allowedOwners: [...settings.allowedOwners],
    admins: [...settings.serverAdmins],
  };
}

export async function checkHosts(
  entries: readonly DoorHostEntry[],
  log: GateLogger,
): Promise<void> {
  const results = await Promise.all(
    entries.map(async (entry) => {
      try {
        return { entry, result: await entry.host.selfCheck() };
      } catch (err) {
        return {
          entry,
          result: {
            ok: false as const,
            unreachable: true,
            problems: [err instanceof Error ? err.message : String(err)],
          },
        };
      }
    }),
  );
  const refused: string[] = [];
  for (const { entry, result } of results) {
    if (result.ok) continue;
    if (result.unreachable) {
      log.warn(
        { host: entry.key, problems: result.problems },
        '[gitquire-door] a host could not be reached at start; its wikis stay closed to new people until it answers',
      );
    } else {
      refused.push(`${entry.key}: ${result.problems.join(' ')}`);
    }
  }
  if (refused.length > 0) {
    throw new FrontDoorConfigError(
      `A host did not pass its start check:\n${refused.map((line) => `  ${line}`).join('\n')}`,
    );
  }
}

export async function warnUnknownNames(
  entries: readonly DoorHostEntry[],
  log: GateLogger,
): Promise<void> {
  await Promise.all(
    entries.map(async (entry) => {
      const exists = entry.host.accountExists;
      if (exists === undefined) return;
      const settings = entry.settings;
      const names = [
        ...[...settings.serverAdmins].map((name) => ({ name, as: 'ADMINS' })),
        ...[...settings.allowedOwners].map((name) => ({ name, as: 'ALLOWED_OWNERS' })),
      ];
      for (const { name, as } of names) {
        const answer = await exists(name).catch(() => 'unknown' as const);
        if (answer !== 'missing') continue;
        log.warn(
          { host: entry.key, setting: as, name },
          `[gitquire-door] ${settings.label} does not know "${name}"; check its spelling in the host's ${as}`,
        );
      }
    }),
  );
}
