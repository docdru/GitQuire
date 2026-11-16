import type { AgentWriteOutcomeFields, ProblemType, ReconcileMergeOutcome } from '@gitquire/core';
import {
  GQ_DOC_MOVED,
  GQ_DOC_REMOVED,
  GQ_PATH_UNRESOLVABLE,
  GQ_SERVER_STOPPED,
  GQ_STORE_DISCARDED,
  GQ_STORE_HELD,
  GQ_STORE_REFUSED,
  GQ_WRITE_DROPPED,
  GQ_WRITE_REPLACED,
  type HeldSaveReason,
  type StoreFailure,
} from './document-durability-state.ts';

const APPLIED: AgentWriteOutcomeFields = {
  outcome: 'applied',
  saved: true,
  nextStep: 'none',
};

const APPLIED_WITH_DIVERGENCE: AgentWriteOutcomeFields = {
  outcome: 'applied',
  saved: true,
  nextStep: 're-read',
};

const MERGED_FIRST: AgentWriteOutcomeFields = {
  outcome: 'merged-first',
  saved: true,
  nextStep: 're-read',
};

const BOTH_KEPT: AgentWriteOutcomeFields = {
  outcome: 'both-kept',
  saved: true,
  nextStep: 're-read',
};

const PROJECTION_HELD: AgentWriteOutcomeFields = {
  outcome: 'projection-held',
  saved: false,
  nextStep: 're-read',
};

const REFUSED_RETRY: AgentWriteOutcomeFields = {
  outcome: 'refused',
  saved: false,
  nextStep: 'retry',
};

const REFUSED_RE_READ: AgentWriteOutcomeFields = {
  outcome: 'refused',
  saved: false,
  nextStep: 're-read',
};

const REFUSED_NONE: AgentWriteOutcomeFields = {
  outcome: 'refused',
  saved: false,
  nextStep: 'none',
};

const HELD_SAVE_OUTCOMES: Readonly<Record<HeldSaveReason, AgentWriteOutcomeFields>> = {
  'pending-unreadable': PROJECTION_HELD,
  'pending-exhausted': PROJECTION_HELD,
  'pending-base-moved': PROJECTION_HELD,
  'pending-no-intake': PROJECTION_HELD,
  'pending-intake-failed': PROJECTION_HELD,
  'pending-intake-failed-no-base': PROJECTION_HELD,
  'pending-conflict': REFUSED_NONE,
  'pending-unsettled': PROJECTION_HELD,
  'pending-rename': PROJECTION_HELD,
  'pending-no-history-or-backup': PROJECTION_HELD,
  'pending-not-utf8': REFUSED_NONE,
};

export function heldSaveEndsOnlyByAPerson(reason: HeldSaveReason): boolean {
  return HELD_SAVE_OUTCOMES[reason].nextStep === 'none';
}

export const REFUSAL_OUTCOMES = {
  'urn:ok:error:concurrent-overwrite-refused': REFUSED_RETRY,
  'urn:ok:error:too-many-agent-sessions': REFUSED_RETRY,
  'urn:ok:error:doc-not-found': REFUSED_RETRY,
  'urn:ok:error:reserved-doc-name': REFUSED_RETRY,
  'urn:ok:error:frontmatter-malformed': REFUSED_RETRY,
  'urn:ok:error:frontmatter-edit-not-supported': REFUSED_RETRY,
  'urn:ok:error:invalid-frontmatter-patch': REFUSED_RETRY,
  'urn:ok:error:target-not-found': REFUSED_RE_READ,
  'urn:ok:error:stale-target': REFUSED_RE_READ,
  'urn:ok:error:doc-in-conflict': REFUSED_NONE,
  'urn:ok:error:stale-external-write': REFUSED_NONE,
} as const satisfies Partial<Record<ProblemType, AgentWriteOutcomeFields>>;

export function outcomeOfStoreFailure(failure: StoreFailure): AgentWriteOutcomeFields {
  switch (failure.code) {
    case GQ_STORE_HELD:
      return failure.held?.noBase === true
        ? REFUSED_NONE
        : HELD_SAVE_OUTCOMES[failure.held?.reason ?? 'pending-unreadable'];
    case GQ_DOC_MOVED:
    case GQ_STORE_DISCARDED:
      return PROJECTION_HELD;
    case GQ_DOC_REMOVED:
    case GQ_SERVER_STOPPED:
      return failure.removal?.kind === 'renamed' ? REFUSED_RE_READ : REFUSED_NONE;
    case GQ_PATH_UNRESOLVABLE:
      return REFUSED_NONE;
    case GQ_STORE_REFUSED:
    case GQ_WRITE_REPLACED:
      return REFUSED_RE_READ;
    case GQ_WRITE_DROPPED:
      if (failure.dropped === 'legacy-name') return REFUSED_RETRY;
      return failure.dropped === 'intake-landed' ? REFUSED_RE_READ : REFUSED_NONE;
    default:
      return REFUSED_RE_READ;
  }
}

export function answeredWithSuccessOnAppRoutes(failure: StoreFailure): boolean {
  return (
    failure.code === GQ_WRITE_REPLACED ||
    (failure.code === GQ_STORE_HELD &&
      (failure.held?.reason === 'pending-unsettled' || failure.held?.reason === 'pending-rename'))
  );
}

export type AgentWriteFlushOutcome =
  | { kind: 'failure'; failure: StoreFailure }
  | { kind: 'stale-external-write' }
  | { kind: 'taken-in'; merge: ReconcileMergeOutcome }
  | null;

export function outcomeOfSavedWrite(
  beforeWrite:
    | { readonly reconciled: boolean; readonly mergeOutcome?: ReconcileMergeOutcome }
    | undefined,
  flush: AgentWriteFlushOutcome,
  landedWithDivergence = false,
): AgentWriteOutcomeFields {
  if (flush?.kind === 'failure') return outcomeOfStoreFailure(flush.failure);
  if (flush?.kind === 'stale-external-write') {
    return REFUSAL_OUTCOMES['urn:ok:error:stale-external-write'];
  }
  const atSave = flush?.kind === 'taken-in' ? flush.merge : undefined;
  if (beforeWrite?.mergeOutcome === 'both-kept' || atSave === 'both-kept') return BOTH_KEPT;
  if (beforeWrite?.reconciled === true || atSave !== undefined) return MERGED_FIRST;
  return landedWithDivergence ? APPLIED_WITH_DIVERGENCE : APPLIED;
}
