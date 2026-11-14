import { DEFAULT_EMBEDDINGS_BASE_URL, DEFAULT_EMBEDDINGS_MODEL } from '@inkeep/open-knowledge-core';
import type { ResolvedSemanticConfig } from '../embeddings/semantic-config.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface DeploymentSemanticSearch {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function deploymentSemanticSearch(env: Env): DeploymentSemanticSearch | undefined {
  const switchValue = nonEmpty(env.GITQUIRE_SEMANTIC_SEARCH);
  if (switchValue === undefined && nonEmpty(env.GITQUIRE_REPO) === undefined) return undefined;
  return {
    enabled: ['on', 'true', '1', 'yes'].includes(switchValue?.toLowerCase() ?? ''),
    baseUrl: stripTrailingSlash(
      nonEmpty(env.GITQUIRE_EMBEDDINGS_URL) ?? DEFAULT_EMBEDDINGS_BASE_URL,
    ),
    model: nonEmpty(env.GITQUIRE_EMBEDDINGS_MODEL) ?? DEFAULT_EMBEDDINGS_MODEL,
    apiKey: nonEmpty(env.GITQUIRE_EMBEDDINGS_API_KEY),
  };
}

export function withDeploymentSemanticSearch(
  env: Env,
  config: ResolvedSemanticConfig,
): ResolvedSemanticConfig {
  const deployment = deploymentSemanticSearch(env);
  if (deployment === undefined) return config;
  const sameProvider =
    stripTrailingSlash(config.baseUrl) === deployment.baseUrl && config.model === deployment.model;
  return {
    ...config,
    enabled: deployment.enabled,
    baseUrl: deployment.baseUrl,
    model: deployment.model,
    dimensions: sameProvider ? config.dimensions : undefined,
  };
}

export function deploymentEmbeddingsKey(env: Env, baseUrl: string): string | undefined {
  const deployment = deploymentSemanticSearch(env);
  if (deployment?.apiKey === undefined) return undefined;
  return stripTrailingSlash(baseUrl) === deployment.baseUrl ? deployment.apiKey : undefined;
}
