import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { GateLogger, SessionUser } from '../access-gate.ts';
import type { AccessVerdict } from '../agent-access.ts';
import { derivePeopleKeySecret } from '../chat/key-secret.ts';
import { confirmationKey, confirmationKeyPath } from '../email-confirmation.ts';
import { withoutNoReply } from '../host/account-address.ts';
import { hostNames } from '../host/names.ts';
import type { AccountAddress } from '../host/types.ts';
import type { MailConfig, MailConfigResult, MailMessage } from '../mail.ts';
import type { MentionIndex } from '../mentions.ts';
import { personKeyStore } from './chat-data.ts';
import { createEmailService, type EmailPerson } from './email-service.ts';
import { recordAccountAddress } from './mail.ts';
import { createPeopleMailer, type PeopleMailer, type WikiOpen } from './mailer.ts';
import { movePeopleData, SINGLE_WIKI_KEY } from './move-over.ts';
import {
  createPersonRoutes,
  emailRoutes,
  type PersonRoutes,
  settingsRoutes,
} from './person-routes.ts';
import { personSettings } from './settings.ts';
import { createPeopleStore, type PeopleStore, personId, singleWikiPeopleRoot } from './store.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface SingleWikiPeopleDeps {
  projectDir: string;
  env: Env;
  log: GateLogger;
  mail: MailConfigResult;
  send: (config: MailConfig, message: MailMessage) => Promise<void>;
  mentions: MentionIndex;
  readIds: (accountId: number) => Set<string>;
  sessionUser: (req: IncomingMessage) => SessionUser | undefined;
  sameOrigin: (req: IncomingMessage) => boolean;
  canOpen?: (login: string) => Promise<AccessVerdict>;
  now?: () => number;
}

export interface SingleWikiPeople {
  store: PeopleStore;
  routes: PersonRoutes;
  mailer: PeopleMailer | undefined;
  who: (req: IncomingMessage) => EmailPerson | undefined;
  seen: (user: Pick<SessionUser, 'id' | 'login'>) => void;
  recordAddress: (user: Pick<SessionUser, 'id' | 'login'>, found: AccountAddress) => void;
}

function openOf(verdict: AccessVerdict): WikiOpen {
  return verdict === 'allowed' ? 'open' : verdict === 'denied' ? 'closed' : 'unknown';
}

export function createSingleWikiPeople(deps: SingleWikiPeopleDeps): SingleWikiPeople {
  const now = deps.now ?? (() => Date.now());
  const names = hostNames();
  const store = createPeopleStore(singleWikiPeopleRoot(deps.projectDir));
  const secret = deps.env.GITQUIRE_SESSION_SECRET?.trim() ?? '';
  const keys =
    secret.length >= 32 ? personKeyStore(store, derivePeopleKeySecret(secret)) : undefined;
  const config = deps.mail.kind === 'on' ? deps.mail.config : undefined;
  const mailer = createPeopleMailer({
    store,
    config,
    send: deps.send,
    log: deps.log,
    now,
    wikis: () => [
      {
        key: SINGLE_WIKI_KEY,
        idPrefix: names.idPrefix,
        name: config?.wiki,
        url: config?.externalUrl,
        mentions: deps.mentions.all,
        readIds: deps.readIds,
        canOpen: async (account) =>
          deps.canOpen === undefined ? 'open' : openOf(await deps.canOpen(account.login)),
      },
    ],
  });
  try {
    const moved = movePeopleData(
      [
        {
          dir: deps.projectDir,
          wikiKey: SINGLE_WIKI_KEY,
          idPrefix: names.idPrefix,
          keySecrets: secret === '' ? [] : [secret],
        },
      ],
      {
        store,
        ...(keys === undefined ? {} : { keys }),
        markExisting: (person, login, wikiKey, before) =>
          mailer.markExisting(person, login, wikiKey, before),
        now,
      },
    );
    if (moved.wikis.length > 0) {
      deps.log.info(
        { people: moved.people, addresses: moved.addresses, keys: moved.keys },
        '[gitquire-people] moved per-person data into the people folder; the old files stay as they were',
      );
    }
  } catch (err) {
    deps.log.warn({ err }, '[gitquire-people] could not move the per-person data');
  }
  let codeKeyValue: string | undefined;
  const email = createEmailService({
    store,
    countersFile: join(store.root, '..', 'mail-recipients.json'),
    mail: deps.mail,
    codeKey: () => {
      codeKeyValue ??= confirmationKey(
        deps.env.GITQUIRE_SESSION_SECRET,
        confirmationKeyPath(deps.projectDir),
      );
      return codeKeyValue;
    },
    send: deps.send,
    log: deps.log,
    onSwitchedOn: (person, login) => mailer.markExisting(person, login),
    now,
  });
  return {
    store,
    routes: createPersonRoutes({
      routes: [emailRoutes(email), settingsRoutes(personSettings(store))],
      sameOrigin: deps.sameOrigin,
      log: deps.log,
    }),
    mailer: config === undefined ? undefined : mailer,
    who: (req) => {
      const user = deps.sessionUser(req);
      return user === undefined
        ? undefined
        : { person: personId(names.idPrefix, user.id), login: user.login, hostLabel: names.label };
    },
    seen: (user) => email.seen({ person: personId(names.idPrefix, user.id), login: user.login }),
    recordAddress: (user, found) => {
      recordAccountAddress(
        store,
        personId(names.idPrefix, user.id),
        user.login,
        withoutNoReply(found, names),
        new Date(now()),
      );
    },
  };
}
