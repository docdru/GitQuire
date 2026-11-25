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
import { deriveChatKeySecret, derivePeopleKeySecret } from '../chat/key-secret.ts';
import { chatKeysDir, createChatKeyStore } from '../chat/key-store.ts';
import { CHAT_PROVIDERS } from '../chat/models.ts';
import { draftsDir } from '../drafts/store.ts';
import type { DoorHost, HostRepo, HostRepoRecord, RepoLookup } from '../host/types.ts';
import { personKeyStore } from '../people/chat-data.ts';
import { createPeopleMailer } from '../people/mailer.ts';
import {
  copyPeopleForWiki,
  markWikisMoved,
  movedWikis,
  movePeopleData,
  SINGLE_WIKI_KEY,
} from '../people/move-over.ts';
import { createPeopleStore, frontDoorPeopleRoot, singleWikiPeopleRoot } from '../people/store.ts';
import { type RunGit, runGitSync } from '../repo-bootstrap.ts';
import { FRONT_DOOR_LOCK, MOVING_BACK, MOVING_IN } from '../volume-markers.ts';
import { agentTokensFile } from './agents.ts';
import { type AllowedOwners, ownerAllowed, pinAllowedOwner } from './allowed-owners.ts';
import { createMentionCounts } from './mention-counts.ts';
import { openRepoTokenStore, repoTokensFile } from './repo-tokens.ts';
import type { FrontDoorSettings } from './settings.ts';
import { wikisModeFromEnv } from './settings.ts';
import { openWikiTable, type WikiRecord, wikiDir, wikiKey, wikiTableFile } from './wiki-table.ts';

type Env = Readonly<Record<string, string | undefined>>;

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
  'host' | 'dataDir' | 'sessionSecret' | 'defaultWiki' | 'allowedOwners' | 'webUrl'
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

function aheadOfHost(dir: string, runGit: RunGit): string[] {
  try {
    const ahead = Number(runGit(['rev-list', '--count', '@{upstream}..HEAD'], dir).trim());
    return ahead > 0 ? [`${dir}: ${ahead} commit${ahead === 1 ? '' : 's'} not pushed`] : [];
  } catch {
    return [`${dir}: the branch has no upstream on the host to compare with`];
  }
}

function unpushedWork(dir: string, runGit: RunGit = runGitSync): string[] {
  let status: string;
  try {
    status = runGit(['status', '--porcelain'], dir);
  } catch (err) {
    return [`${dir}: git status failed (${err instanceof Error ? err.message : String(err)})`];
  }
  const changed = status.split('\n').filter((line) => line.trim() !== '').length;
  return [
    ...(changed > 0 ? [`${dir}: ${changed} uncommitted change${changed === 1 ? '' : 's'}`] : []),
    ...aheadOfHost(dir, runGit),
  ];
}

function draftCopies(root: string, inner: string): Array<{ slug: string; dir: string }> {
  return entries(root)
    .filter((slug) => isDir(join(root, slug, inner, '.git')))
    .map((slug) => ({ slug, dir: join(root, slug, inner) }));
}

function originOf(dir: string, runGit: RunGit): { host: string; path: string } | undefined {
  let raw: string;
  try {
    raw = runGit(['config', '--get', 'remote.origin.url'], dir).trim();
  } catch {
    return undefined;
  }
  try {
    const url = new URL(raw);
    return { host: url.host.toLowerCase(), path: url.pathname };
  } catch {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw);
    return scp === null ? undefined : { host: (scp[1] ?? '').toLowerCase(), path: `/${scp[2]}` };
  }
}

function originMatches(
  dir: string,
  webUrl: string,
  names: readonly HostRepo[],
  runGit: RunGit,
): boolean {
  const origin = originOf(dir, runGit);
  if (origin === undefined) return false;
  let host: string;
  try {
    host = new URL(webUrl).host.toLowerCase();
  } catch {
    return false;
  }
  if (origin.host !== host) return false;
  const path = origin.path
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return names.some((name) =>
    path.endsWith(`/${name.owner.toLowerCase()}/${name.name.toLowerCase()}`),
  );
}

function branchProblem(dir: string, env: Env, runGit: RunGit): string | 'unknown' | undefined {
  const read = (args: string[]): string | undefined => {
    try {
      return runGit(args, dir).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const head = read(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const remoteHead = read(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const wanted = env.GITQUIRE_BRANCH?.trim() || undefined;
  if (remoteHead === undefined) {
    return wanted === undefined
      ? 'unknown'
      : `GITQUIRE_BRANCH is ${wanted}, but the default branch of the repository cannot be read from the checkout. A wiki behind the front door always follows the repository's default branch.`;
  }
  const defaultBranch = remoteHead.replace(/^origin\//, '');
  if (wanted !== undefined && wanted !== defaultBranch) {
    return `GITQUIRE_BRANCH is ${wanted}, but a wiki behind the front door always follows the repository's default branch, ${defaultBranch}.`;
  }
  if (head !== defaultBranch) {
    return `The checkout is on ${head ?? 'no branch'}, not on the repository's default branch ${defaultBranch}, which a wiki behind the front door follows.`;
  }
  return undefined;
}

function frontDoorLock(dirs: readonly string[]): string | undefined {
  return dirs.map((dir) => join(dir, FRONT_DOOR_LOCK)).find((file) => existsSync(file));
}

function refuseWhileFrontDoorRuns(dirs: readonly string[]): void {
  const lock = frontDoorLock(dirs);
  if (lock !== undefined) {
    throw new MoveOverError(
      `The front door is running on this volume, or stopped without cleaning up (${lock}). Stop the container; if it is stopped and was not stopped cleanly, remove ${lock}. Nothing was changed.`,
    );
  }
}

function unreadableKeys(projectDir: string, secrets: readonly string[]): boolean {
  const files = entries(chatKeysDir(projectDir)).filter((file) => /^\d+\.json$/.test(file));
  return files.length > 0 && secrets.every((secret) => keysSealedWith(projectDir, secret) === 0);
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
  if (!wikisModeFromEnv(env)) {
    throw new MoveOverError(
      'Run gitquire wikis adopt with the settings for several wikis, GITQUIRE_WIKIS=on included. Nothing was changed.',
    );
  }
  refuseWhileFrontDoorRuns([join(dataDir, 'server')]);
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
        `GitQuire is still running on ${dir} (${holder}). Stop the container first, then run this again.`,
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
  const gitDir = isDir(join(source, '.git')) ? source : undefined;
  if (gitDir !== undefined && !originMatches(gitDir, settings.webUrl, [named, repo], runGit)) {
    throw new MoveOverError(
      `The checkout in ${gitDir} is not a clone of ${named.owner}/${named.name} on ${settings.webUrl}: its origin points elsewhere. Nothing was changed.`,
    );
  }
  if (gitDir !== undefined) {
    const branch = branchProblem(gitDir, env, runGit);
    if (branch === 'unknown') {
      warnings.push(
        "The repository's default branch cannot be read from the checkout; a wiki behind the front door follows the default branch.",
      );
    } else if (branch !== undefined) {
      throw new MoveOverError(`${branch} Nothing was changed.`);
    }
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
      ...(gitDir === undefined
        ? []
        : resuming
          ? aheadOfHost(gitDir, runGit)
          : unpushedWork(gitDir, runGit)),
      ...drafts.flatMap((draft) => unpushedWork(draft.dir, runGit)),
    ];
    if (unpushed.length > 0 && !options.force) {
      throw new MoveOverError(
        resuming
          ? `An interrupted move is waiting to be finished, and not everything is pushed to the host:\n- ${unpushed.join('\n- ')}\nThe single wiki cannot start on a half-moved volume. Pass --force to finish the move: the commits move along and the wiki pushes them behind the front door.`
          : `Not everything is pushed to the host:\n- ${unpushed.join('\n- ')}\nStart the single wiki again and let it push, or pass --force: the edits then move along and the wiki pushes them behind the front door. Nothing was changed.`,
      );
    }
    if (unpushed.length > 0)
      warnings.push(`Moving with --force although not pushed: ${unpushed.join('; ')}`);
  }

  const keysBackup = `${chatKeysDir(target)}${KEYS_BEFORE_WIKIS}`;
  const reseal = keysSealedWith(source, settings.sessionSecret) > 0;
  const doorTokens = agentTokensFile(dataDir, settings.host);
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
  if (
    unreadableKeys(source, [
      settings.sessionSecret,
      deriveChatKeySecret(settings.sessionSecret, key),
    ])
  ) {
    warnings.push(
      `Saved AI keys in ${chatKeysDir(source)} open neither with GITQUIRE_SESSION_SECRET nor with this wiki's key, so none were re-sealed; people enter them again. Use the session secret the single wiki ran with to keep them.`,
    );
  }
  let tokenVerdict: string | undefined;
  if (storeToken && deps.repoToken !== undefined) {
    tokenVerdict =
      deps.checkRepoToken === undefined
        ? 'it could not be checked'
        : await deps.checkRepoToken(repo, deps.repoToken);
    if (tokenVerdict !== 'ok') {
      warnings.push(
        `GITQUIRE_HOST_REPO_TOKEN ${options.dryRun ? 'would not be' : 'is not'} kept (${tokenVerdict}). The wiki shows as disconnected until a server administrator enters a token limited to ${repo.owner}/${repo.name} in the wiki list.`,
      );
    }
  }

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
  if (tokenVerdict === 'ok') {
    steps.push(
      `Keep GITQUIRE_HOST_REPO_TOKEN, which passed the checks, as this wiki's token in ${tokenStoreFile}.`,
    );
  }
  if (record) steps.push(`Add ${repo.owner}/${repo.name} as the wiki ${key} to ${tableFile}.`);
  if (!movedWikis(createPeopleStore(frontDoorPeopleRoot(dataDir))).has(key)) {
    steps.push(
      "Move the per-person data (mention email, settings, AI keys, usage) to the front door's server/people; the wiki's own files stay as they are.",
    );
  }
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
  if (tokenVerdict === 'ok' && deps.repoToken !== undefined) {
    openRepoTokenStore(tokenStoreFile, () => undefined).set(key, deps.repoToken);
  }
  if (record) {
    const finalTable = table ?? openWikiTable(tableFile);
    pinAllowedOwner(
      { names: settings.allowedOwners, pinned: finalTable.ownerIds, pin: finalTable.pinOwner },
      repo,
    );
    finalTable.add(repo, ADDED_BY, now());
  }
  const people = movePeopleIn(
    dataDir,
    target,
    key,
    `${settings.host}-`,
    settings.sessionSecret,
    now,
  );
  if (people !== undefined) steps.push(people);
  return report(true);
}

function movePeopleIn(
  dataDir: string,
  target: string,
  key: string,
  idPrefix: string,
  sessionSecret: string,
  now: () => number,
): string | undefined {
  const people = createPeopleStore(frontDoorPeopleRoot(dataDir));
  if (movedWikis(people).has(key)) return undefined;
  const single = createPeopleStore(singleWikiPeopleRoot(target));
  if (movedWikis(single).has(SINGLE_WIKI_KEY)) {
    const count = copyPeopleForWiki(single, people, SINGLE_WIKI_KEY, key);
    markWikisMoved(people, [key], new Date(now()));
    return `Copied the per-person data of ${count} ${count === 1 ? 'person' : 'people'} to ${people.root}; the wiki's own copy stays.`;
  }
  const counts = createMentionCounts(dataDir, now);
  const record = { key } as WikiRecord;
  const marker = createPeopleMailer({
    store: people,
    config: undefined,
    send: async () => {},
    log: { warn: () => {} },
    wikis: () => [
      {
        key,
        idPrefix,
        name: undefined,
        url: undefined,
        mentions: () => counts.mentionsOf(record, idPrefix),
        readIds: (id) => counts.readIdsOf(record, id),
        canOpen: async () => 'unknown',
      },
    ],
  });
  const moved = movePeopleData(
    [
      {
        dir: target,
        wikiKey: key,
        idPrefix,
        keySecrets: [deriveChatKeySecret(sessionSecret, key), sessionSecret],
      },
    ],
    {
      store: people,
      keys: personKeyStore(people, derivePeopleKeySecret(sessionSecret)),
      markExisting: (person, login, wikiKey) => marker.markExisting(person, login, wikiKey),
      now,
    },
  );
  return `Moved the per-person data of ${moved.people} ${moved.people === 1 ? 'person' : 'people'} (mention email, settings, AI keys, usage) to ${people.root}; the wiki's own files stay as they were.${moved.unreadableKeys > 0 ? ` ${moved.unreadableKeys} saved AI key${moved.unreadableKeys === 1 ? '' : 's'} could not be opened; people enter them again.` : ''}`;
}

function movePeopleBack(back: string, dataDir: string, key: string, now: () => number): string {
  const people = createPeopleStore(join(back, 'server', 'people'));
  const single = createPeopleStore(singleWikiPeopleRoot(dataDir));
  const count = copyPeopleForWiki(people, single, key, SINGLE_WIKI_KEY);
  markWikisMoved(single, [SINGLE_WIKI_KEY], new Date(now()));
  return `Copied the per-person data of ${count} ${count === 1 ? 'person' : 'people'} into ${single.root} for the single wiki.`;
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
  const parkedFile = join(back, 'parked');
  const parked = existsSync(parkedFile);
  const placeOf = (name: 'server' | 'wikis'): string | undefined => {
    if (existsSync(join(back, name))) return join(back, name);
    if (!parked && existsSync(join(dataDir, name))) return join(dataDir, name);
    return undefined;
  };
  const serverDir = placeOf('server');
  const wikisDir = placeOf('wikis');
  refuseWhileFrontDoorRuns([join(dataDir, 'server'), join(back, 'server')]);
  const tableFile = serverDir === undefined ? undefined : join(serverDir, 'wikis.json');
  if (tableFile === undefined || !existsSync(tableFile) || wikisDir === undefined) {
    throw new MoveOverError(
      `${dataDir} holds no wiki table (server/wikis.json) and wiki folders (wikis/); there is nothing to move back.`,
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
  const entriesMoved = parked && !isDir(join(source, '.git'));
  if (!entriesMoved && !isDir(join(source, '.git'))) {
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
  }
  const otherFolders = entries(wikisDir).filter(
    (name) => name !== key && name !== '.gitquire-drafts',
  );
  if (otherFolders.length > 0) {
    throw new MoveOverError(
      `${wikisDir} holds other wiki folders (${otherFolders.join(', ')}). Nothing was changed.`,
    );
  }
  for (const dir of [source, dataDir]) {
    const holder = isDir(dir) ? deps.running(dir) : undefined;
    if (holder !== undefined) {
      throw new MoveOverError(
        `GitQuire is still running on ${dir} (${holder}). Stop the container first.`,
      );
    }
  }
  const drafts = draftCopies(draftsDir(source, {}), key);
  const gitDir = isDir(join(source, '.git'))
    ? source
    : isDir(join(dataDir, '.git'))
      ? dataDir
      : undefined;
  const unpushed = [
    ...(gitDir === undefined
      ? []
      : resuming
        ? aheadOfHost(gitDir, runGit)
        : unpushedWork(gitDir, runGit)),
    ...drafts.flatMap((draft) => unpushedWork(draft.dir, runGit)),
  ];
  if (unpushed.length > 0) {
    if (!options.force) {
      throw new MoveOverError(
        resuming
          ? `An interrupted move back is waiting to be finished, and not everything is pushed to the host:\n- ${unpushed.join('\n- ')}\nPass --force to finish the move back; the single wiki pushes the commits.`
          : `Not everything is pushed to the host:\n- ${unpushed.join('\n- ')}\nStart the front door again and let the wiki push, or pass --force. Nothing was changed.`,
      );
    }
    warnings.push(`Moved back with --force although not pushed: ${unpushed.join('; ')}`);
  }
  const derived = deriveChatKeySecret(settings.sessionSecret, key);
  if (gitDir !== undefined && unreadableKeys(gitDir, [derived, settings.sessionSecret])) {
    warnings.push(
      `Saved AI keys in ${chatKeysDir(gitDir)} open neither with this wiki's key nor with GITQUIRE_SESSION_SECRET, so none are re-sealed; people enter them again.`,
    );
  }
  const singleDrafts = draftsDir(dataDir, env);
  steps.push(
    `Move ${join(dataDir, 'server')} and ${join(dataDir, 'wikis')} to ${back}.`,
    `Move every entry of ${join(back, 'wikis', key)} back into ${dataDir}.`,
    'Re-seal the saved AI keys with GITQUIRE_SESSION_SECRET again (a copy of the current ones stays beside them).',
    `Put the front door's agent tokens back as the single wiki's (an existing file is kept beside it).`,
    ...drafts.map(
      (draft) =>
        `Copy the draft working copy ${draft.dir} to ${join(singleDrafts, draft.slug, basename(dataDir))} (an existing one is kept beside it).`,
    ),
    "Copy the per-person data (mention email, settings, AI keys, usage of this wiki) into the single wiki's people folder.",
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

  mkdirSync(back, { recursive: true });
  const stampFile = join(back, 'moved-back-at');
  if (!existsSync(stampFile)) writeFileSync(stampFile, `${stampOf(now())}\n`);
  const stamp = readFileSync(stampFile, 'utf8').trim();
  if (!parked) {
    for (const name of ['server', 'wikis']) {
      if (!existsSync(join(back, name))) renameSync(join(dataDir, name), join(back, name));
    }
    writeFileSync(parkedFile, `${stamp}\n`);
  }
  const from = join(back, 'wikis', key);
  moveEntries(from, dataDir, new Set());

  const keysDir = chatKeysDir(dataDir);
  const keysBackup = `${keysDir}.before-single-wiki-${stamp}`;
  if (keysSealedWith(dataDir, derived) > 0) {
    if (!existsSync(keysBackup)) copyWhole(keysDir, keysBackup);
    resealKeys(dataDir, derived, settings.sessionSecret);
  }
  const doorTokens = agentTokensFile(back, settings.host);
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
  steps.push(movePeopleBack(back, dataDir, key, now));
  const kept = join(dataDir, '.gitquire', 'local', 'gitquire', `several-wikis-${stamp}`);
  mkdirSync(dirname(kept), { recursive: true });
  renameSync(back, kept);
  steps.push(`Kept the front door's files in ${kept}.`);
  return { changed: true, wiki: `${wiki.owner}/${wiki.name}`, key, steps, warnings };
}
