import { describe, expect, test } from 'vitest';
import { createSystemActionsRoutes } from './system-actions-routes.ts';

function buildGroup() {
  return createSystemActionsRoutes({
    checkLocalOpSecurity: () => false,
  });
}

describe('createSystemActionsRoutes table', () => {
  test('registers exactly the client-logs path', () => {
    expect([...buildGroup().paths]).toEqual(['/api/client-logs']);
  });

  test('only client-logs reproduces legacy MUTATING_ROUTES membership', () => {
    const { table } = buildGroup();
    expect(table.isMutating('/api/client-logs')).toBe(true);
  });
});
