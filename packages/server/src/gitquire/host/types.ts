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

export type BotAccess = RepoAccess | 'refused' | 'unreachable';

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
  readonly names: HostNames;
  authorizeUrl: (input: AuthorizeInput) => string;
  exchangeCode: (input: ExchangeInput) => Promise<string | undefined>;
  person: (personToken: string) => Promise<HostPerson | undefined>;
  access: (personToken: string, repo: HostRepo) => Promise<RepoAccess>;
  accessByBot: (login: string, repo: HostRepo) => Promise<BotAccess>;
  tokenFor: (repo: HostRepo) => string | undefined;
}
