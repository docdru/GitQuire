export type HostKind = 'github' | 'forgejo';

export interface HostRepo {
  owner: string;
  name: string;
}

export type HostRepoRef = HostRepo & { readonly id?: number };

export interface HostPerson {
  id: number;
  login: string;
  name: string;
  avatarUrl: string;
}

export interface HostNames {
  readonly kind: HostKind;
  readonly label: string;
  readonly idPrefix: string;
  noreplyEmail: (person: Pick<HostPerson, 'id' | 'login'>) => string;
}

export type RepoAccess = 'none' | 'write' | 'admin';

export type Refusal = 'token' | 'not-admin' | 'removed';

export type BotAccess = RepoAccess | 'unreachable' | `refused:${Refusal}`;

export type HostHealth = 'ok' | 'unreachable' | `refused:${Refusal}`;

export interface HostRepoRecord {
  host: HostKind;
  id: number;
  owner: string;
  ownerId: number;
  name: string;
}

export type RepoLookup =
  | { state: 'found'; repo: HostRepoRecord }
  | { state: 'gone' }
  | { state: 'refused'; refusal: Refusal }
  | { state: 'unreachable' };

export interface AddableRepo extends HostRepoRecord {
  blocked?: 'bot-not-admin';
}

export type AddableRepos =
  | { state: 'listed'; repos: readonly AddableRepo[] }
  | { state: 'refused'; whose: 'person' | 'gitquire' }
  | { state: 'unreachable' };

export interface AuthorizeInput {
  clientId: string;
  redirectUri: string;
  state: string;
}

export interface ExchangeInput {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}

export type SelfCheck =
  | { ok: true }
  | { ok: false; unreachable: boolean; problems: readonly string[] };

export interface DoorHost {
  authorizeUrl: (input: AuthorizeInput) => string;
  exchangeCode: (input: ExchangeInput) => Promise<string | undefined>;
  person: (personToken: string) => Promise<HostPerson | undefined>;
  access: (personToken: string, repo: HostRepoRef) => Promise<RepoAccess>;
  accessByBot: (login: string, repo: HostRepoRef) => Promise<BotAccess>;
  addableRepos: (personToken: string) => Promise<AddableRepos>;
  repoById: (id: number) => Promise<RepoLookup>;
  repoByName: (repo: HostRepo) => Promise<RepoLookup>;
  health: (repo: HostRepoRef) => Promise<HostHealth>;
  tokenFor: (repo: HostRepoRef) => Promise<string | undefined>;
  selfCheck: () => Promise<SelfCheck>;
}
