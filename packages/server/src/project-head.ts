import { discoverGitRepository, type GitRepository } from '@gitquire/core/git-repository';

export interface ProjectHeadState {
  readonly branch: string | null;
  readonly oid: string | null;
}

function readRepositoryHeadState(repository: GitRepository): ProjectHeadState {
  const head = repository.readHead();
  if (head.kind === 'detached') {
    return { branch: `detached-${head.oid.slice(0, 12)}`, oid: head.oid };
  }
  if (head.kind !== 'branch') return { branch: null, oid: null };

  const ref = repository.readRef(head.ref);
  const oid = ref.kind === 'present' && ref.value.kind === 'oid' ? ref.value.oid : null;
  return { branch: head.branch, oid };
}

export function readProjectHeadState(projectRoot: string): ProjectHeadState {
  const inspected = discoverGitRepository(projectRoot);
  return inspected.kind === 'repository'
    ? readRepositoryHeadState(inspected.repository)
    : { branch: null, oid: null };
}
