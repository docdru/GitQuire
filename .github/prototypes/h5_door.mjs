import { createForgejoDoorHost } from '../../packages/server/src/gitquire/host/forgejo.ts';
import { repoChange } from '../../packages/server/src/gitquire/host/renames.ts';

const web = (process.env.FORGEJO_URL ?? 'https://127.0.0.1:3000').replace(/\/+$/, '');
const repos = JSON.parse(process.env.DOOR_REPOS ?? '{}');
const notesToken = process.env.DOOR_NOTES_TOKEN;
const botToken = process.env.BOT_TOKEN;
const failures = [];

function check(row, passed, detail) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${row}: ${detail}`);
  if (!passed) failures.push(`${row}: ${detail}`);
}

function door(bot, tokens) {
  return createForgejoDoorHost(
    { webUrl: web, apiUrl: `${web}/api/v1`, repo: undefined },
    { botToken: () => bot, repoTokens: tokens },
  );
}

const store = {
  tokenFor: (repo) =>
    repo.owner === 'team' && repo.name === 'notes'
      ? notesToken
      : repo.name === 'leak'
        ? botToken
        : undefined,
};
const host = door(botToken, store);

const addable = await host.addableRepos(process.env.DOOR_PERSON_TOKEN);
const listed = addable.state === 'listed' ? addable.repos : [];
const byName = Object.fromEntries(listed.map((repo) => [repo.name, repo]));
check(
  'addableRepos',
  addable.state === 'listed' &&
    byName.notes?.id === repos.notes.id &&
    byName.notes.ownerId === repos.notes.ownerId &&
    byName.notes.blocked === undefined &&
    byName.writer2?.blocked === 'bot-not-admin' &&
    byName.hidden === undefined &&
    byName.wiki === undefined,
  `GET /user/repos of alice, kept where she is admin and the bot reaches the repo -> ${JSON.stringify(addable)}`,
);

const found = await host.repoById(repos.notes.id);
check(
  'repoById',
  found.state === 'found' &&
    found.repo.owner === 'team' &&
    found.repo.name === 'notes' &&
    found.repo.ownerId === repos.notes.ownerId,
  `GET /repositories/${repos.notes.id} -> ${JSON.stringify(found)}`,
);
const hidden = await host.repoById(repos.hidden.id);
check(
  'repoById',
  hidden.state === 'gone',
  `a repo the bot cannot reach -> ${JSON.stringify(hidden)}`,
);
const renamed = repoChange(repos.writer, await host.repoById(repos.writer.id));
check(
  'renames',
  renamed.change === 'renamed' && renamed.to.owner === 'team' && renamed.to.name === 'writer2',
  `team/writer renamed to team/writer2 on Forgejo -> ${JSON.stringify(renamed)}`,
);

const health = {
  notes: await host.health({ owner: 'team', name: 'notes' }),
  writer2: await host.health({ owner: 'team', name: 'writer2' }),
  hidden: await host.health({ owner: 'team', name: 'hidden' }),
  revokedBot: await door(process.env.DOOR_REVOKED_TOKEN, store).health({
    owner: 'team',
    name: 'notes',
  }),
  noLimitedToken: await door(botToken, { tokenFor: () => undefined }).health({
    owner: 'team',
    name: 'notes',
  }),
  limitedForAnother: await door(botToken, { tokenFor: () => notesToken }).health({
    owner: 'team',
    name: 'wiki',
  }),
};
check(
  'health',
  health.notes === 'ok' &&
    health.writer2 === 'refused:not-admin' &&
    health.hidden === 'refused:removed' &&
    health.revokedBot === 'refused:token' &&
    health.noLimitedToken === 'refused:token' &&
    health.limitedForAnother === 'refused:token',
  `ok, bot only writer, bot not on the repo, revoked bot token, no limited token, a token limited to another repo -> ${JSON.stringify(health)}`,
);

check(
  'tokenFor',
  (await host.tokenFor({ owner: 'team', name: 'notes' })) === notesToken &&
    (await host.tokenFor({ owner: 'team', name: 'leak' })) === undefined,
  'the limited token from the store, never the unlimited bot token',
);

if (failures.length > 0) {
  console.log(`\nFailures:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
