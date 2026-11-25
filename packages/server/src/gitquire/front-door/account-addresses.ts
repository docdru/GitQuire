import type { GateLogger } from '../access-gate.ts';
import { withoutNoReply } from '../host/account-address.ts';
import type { AccountAddress, HostPerson } from '../host/types.ts';
import { recordAccountAddress } from '../people/mail.ts';
import { type PeopleStore, personId } from '../people/store.ts';
import type { DoorHostEntry } from './door-hosts.ts';

export const ACCOUNT_ADDRESS_DEADLINE_MS = 5000;

function withinDeadline(work: Promise<AccountAddress>, ms: number): Promise<AccountAddress> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ state: 'unreachable' }), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve({ state: 'unreachable' });
      },
    );
  });
}

export function accountAddressReader(deps: {
  store: PeopleStore;
  log: GateLogger;
  now?: () => number;
  deadlineMs?: number;
}): (entry: DoorHostEntry, person: HostPerson, token: string) => Promise<void> {
  const now = deps.now ?? Date.now;
  return async (entry, person, token) => {
    const ask = entry.host.accountAddress;
    const found: AccountAddress =
      ask === undefined
        ? { state: 'refused' }
        : withoutNoReply(
            await withinDeadline(ask(token), deps.deadlineMs ?? ACCOUNT_ADDRESS_DEADLINE_MS),
            entry.names,
          );
    recordAccountAddress(
      deps.store,
      personId(entry.names.idPrefix, person.id),
      person.login,
      found,
      new Date(now()),
    );
    deps.log.info(
      { login: person.login, host: entry.key, account: found.state },
      '[gitquire-mail] account address read at sign-in',
    );
  };
}
