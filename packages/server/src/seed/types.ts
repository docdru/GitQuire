import type { LintPluginId } from '@gitquire/core';
import type { PackId } from './starter.ts';

export interface FileEntry {
  path: string;
  kind: 'folder' | 'file';
  template?: string;
  contentPreview?: string;
}

export interface SkipEntry {
  path: string;
  reason: 'already-exists' | 'user-content' | 'glob-collision';
}

export interface ScaffoldPlan {
  created: FileEntry[];
  skipped: SkipEntry[];
  warnings: string[];
  requiredPlugins?: { id: LintPluginId; pending: boolean }[];
}

export interface ApplyResult {
  applied: number;
  errors: ApplyError[];
  durationMs: number;
  pluginsEnabled: LintPluginId[];
}

export interface ApplyError {
  path: string;
  error: string;
}

export interface SeedOptions {
  projectDir?: string;
  rootDir?: string;
  packId?: PackId;
  skipPrerequisite?: boolean;
}

export class SeedPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedPrerequisiteError';
  }
}

export class SeedRootDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedRootDirError';
  }
}
