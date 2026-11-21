export type HostKind = 'github' | 'forgejo';

export interface HostRepo {
  owner: string;
  name: string;
}

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

export interface DoorHost {
  authorizeUrl: (input: AuthorizeInput) => string;
  exchangeCode: (input: ExchangeInput) => Promise<string | undefined>;
  person: (personToken: string) => Promise<HostPerson | undefined>;
  access: (personToken: string, repo: HostRepo) => Promise<RepoAccess>;
  accessByBot: (login: string, repo: HostRepo) => Promise<BotAccess>;
  tokenFor: (repo: HostRepo) => Promise<string | undefined>;
}
