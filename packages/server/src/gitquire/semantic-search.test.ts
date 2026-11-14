import { DEFAULT_EMBEDDINGS_BASE_URL, DEFAULT_EMBEDDINGS_MODEL } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import type { ResolvedSemanticConfig } from '../embeddings/semantic-config.ts';
import {
  deploymentEmbeddingsKey,
  deploymentSemanticSearch,
  withDeploymentSemanticSearch,
} from './semantic-search.ts';

const fromConfigFile: ResolvedSemanticConfig = {
  enabled: true,
  baseUrl: 'http://localhost:11434/v1',
  model: 'nomic-embed-text',
  dimensions: 768,
  similarityFloor: 0.3,
  maxBatchSize: 64,
  maxBatchChars: 100_000,
  docTimeoutMs: 30_000,
};

describe('deploymentSemanticSearch', () => {
  test('leaves a plain local install alone', () => {
    expect(deploymentSemanticSearch({})).toBeUndefined();
    expect(withDeploymentSemanticSearch({}, fromConfigFile)).toEqual(fromConfigFile);
  });

  test('is off by default in a deployment, whatever the config file says', () => {
    const resolved = withDeploymentSemanticSearch({ GITQUIRE_REPO: 'acme/wiki' }, fromConfigFile);
    expect(resolved.enabled).toBe(false);
    expect(resolved.baseUrl).toBe(DEFAULT_EMBEDDINGS_BASE_URL);
    expect(resolved.model).toBe(DEFAULT_EMBEDDINGS_MODEL);
    expect(resolved.dimensions).toBeUndefined();
    expect(resolved.similarityFloor).toBe(0.3);
    expect(resolved.maxBatchSize).toBe(64);
  });

  test('takes the provider from the environment', () => {
    const env = {
      GITQUIRE_SEMANTIC_SEARCH: 'on',
      GITQUIRE_EMBEDDINGS_URL: 'http://localhost:11434/v1/',
      GITQUIRE_EMBEDDINGS_MODEL: 'nomic-embed-text',
    };
    const resolved = withDeploymentSemanticSearch(env, fromConfigFile);
    expect(resolved.enabled).toBe(true);
    expect(resolved.baseUrl).toBe('http://localhost:11434/v1');
    expect(resolved.model).toBe('nomic-embed-text');
    expect(resolved.dimensions).toBe(768);
  });

  test('accepts the usual spellings of on', () => {
    for (const value of ['on', 'ON', 'true', '1', 'yes']) {
      expect(deploymentSemanticSearch({ GITQUIRE_SEMANTIC_SEARCH: value })?.enabled).toBe(true);
    }
    expect(deploymentSemanticSearch({ GITQUIRE_SEMANTIC_SEARCH: 'off' })?.enabled).toBe(false);
  });
});

describe('deploymentEmbeddingsKey', () => {
  test('sends the key only to the configured provider', () => {
    const env = { GITQUIRE_SEMANTIC_SEARCH: 'on', GITQUIRE_EMBEDDINGS_API_KEY: ' sk-team ' };
    expect(deploymentEmbeddingsKey(env, DEFAULT_EMBEDDINGS_BASE_URL)).toBe('sk-team');
    expect(deploymentEmbeddingsKey(env, `${DEFAULT_EMBEDDINGS_BASE_URL}/`)).toBe('sk-team');
    expect(deploymentEmbeddingsKey(env, 'https://elsewhere.example/v1')).toBeUndefined();
  });

  test('is absent without a key', () => {
    expect(
      deploymentEmbeddingsKey({ GITQUIRE_REPO: 'acme/wiki' }, DEFAULT_EMBEDDINGS_BASE_URL),
    ).toBe(undefined);
  });
});
