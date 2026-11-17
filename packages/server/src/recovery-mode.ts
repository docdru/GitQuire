export const FRESHNESS_HASH_BUDGET = { files: 512, bytes: 64 * 1024 * 1024 } as const;

export type RecoveryMode = 'metadata' | 'full';
