import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { deriveChatKeySecret } from '../chat/key-secret.ts';
import { chatKeysDir, createChatKeyStore } from '../chat/key-store.ts';
import { CHAT_PROVIDERS } from '../chat/models.ts';
import { draftsDir } from '../drafts/store.ts';
import type { DoorHost, HostRepo, HostRepoRecord, RepoLookup } from '../host/types.ts';
import { type RunGit, runGitSync } from '../repo-bootstrap.ts';
import { type AllowedOwners, ownerAllowed, pinAllowedOwner } from './allowed-owners.ts';
import { openRepoTokenStore, repoTokensFile } from './repo-tokens.ts';
import type { FrontDoorSettings } from './settings.ts';
import { openWikiTable, wikiDir, wikiKey, wikiTableFile } from './wiki-table.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const MOVING_IN = '.gitquire-moving-in';
const MOVING_BACK = '.gitquire-moving-back';
const LEFT_AT_ROOT = new Set(['lost+found']);
const ADDED_BY = 'gitquire wikis adopt';
const KEYS_BEFORE_WIKIS = '.before-wikis';

export class MoveOverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoveOverError';
  }
}

export type MoveOverSettings = Pick<
  FrontDoorSettings,
  'host' | 'dataDir' | 'sessionSecret' | 'defaultWiki' | 'allowedOwners'
>;

export type RepoTokenCheck = (repo: HostRepoRecord, token: string) => Promise<string>;

export interface MoveOverDeps {
  settings: MoveOverSettings;
  env: Env;
  running: (dir: string) => string | undefined;
  runGit?: RunGit;
  now?: () => number;
}

export interface AdoptDeps extends MoveOverDeps {
  host: Pick<DoorHost, 'repoByName'>;
  repoToken?: string;
  checkRepoToken?: RepoTokenCheck;
}

export interface MoveOverOptions {
  dryRun: boolean;
  force: boolean;
}

export interface MoveOverReport {
  changed: boolean;
  wiki?: string;
  key?: string;
  steps: string[];
  warnings: string[];
}

function entries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function stampOf(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

function moveEntries(from: string, to: string, skip: ReadonlySet<string>): number {
  mkdirSync(to, { recursive: true });
  let moved = 0;
  for (const name of entries(from)) {
    if (skip.has(name)) continue;
    if (existsSync(join(to, name))) {
      throw new MoveOverError(
        `Cannot move ${join(from, name)}: ${join(to, name)} already exists. Nothing was overwritten; move one of them aside and run the command again.`,
      );
    }
    renameSync(join(from, name), join(to, name));
    moved += 1;
  }
  return moved;
}

function unpushedWork(dir: string, runGit: RunGit = runGitSync): string[] {
  const found: string[] = [];
  let status: string;
  try {
    status = runGit(['status', '--porcelain'], dir);
  } catch (err) {
    return [`${dir}: git status failed (${err instanceof Error ? err.message : String(err)})`];
  }
  const changed = status.split('\n').filter((line) => line.trim() !== '').length;
  if (changed > 0) found.push(`${dir}: ${changed} uncommitted change${changed === 1 ? '' : 's'}`);
  try {
    const ahead = Number(runGit(['rev-list', '--count', '@{upstream}..HEAD'], dir).trim());
    if (ahead > 0) found.push(`${dir}: ${ahead} commit${ahead === 1 ? '' : 's'} not pushed`);
  } catch {
    found.push(`${dir}: the branch has no upstream on the host to compare with`);
  }
  return found;
}

function draftCopies(root: string, inner: string): Array<{ slug: string; dir: string }> {
  return entries(root)
    .filter((slug) => isDir(join(root, slug, inner, '.git')))
    .map((slug) => ({ slug, dir: join(root, slug, inner) }));
}

function originMatches(dir: string, names: readonly HostRepo[], runGit: RunGit): boolean {
  let url: string;
  try {
    url = runGit(['remote', 'get-url', 'origin'], dir).trim();
  } catch {
    return false;
  }
  const path = url
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return names.some((name) =>
    path.endsWith(`/${name.owner.toLowerCase()}/${name.name.toLowerCase()}`),
  );
}

function copyWhole(from: string, to: string): void {
  const partial = `${to}.partial`;
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(partial)) {
    let n = 1;
    while (existsSync(`${to}.interrupted-${n}`)) n += 1;
    renameSync(partial, `${to}.interrupted-${n}`);
  }
  cpSync(from, partial, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  renameSync(partial, to);
}

function keysSealedWith(projectDir: string, secret: string): number {
  const store = createChatKeyStore(projectDir, secret);
  let count = 0;
  for (const file of entries(chatKeysDir(projectDir))) {
    const match = /^(\d+)\.json$/.exec(file);
    if (match === null) continue;
    for (const provider of CHAT_PROVIDERS) {
      if (store.get(Number(match[1]), provider) !== undefined) count += 1;
    }
  }
  return count;
}

function resealKeys(projectDir: string, fromSecret: string, toSecret: string): number {
  const dir = chatKeysDir(projectDir);
  const from = createChatKeyStore(projectDir, fromSecret);
  const to = createChatKeyStore(projectDir, toSecret);
  let count = 0;
  for (const file of entries(dir)) {
    const match = /^(\d+)\.json$/.exec(file);
    if (match === null) continue;
    const userId = Number(match[1]);
    const info = from.info(userId);
    const keys = CHAT_PROVIDERS.flatMap((provider) => {
      const key = from.get(userId, provider);
      return key === undefined ? [] : [{ provider, key, savedAt: info[provider].savedAt }];
    });
    for (const { provider, key, savedAt } of keys) {
      to.set(userId, provider, key, savedAt === null ? new Date() : new Date(savedAt));
      count += 1;
    }
  }
  return count;
}

function agentTokensFileFor(env: Env, projectDir: string): string {
  const override = env.GITQUIRE_AGENT_TOKENS_FILE?.trim();
  if (override !== undefined && override !== '') return override;
  return join(projectDir, '.gitquire', 'local', 'gitquire', 'agent-tokens.json');
}

function doorAgentTokensFile(dataDir: string): string {
  return join(dataDir, 'server', 'agent-tokens.json');
}

function describeLookup(answer: Exclude<RepoLookup, { state: 'found' }>): string {
  if (answer.state === 'gone')
    return "GitQuire's own access cannot see it (app not installed, bot not on the repository, or no such repository)";
  if (answer.state === 'unreachable') return 'the host cannot be reached; try again later';
  return `the host refused GitQuire's own token (${answer.refusal})`;
}

function tokensAt(env: Env, dataDir: string, root: string): string {
  const path = agentTokensFileFor(env, dataDir);
  return inside(dataDir, path) ? join(root, relative(dataDir, path)) : path;
}

export async function adoptSingleWiki(
  deps: AdoptDeps,
  options: MoveOverOptions,
): Promise<MoveOverReport> {
  const { settings, env } = deps;
  const runGit = deps.runGit ?? runGitSync;
  const now = deps.now ?? Date.now;
  const dataDir = resolve(settings.dataDir);
  const steps: string[] = [];
  const warnings: string[] = [];
  const named = settings.defaultWiki;
  if (named === undefined) {
    throw new MoveOverError(
      'Set GITQUIRE_REPO to the repository of the wiki in this volume; it becomes the first wiki and the default one.',
    );
  }
  const staging = join(dataDir, MOVING_IN);
  const tableFile = wikiTableFile(dataDir);
  const table = existsSync(tableFile) ? openWikiTable(tableFile) : undefined;
  const checkout = existsSync(join(dataDir, '.git'));
  const resuming = existsSync(staging);
  if (checkout && table !== undefined) {
    throw new MoveOverError(
      `${dataDir} holds both a single wiki's checkout (.git) and a wiki table (server/wikis.json). Nothing was changed; look at the volume before running this again.`,
    );
  }
  for (const dir of [dataDir, staging]) {
    const holder = existsSync(dir) ? deps.running(dir) : undefined;
    if (holder !== undefined) {
      throw new MoveOverError(
        `GitQuire is still running on ${dir} (${holder}). Stop the container first, then run this with "docker compose run".`,
      );
    }
  }

  const answer = await deps.host.repoByName(named);
  if (answer.state !== 'found') {
    throw new MoveOverError(
      `Cannot look up ${named.owner}/${named.name} on the host: ${describeLookup(answer)}. Nothing was changed.`,
    );
  }
  const repo = answer.repo;
  if (repo.host !== settings.host) {
    throw new MoveOverError(`${named.owner}/${named.name} is not on ${settings.host}.`);
  }
  const key = wikiKey(repo);
  const target = wikiDir(dataDir, { key });
  const owners: AllowedOwners = {
    names: settings.allowedOwners,
    pinned: () => table?.ownerIds() ?? {},
    pin: () => {},
  };
  if (!ownerAllowed(owners, repo)) {
    throw new MoveOverError(
      `${repo.owner}/${repo.name} is under ${repo.owner}, which is not an allowed owner (${[...settings.allowedOwners].join(', ')}). Add it to GITQUIRE_ALLOWED_OWNERS first. Nothing was changed.`,
    );
  }
  const moved = !checkout && !resuming && isDir(join(target, '.git'));
  if (!checkout && !resuming && !moved) {
    throw new MoveOverError(
      `${dataDir} has no single wiki to move (no .git), and ${target} does not hold one either.`,
    );
  }
  if (resuming && existsSync(target)) {
    throw new MoveOverError(
      `Both ${staging} and ${target} exist. Nothing was changed; look at the volume before running this again.`,
    );
  }
  const source = checkout ? dataDir : resuming ? staging : target;
  const holder = isDir(target) ? deps.running(target) : undefined;
  if (holder !== undefined) {
    throw new MoveOverError(`GitQuire is still running on ${target} (${holder}). Stop it first.`);
  }
  if (isDir(join(source, '.git')) && !originMatches(source, [named, repo], runGit)) {
    throw new MoveOverError(
      `The checkout in ${source} is not a clone of ${named.owner}/${named.name}: its origin points elsewhere. Nothing was changed.`,
    );
  }

  const singleDrafts = draftsDir(dataDir, env);
  const targetDrafts = draftsDir(target, {});
  const draftsInside = inside(dataDir, singleDrafts);
  if (draftsInside && existsSync(singleDrafts)) {
    warnings.push(
      `GITQUIRE_DRAFTS_DIR (${singleDrafts}) is inside ${dataDir}; its draft working copies are not copied. The drafts stay on the host and open again from their branches.`,
    );
  }
  const drafts = (draftsInside ? [] : draftCopies(singleDrafts, basename(dataDir))).filter(
    (draft) => !existsSync(join(targetDrafts, draft.slug, key)),
  );

  if (!moved) {
    const unpushed = [
      ...(isDir(join(source, '.git')) ? unpushedWork(source, runGit) : []),
      ...drafts.flatMap((draft) => unpushedWork(draft.dir, runGit)),
    ];
    if (unpushed.length > 0 && !options.force) {
      throw new MoveOverError(
        `Not everything is pushed to the host:\n- ${unpushed.join('\n- ')}\nStart the single wiki again and let it push, or pass --force: the edits then move along and the wiki pushes them behind the front door. Nothing was changed.`,
      );
    }
    if (unpushed.length > 0)
      warnings.push(`Moving with --force although not pushed: ${unpushed.join('; ')}`);
  }

  const keysBackup = `${chatKeysDir(target)}${KEYS_BEFORE_WIKIS}`;
  const reseal = keysSealedWith(source, settings.sessionSecret) > 0;
  const doorTokens = doorAgentTokensFile(dataDir);
  const copyTokens = !existsSync(doorTokens) && existsSync(tokensAt(env, dataDir, source));
  const tokenStoreFile = repoTokensFile(dataDir);
  const forgejo = settings.host === 'forgejo';
  const storedToken =
    forgejo &&
    existsSync(tokenStoreFile) &&
    openRepoTokenStore(tokenStoreFile, () => undefined).has(key);
  const storeToken = forgejo && !storedToken && deps.repoToken !== undefined;
  if (forgejo && !storedToken && deps.repoToken === undefined) {
    warnings.push(
      'GITQUIRE_HOST_REPO_TOKEN is not set, so this wiki has no token of its own yet: it shows as disconnected until a server administrator enters one in the wiki list.',
    );
  }
  const record = table?.byKey(key) === undefined;

  if (!moved) {
    steps.push(
      `Move every entry of ${dataDir}${resuming ? ` that is not yet in ${staging}` : ''} (except lost+found) into ${target}.`,
    );
  }
  for (const draft of drafts) {
    steps.push(
      `Copy the draft working copy ${draft.dir} to ${join(targetDrafts, draft.slug, key)}; the original stays.`,
    );
  }
  if (reseal) {
    steps.push(`Re-seal the saved AI keys for this wiki; the old ones stay in ${keysBackup}.`);
  }
  if (copyTokens) {
    steps.push(
      `Copy the agent tokens to the front door's store ${doorTokens}; the original stays.`,
    );
  }
  if (storeToken) {
    steps.push(
      `Check GITQUIRE_HOST_REPO_TOKEN and keep it as this wiki's token in ${tokenStoreFile}.`,
    );
  }
  if (record) steps.push(`Add ${repo.owner}/${repo.name} as the wiki ${key} to ${tableFile}.`);
  const report = (changed: boolean): MoveOverReport => ({
    changed,
    wiki: `${repo.owner}/${repo.name}`,
    key,
    steps,
    warnings,
  });
  if (steps.length === 0) {
    steps.push(`${repo.owner}/${repo.name} is already moved over; nothing to do.`);
    return report(false);
  }
  if (options.dryRun) {
    steps.unshift('Dry run, nothing was changed. These steps would run:');
    return report(false);
  }

  if (!moved) {
    const emptyWikis =
      isDir(join(dataDir, 'wikis')) && entries(join(dataDir, 'wikis')).length === 0;
    const skip = new Set([
      MOVING_IN,
      ...LEFT_AT_ROOT,
      ...(resuming && emptyWikis ? ['wikis'] : []),
    ]);
    moveEntries(dataDir, staging, skip);
    mkdirSync(join(dataDir, 'wikis'), { recursive: true });
    renameSync(staging, target);
  }
  for (const draft of drafts) copyWhole(draft.dir, join(targetDrafts, draft.slug, key));
  if (reseal) {
    if (!existsSync(keysBackup)) copyWhole(chatKeysDir(target), keysBackup);
    const count = resealKeys(
      target,
      settings.sessionSecret,
      deriveChatKeySecret(settings.sessionSecret, key),
    );
    steps.push(`Re-sealed ${count} AI key${count === 1 ? '' : 's'}.`);
  }
  mkdirSync(join(dataDir, 'server'), { recursive: true, mode: 0o700 });
  chmodSync(join(dataDir, 'server'), 0o700);
  if (copyTokens) {
    copyFileSync(tokensAt(env, dataDir, target), doorTokens);
    chmodSync(doorTokens, 0o600);
  }
  if (storeToken && deps.repoToken !== undefined) {
    const verdict =
      deps.checkRepoToken === undefined
        ? 'it could not be checked'
        : await deps.checkRepoToken(repo, deps.repoToken);
    if (verdict === 'ok') {
      openRepoTokenStore(tokenStoreFile, () => undefined).set(key, deps.repoToken);
    } else {
      warnings.push(
        `GITQUIRE_HOST_REPO_TOKEN was not kept (${verdict}). The wiki shows as disconnected until a server administrator enters a token limited to ${repo.owner}/${repo.name} in the wiki list.`,
      );
    }
  }
  if (record) {
    const finalTable = table ?? openWikiTable(tableFile);
    pinAllowedOwner(
      { names: settings.allowedOwners, pinned: finalTable.ownerIds, pin: finalTable.pinOwner },
      repo,
    );
    finalTable.add(repo, ADDED_BY, now());
  }
  return report(true);
}

export async function unadoptWiki(
  deps: MoveOverDeps,
  options: MoveOverOptions,
): Promise<MoveOverReport> {
  const { settings, env } = deps;
  const runGit = deps.runGit ?? runGitSync;
  const now = deps.now ?? Date.now;
  const dataDir = resolve(settings.dataDir);
  const steps: string[] = [];
  const warnings: string[] = [];
  const back = join(dataDir, MOVING_BACK);
  const resuming = existsSync(back);
  if (!resuming && existsSync(join(dataDir, '.git')) && !existsSync(wikiTableFile(dataDir))) {
    steps.push(`${dataDir} already holds a single wiki.`);
    return { changed: false, steps, warnings };
  }
  const serverDir = resuming ? join(back, 'server') : join(dataDir, 'server');
  const wikisDir = resuming ? join(back, 'wikis') : join(dataDir, 'wikis');
  const tableFile = join(serverDir, 'wikis.json');
  if (!existsSync(tableFile)) {
    throw new MoveOverError(
      `${dataDir} holds no wiki table (server/wikis.json); there is nothing to move back.`,
    );
  }
  const wikis = openWikiTable(tableFile).list();
  if (wikis.length !== 1) {
    throw new MoveOverError(
      `The way back works for a server with exactly one wiki; this one has ${wikis.length} (${wikis.map((wiki) => `${wiki.owner}/${wiki.name}`).join(', ')}). Nothing was changed.`,
    );
  }
  const wiki = wikis[0];
  const key = wiki.key;
  const source = join(wikisDir, key);
  if (!resuming && !isDir(join(source, '.git'))) {
    throw new MoveOverError(`${source} holds no checkout. Nothing was changed.`);
  }
  if (!resuming) {
    const extra = entries(dataDir).filter(
      (name) => !['server', 'wikis', ...LEFT_AT_ROOT].includes(name),
    );
    if (extra.length > 0) {
      throw new MoveOverError(
        `${dataDir} holds more than the front door's server/ and wikis/: ${extra.join(', ')}. Nothing was changed; move them aside first.`,
      );
    }
    const otherFolders = entries(wikisDir).filter(
      (name) => name !== key && name !== '.gitquire-drafts',
    );
    if (otherFolders.length > 0) {
      throw new MoveOverError(
        `${wikisDir} holds other wiki folders (${otherFolders.join(', ')}). Nothing was changed.`,
      );
    }
  }
  for (const dir of [source, dataDir]) {
    const holder = isDir(dir) ? deps.running(dir) : undefined;
    if (holder !== undefined) {
      throw new MoveOverError(
        `GitQuire is still running on ${dir} (${holder}). Stop the container first.`,
      );
    }
  }
  const doorDrafts = draftsDir(source, {});
  const drafts = draftCopies(doorDrafts, key);
  if (!resuming) {
    const unpushed = [
      ...unpushedWork(source, runGit),
      ...drafts.flatMap((draft) => unpushedWork(draft.dir, runGit)),
    ];
    if (unpushed.length > 0) {
      if (!options.force) {
        throw new MoveOverError(
          `Not everything is pushed to the host:\n- ${unpushed.join('\n- ')}\nStart the front door again and let the wiki push, or pass --force. Nothing was changed.`,
        );
      }
      warnings.push(`Moved back with --force although not pushed: ${unpushed.join('; ')}`);
    }
  }
  const singleDrafts = draftsDir(dataDir, env);
  steps.push(
    `Move ${join(dataDir, 'server')} and ${join(dataDir, 'wikis')} to ${back}.`,
    `Move every entry of ${source} back into ${dataDir}.`,
    'Re-seal the saved AI keys with GITQUIRE_SESSION_SECRET again (a copy of the current ones stays beside them).',
    `Put the front door's agent tokens back as the single wiki's (an existing file is kept beside it).`,
    ...drafts.map(
      (draft) =>
        `Copy the draft working copy ${draft.dir} to ${join(singleDrafts, draft.slug, basename(dataDir))} (an existing one is kept beside it).`,
    ),
    `Keep the rest of the front door's files (the wiki table, Forgejo tokens, draft copies) in ${join(dataDir, '.gitquire', 'local', 'gitquire', 'several-wikis-<time>')}.`,
  );
  if (settings.host === 'forgejo') {
    warnings.push(
      "The single wiki needs GITQUIRE_HOST_REPO_TOKEN again; the front door's copy stays in the kept server/repo-tokens.json.",
    );
  }
  if (options.dryRun) {
    steps.unshift('Dry run: nothing was changed. These steps would run:');
    return { changed: false, wiki: `${wiki.owner}/${wiki.name}`, key, steps, warnings };
  }

  const stampFile = join(back, 'moved-back-at');
  if (!resuming) {
    mkdirSync(back, { recursive: true });
    writeFileSync(stampFile, `${stampOf(now())}\n`);
    renameSync(join(dataDir, 'server'), join(back, 'server'));
    renameSync(join(dataDir, 'wikis'), join(back, 'wikis'));
  }
  const stamp = existsSync(stampFile) ? readFileSync(stampFile, 'utf8').trim() : stampOf(now());
  const from = join(back, 'wikis', key);
  moveEntries(from, dataDir, new Set());

  const keysDir = chatKeysDir(dataDir);
  const keysBackup = `${keysDir}.before-single-wiki-${stamp}`;
  const derived = deriveChatKeySecret(settings.sessionSecret, key);
  if (keysSealedWith(dataDir, derived) > 0) {
    if (!existsSync(keysBackup)) copyWhole(keysDir, keysBackup);
    resealKeys(dataDir, derived, settings.sessionSecret);
  }
  const doorTokens = doorAgentTokensFile(back);
  const singleTokens = agentTokensFileFor(env, dataDir);
  const tokensBackup = `${singleTokens}.before-single-wiki-${stamp}`;
  if (existsSync(doorTokens) && !existsSync(tokensBackup)) {
    if (existsSync(singleTokens)) renameSync(singleTokens, tokensBackup);
    mkdirSync(dirname(singleTokens), { recursive: true });
    copyFileSync(doorTokens, singleTokens);
    chmodSync(singleTokens, 0o600);
  }
  for (const draft of draftCopies(draftsDir(from, {}), key)) {
    const to = join(singleDrafts, draft.slug, basename(dataDir));
    const aside = `${join(singleDrafts, draft.slug)}.before-single-wiki-${stamp}`;
    if (existsSync(aside) && existsSync(to)) continue;
    if (!existsSync(aside) && existsSync(join(singleDrafts, draft.slug))) {
      renameSync(join(singleDrafts, draft.slug), aside);
    }
    copyWhole(draft.dir, to);
  }
  const kept = join(dataDir, '.gitquire', 'local', 'gitquire', `several-wikis-${stamp}`);
  mkdirSync(dirname(kept), { recursive: true });
  renameSync(back, kept);
  steps.push(`Kept the front door's files in ${kept}.`);
  return { changed: true, wiki: `${wiki.owner}/${wiki.name}`, key, steps, warnings };
}
