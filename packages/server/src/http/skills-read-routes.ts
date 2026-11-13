import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  EmptyRequestSchema,
  isDetectedSkillInProject,
  isSkillOutsideOpenProject,
  SkillInstallStateSuccessSchema,
  SkillsInstalledSuccessSchema,
  TemplatesListSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { resolveProjectIdentity } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type { enumerateInstalledSkills } from '@inkeep/open-knowledge-core/skills-catalog';
import { resolveProjectTemplates } from '../content/templates-resolver.ts';
import { scanGlobalInPlaceSkillsAsync, scanInPlaceSkills } from '../in-place-skills.ts';
import { readSkillInstallStateSnapshot } from '../skill-state.ts';
import type { ApiRouteTable } from './api-pipeline.ts';
import { catchErrors } from './catch-errors.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface SkillsReadRouteDeps {
  contentDir: string;
  projectDir: string | undefined;
  homeDirOverride: string | undefined;
  skillsHome: string;
  enumerateInstalledSkillsCached: (
    opts: Parameters<typeof enumerateInstalledSkills>[0],
  ) => ReturnType<typeof enumerateInstalledSkills>;
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
}

export interface SkillsReadRoutes {
  paths: readonly string[];
  table: ApiRouteTable;
}

export function createSkillsReadRoutes(deps: SkillsReadRouteDeps): SkillsReadRoutes {
  const {
    contentDir,
    projectDir,
    homeDirOverride,
    skillsHome,
    enumerateInstalledSkillsCached,
    checkLocalOpSecurity,
  } = deps;

  const handleSkillsInstalled = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        const projectIdentity = resolveProjectIdentity(projectDir ?? contentDir);
        const physicalProjectDir = resolve(projectDir ?? contentDir);
        const globalInPlaceSkills = await scanGlobalInPlaceSkillsAsync(skillsHome);
        const catalog = enumerateInstalledSkillsCached({
          projectDir: projectIdentity,
          ...(homeDirOverride !== undefined ? { home: homeDirOverride } : {}),
        });
        const inPlaceNames = new Set(scanInPlaceSkills(contentDir).map((s) => s.name));
        const globalInPlaceNames = new Set(globalInPlaceSkills.map((s) => s.name));
        const result = {
          ...catalog,
          skills: catalog.skills
            .filter(
              (s) =>
                isDetectedSkillInProject(s.provenance, projectIdentity) &&
                !(s.provenance.scope === 'project'
                  ? inPlaceNames.has(s.name)
                  : globalInPlaceNames.has(s.name)),
            )
            .map((s) =>
              isSkillOutsideOpenProject(s.provenance, s.home, physicalProjectDir)
                ? { ...s, outsideProject: true }
                : s,
            ),
        };
        successResponse(res, 200, SkillsInstalledSuccessSchema, result, {
          handler: 'skills-installed',
        });
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to enumerate installed skills.',
          { handler: 'skills-installed', cause: e },
        );
      }
    },
    { handler: 'skills-installed', method: 'GET', skipBodyParse: true },
  );

  const handleTemplatesList = withValidation(
    EmptyRequestSchema,
    catchErrors(
      async (_req, res) => {
        const resolvedContentDir = resolve(contentDir);
        const result = await resolveProjectTemplates(resolvedContentDir);
        const templates = result.templates.map((t) => {
          const { scope: _scope, ...rest } = t;
          return rest;
        });
        successResponse(
          res,
          200,
          TemplatesListSuccessSchema,
          { templates, truncated: result.truncated },
          { handler: 'templates-list' },
        );
      },
      { handler: 'templates-list', title: 'Failed to list templates.' },
    ),
    { handler: 'templates-list', method: 'GET', skipBodyParse: true },
  );

  const handleSkillInstallState = withValidation(
    EmptyRequestSchema,
    catchErrors(
      async (_req, res) => {
        const snapshot = await readSkillInstallStateSnapshot(homedir());
        successResponse(
          res,
          200,
          SkillInstallStateSuccessSchema,
          { ...snapshot },
          {
            handler: 'skill-install-state',
            extraHeaders: { 'Cache-Control': 'no-store' },
          },
        );
      },
      { handler: 'skill-install-state', title: 'Failed to read skill install state.' },
    ),
    {
      handler: 'skill-install-state',
      method: 'GET',
      skipBodyParse: true,
      preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: 'skill-install-state' }),
    },
  );

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    '/api/skills/installed': handleSkillsInstalled,
    '/api/templates': handleTemplatesList,
    '/api/skill/install-state': handleSkillInstallState,
  };

  const table: ApiRouteTable = {
    resolve(url) {
      const handler = routes[url];
      if (handler) {
        return { template: url, dispatch: (req, res) => handler(req, res) };
      }
      return null;
    },
    isMutating: () => false,
  };

  return {
    paths: Object.keys(routes),
    table,
  };
}
