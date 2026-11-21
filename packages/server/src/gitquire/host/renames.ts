import type { HostRepo, HostRepoRecord, Refusal, RepoLookup } from './types.ts';

export type RepoChange =
  | { change: 'same' }
  | { change: 'renamed'; to: HostRepo }
  | { change: 'moved'; to: HostRepo; ownerId: number }
  | { change: 'mismatch' }
  | { change: 'gone' }
  | { change: 'refused'; refusal: Refusal }
  | { change: 'unreachable' };

export function repoChange(stored: HostRepoRecord, answer: RepoLookup): RepoChange {
  if (answer.state === 'gone') return { change: 'gone' };
  if (answer.state === 'unreachable') return { change: 'unreachable' };
  if (answer.state === 'refused') return { change: 'refused', refusal: answer.refusal };
  const current = answer.repo;
  if (current.host !== stored.host || current.id !== stored.id) return { change: 'mismatch' };
  const to = { owner: current.owner, name: current.name };
  if (current.ownerId !== stored.ownerId) return { change: 'moved', to, ownerId: current.ownerId };
  if (current.owner !== stored.owner || current.name !== stored.name) {
    return { change: 'renamed', to };
  }
  return { change: 'same' };
}
