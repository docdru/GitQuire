// biome-ignore-all assist/source/organizeImports: each import form is a separate positive or negative case; merging or reordering them would erase cases and shift the asserted positions
// FIXTURE — drives `no-app-core-barrel-import.uncached.test.mjs` via shell-out to oxlint.
// Not part of the main lint: `__fixtures__/` is in `oxlint.config.ts#ignorePatterns`, and
// `__fixtures__/oxlint.fixtures.json` re-enables the rules for the test.
//
// Positive cases (one per line, each prefixed `p`): every module-reference form that names
// the bare core barrel, with or without a `?query` or `#hash` suffix. Negative cases (prefixed `n`): the adjacent shapes the rule must NOT
// match — declared subpaths, sibling packages sharing the prefix, the barrel name inside a
// string or a comment, and non-literal or member-call loads.

// === Positive cases — must fire ===

import { sharedExtensions } from '@gitquire/core'; // p value
import type { LinterConfig } from '@gitquire/core'; // p whole-declaration type
import { THEME_PLUGINS, type ThemePlugin } from '@gitquire/core'; // p mixed
import * as coreNamespace from '@gitquire/core'; // p namespace
import '@gitquire/core'; // p side-effect
import coreDefault from '@gitquire/core'; // p default
import coreRequired = require('@gitquire/core'); // p TS import-equals
export { FORM_WRITE_ORIGIN } from '@gitquire/core'; // p named re-export
export type { ConfigSchema } from '@gitquire/core'; // p type re-export
export * from '@gitquire/core'; // p star re-export
export * as coreStar from '@gitquire/core'; // p star-as re-export
export type CoreModule = typeof import('@gitquire/core'); // p typeof import type
export type CoreLinter = import('@gitquire/core').LinterConfig; // p import type
export const pDynamic = () => import('@gitquire/core'); // p literal dynamic import
export const pTemplate = () => import(`@gitquire/core`); // p template, no expressions
export const pRequire = () => require('@gitquire/core'); // p literal require
import coreRaw from '@gitquire/core?raw'; // p query suffix
import '@gitquire/core?v=1'; // p cache-busting query on a side-effect import
export const pHash = () => import('@gitquire/core#entry'); // p hash suffix

// === Negative cases — must NOT fire ===

import { getGitHubStars } from '@gitquire/core/utils/github-stars'; // n subpath
import type { CheckpointKind } from '@gitquire/core/constants/checkpoint-kinds'; // n type subpath
import { startServer } from '@gitquire/core/server'; // n pre-existing subpath
import { bootServer } from '@gitquire/server'; // n sibling package
import { cliMain } from '@gitquire/cli'; // n prefix of the barrel name
import { extra } from '@gitquire/core-extra'; // n longer package sharing the prefix
export { CC1_CONTRACT_VERSION } from '@gitquire/core/constants/cc1'; // n subpath re-export
export * from '@gitquire/core/bridge'; // n subpath star re-export
export type BridgeModule = typeof import('@gitquire/core/bridge'); // n subpath import type
export const nDynamic = () => import('@gitquire/core/markdown/lint'); // n subpath dynamic import
export const nRequire = () => require('@gitquire/core/bridge'); // n subpath require
import bridgeRaw from '@gitquire/core/bridge?raw'; // n subpath with a query suffix
import extraVersioned from '@gitquire/core-extra?v=1'; // n longer package with a query suffix
export const nString = '@gitquire/core'; // n ordinary string literal
export const nMessage = `install @gitquire/core`; // n template containing the name
// n the comment names '@gitquire/core' and must not fire
export const nComputed = (suffix: string) => import(`@gitquire/core${suffix}`); // n computed
export const nMember = (loader: { require(id: string): unknown }) =>
  loader.require('@gitquire/core'); // n member call, not the require builtin

export const used = [
  sharedExtensions,
  THEME_PLUGINS,
  coreNamespace,
  coreDefault,
  coreRequired,
  coreRaw,
  bridgeRaw,
  extraVersioned,
  getGitHubStars,
  startServer,
  bootServer,
  cliMain,
  extra,
];
export type UsedType = LinterConfig | ThemePlugin | CheckpointKind;
