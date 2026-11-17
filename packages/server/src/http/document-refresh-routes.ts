import {
  DocumentRefreshRequestSchema,
  DocumentRefreshSuccessSchema,
  type DocumentRereadSuccess,
  DocumentRereadSuccessSchema,
  EmptyRequestSchema,
} from '@gitquire/core';
import type { RefreshDocumentsFromDisk } from '../document-refresh.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface DocumentRefreshRouteDeps {
  refreshDocumentsFromDisk: RefreshDocumentsFromDisk;
  rereadFromDisk?: () => Promise<DocumentRereadSuccess>;
}

export function createDocumentRefreshRoutes(deps: DocumentRefreshRouteDeps): ApiRouteGroup {
  const handleDocumentRefresh = withValidation(
    DocumentRefreshRequestSchema,
    async (_req, res, body) => {
      try {
        const result = await deps.refreshDocumentsFromDisk(body.docNames, 'focus');
        successResponse(res, 200, DocumentRefreshSuccessSchema, result, {
          handler: 'document-refresh',
        });
      } catch (err) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to re-read the documents from disk.',
          { handler: 'document-refresh', cause: err },
        );
      }
    },
    { handler: 'document-refresh', method: 'POST' },
  );

  const handleDocumentReread = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      const reread = deps.rereadFromDisk;
      if (reread === undefined) {
        errorResponse(
          res,
          503,
          'urn:ok:error:file-rescan-not-configured',
          'Re-reading from disk is not configured.',
          { handler: 'document-reread' },
        );
        return;
      }
      try {
        successResponse(res, 200, DocumentRereadSuccessSchema, await reread(), {
          handler: 'document-reread',
        });
      } catch (err) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to re-read the content folder.',
          { handler: 'document-reread', cause: err },
        );
      }
    },
    { handler: 'document-reread', method: 'POST' },
  );

  return createApiRouteGroup(
    {
      '/api/documents/refresh': handleDocumentRefresh,
      '/api/documents/reread': handleDocumentReread,
    },
    { mutating: ['/api/documents/refresh', '/api/documents/reread'] },
  );
}
