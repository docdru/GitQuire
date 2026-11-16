import type { IncomingMessage, ServerResponse } from 'node:http';
import { ClientLogsRequestSchema, ClientLogsSuccessSchema } from '@gitquire/core';
import { getIngressContext } from '../ingress-policy.ts';
import { getLogger } from '../logger.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface SystemActionsRouteDeps {
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
}

export function createSystemActionsRoutes(deps: SystemActionsRouteDeps): ApiRouteGroup {
  const { checkLocalOpSecurity } = deps;

  const handleClientLogs = withValidation(
    ClientLogsRequestSchema,
    async (req, res, body) => {
      try {
        const logger = getLogger('renderer');
        const clientSurface = getIngressContext(req)?.clientSurface;
        const surfaceField = clientSurface === undefined ? {} : { clientSurface };
        if (body.droppedSinceLastFlush !== undefined && body.droppedSinceLastFlush > 0) {
          logger.warn(
            {
              source: 'renderer-console',
              transport: 'web',
              ...surfaceField,
              event: 'client-log-entries-dropped',
              droppedSinceLastFlush: body.droppedSinceLastFlush,
            },
            'client-log-entries-dropped',
          );
        }
        for (const entry of body.entries) {
          try {
            logger[entry.level](
              {
                ...entry.fields,
                source: 'renderer-console',
                transport: 'web',
                ...surfaceField,
                ...(entry.sourceId ? { sourceId: entry.sourceId } : {}),
                ...(entry.lineNumber !== undefined ? { lineNumber: entry.lineNumber } : {}),
                ...(entry.ts !== undefined ? { clientTs: entry.ts } : {}),
              },
              entry.event ?? entry.message,
            );
          } catch {}
        }
        successResponse(
          res,
          200,
          ClientLogsSuccessSchema,
          { accepted: body.entries.length },
          { handler: 'client-logs' },
        );
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'client-logs',
          cause: err,
        });
      }
    },
    {
      handler: 'client-logs',
      method: 'POST',
      preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: 'client-logs' }),
    },
  );

  return createApiRouteGroup(
    {
      '/api/client-logs': handleClientLogs,
    },
    { mutating: ['/api/client-logs'] },
  );
}
