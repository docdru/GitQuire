import { ProblemDetailsSchema } from '@gitquire/core/schemas/api';
import { t } from '@lingui/core/macro';
import type {
  GqPackId,
  GqScaffoldApplyResult,
  GqScaffoldPlan,
  GqSeedApplyResult,
  GqSeedError,
  GqSeedListPacksResult,
  GqSeedPackInfo,
  GqSeedPlanResult,
} from '@/lib/desktop-bridge-types';

async function translateSeedError(res: Response): Promise<GqSeedError> {
  const body = (await res.json().catch(() => null)) as unknown;
  const parsed = ProblemDetailsSchema.safeParse(body);
  if (!parsed.success) {
    return { kind: 'internal', message: `HTTP ${res.status}` };
  }
  const message = parsed.data.detail ?? parsed.data.title;
  const t = parsed.data.type;
  if (t === 'urn:ok:error:seed-prerequisite-missing') {
    return { kind: 'prerequisite-missing', message };
  }
  if (t === 'urn:ok:error:seed-invalid-root') {
    return { kind: 'invalid-root', message };
  }
  if (t === 'urn:ok:error:no-project-dir') {
    return { kind: 'no-project', message };
  }
  return { kind: 'internal', message };
}

interface SeedPlanOptions {
  rootDir?: string;
  packId?: GqPackId;
  preview?: { skillsInstallable: boolean };
}
interface SeedApplyOptions {
  packId?: GqPackId;
}

interface SeedClientShape {
  plan: (options?: SeedPlanOptions) => Promise<GqSeedPlanResult>;
  apply: (plan: GqScaffoldPlan, options?: SeedApplyOptions) => Promise<GqSeedApplyResult>;
  listPacks: () => Promise<GqSeedListPacksResult>;
}

export function seedClient(): SeedClientShape {
  return {
    plan: async (options?: SeedPlanOptions): Promise<GqSeedPlanResult> => {
      const params = new URLSearchParams();
      if (options?.rootDir) params.set('rootDir', options.rootDir);
      if (options?.packId) params.set('packId', options.packId);
      const qs = params.toString();
      const res = await fetch(`/api/seed/plan${qs ? `?${qs}` : ''}`);
      if (!res.ok) {
        return { ok: false, error: await translateSeedError(res) };
      }
      const body = (await res.json().catch(() => null)) as { plan?: GqScaffoldPlan } | null;
      if (!body?.plan) {
        return { ok: false, error: { kind: 'internal', message: t`Malformed plan response` } };
      }
      return { ok: true, plan: body.plan };
    },
    apply: async (plan: GqScaffoldPlan, options?: SeedApplyOptions): Promise<GqSeedApplyResult> => {
      const res = await fetch('/api/seed/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan,
          packId: options?.packId,
        }),
      });
      if (!res.ok) {
        return { ok: false, error: await translateSeedError(res) };
      }
      const body = (await res.json().catch(() => null)) as {
        result?: GqScaffoldApplyResult;
      } | null;
      if (!body?.result) {
        return { ok: false, error: { kind: 'internal', message: t`Malformed apply response` } };
      }
      return { ok: true, result: body.result };
    },
    listPacks: async (): Promise<GqSeedListPacksResult> => {
      const res = await fetch('/api/seed/packs');
      if (!res.ok) {
        return { ok: false, error: { kind: 'internal', message: `HTTP ${res.status}` } };
      }
      const body = (await res.json().catch(() => null)) as { packs?: GqSeedPackInfo[] } | null;
      if (!body || !Array.isArray(body.packs)) {
        return {
          ok: false,
          error: { kind: 'internal', message: t`Malformed listPacks response` },
        };
      }
      return { ok: true, packs: body.packs };
    },
  };
}
