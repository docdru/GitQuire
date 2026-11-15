export interface SeedPlanWorkShape {
  created: readonly unknown[];
  requiredPlugins?: readonly { pending: boolean }[];
}

export function planHasOutstandingWork(plan: SeedPlanWorkShape): boolean {
  return plan.created.length > 0 || plan.requiredPlugins?.some((plugin) => plugin.pending) === true;
}
