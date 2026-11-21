import type { HostKind } from '../host/types.ts';
import { escapeHtml } from '../http-util.ts';
import { type WikiRecord, wikiPrefix } from './wiki-table.ts';

export const ADD_WIKI_PAGE = '/add-wiki';
export const ADD_WIKI_TOKEN_FORM = '/add-wiki/token';

export const REASON_TEXT: Record<string, string> = {
  token: "GitQuire's token for this repository was refused.",
  'not-admin': "GitQuire's account is not an administrator of this repository.",
  removed:
    'GitQuire no longer has access to this repository (the app was uninstalled or the bot removed).',
  gone: "The repository cannot be found with GitQuire's access; it may have been deleted.",
  'owner-not-allowed': "The repository's owner is not on this server's list of allowed owners.",
};

export interface HomeRow {
  wiki: WikiRecord;
  admin: boolean;
}

export interface HomeInput {
  rows: readonly HomeRow[];
  defaultAddress: string | undefined;
  hosts: string;
  canReplaceToken: boolean;
  scriptPath: string;
}

function tokenForm(wiki: WikiRecord): string {
  return `<form method="post" action="${ADD_WIKI_TOKEN_FORM}"><input type="hidden" name="key" value="${escapeHtml(wiki.key)}"><label>New token limited to <code>${escapeHtml(`${wiki.owner}/${wiki.name}`)}</code> <input type="password" name="token" autocomplete="off" required></label> <button type="submit">Save the token</button></form>`;
}

function homeRow(row: HomeRow, canReplaceToken: boolean): string {
  const { wiki, admin } = row;
  const label = escapeHtml(`${wiki.owner}/${wiki.name}`);
  const role = admin ? ' <span class="muted">admin</span>' : '';
  if (wiki.state === 'on') {
    return `<li data-wiki="${escapeHtml(wiki.key)}"><a href="${escapeHtml(`${wikiPrefix(wiki)}/`)}">${label}</a>${role}</li>`;
  }
  const why = admin
    ? `<br><span class="muted">${escapeHtml(REASON_TEXT[wiki.reason ?? ''] ?? '')}</span>`
    : '';
  const replace = admin && canReplaceToken && wiki.reason === 'token' ? tokenForm(wiki) : '';
  return `<li data-wiki="${escapeHtml(wiki.key)}">${label}${role} <span class="muted">(disconnected)</span>${why}${replace}</li>`;
}

export function homeBody(input: HomeInput): string {
  const items = input.rows.map((row) => homeRow(row, input.canReplaceToken)).join('');
  const marker =
    input.defaultAddress === undefined
      ? ''
      : `<div id="gq-default-wiki" data-address="${escapeHtml(input.defaultAddress)}"></div>`;
  const list =
    items === ''
      ? '<p>You have no wikis on this server yet.</p>'
      : `<ul class="wikis">${items}</ul>`;
  return `${marker}${list}<p><a href="${ADD_WIKI_PAGE}">Add a wiki</a></p><p class="muted">${escapeHtml(input.hosts)}</p><p><a href="/auth/logout">Sign out</a></p><script src="${input.scriptPath}" defer></script>`;
}

export interface AddableRow {
  id: number;
  owner: string;
  name: string;
  blocked?: 'bot-not-admin';
  wiki?: string;
}

export interface AddWikiHelp {
  installUrl?: string;
  botLogin?: string;
}

export interface AddWikiInput {
  host: HostKind;
  label: string;
  state: 'listed' | 'refused' | 'unreachable';
  repos: readonly AddableRow[];
  hosts: string;
  canAdd: boolean;
  needsToken: boolean;
  help: AddWikiHelp;
  reload: string;
  message?: string;
}

function botName(help: AddWikiHelp): string {
  return help.botLogin === undefined
    ? "GitQuire's account"
    : `GitQuire's account <strong>@${escapeHtml(help.botLogin)}</strong>`;
}

function addAction(repo: AddableRow, input: AddWikiInput): string {
  if (repo.wiki !== undefined) {
    return `<a href="${escapeHtml(repo.wiki)}">Open the wiki</a>`;
  }
  if (repo.blocked === 'bot-not-admin') {
    return `Make ${botName(input.help)} an administrator of this repository first.`;
  }
  if (!input.canAdd) return 'A server administrator can add it.';
  const token = input.needsToken
    ? `<label>Token limited to this repository <input type="password" name="token" autocomplete="off" required></label> `
    : '';
  return `<form method="post" action="${ADD_WIKI_PAGE}"><input type="hidden" name="id" value="${repo.id}">${token}<button type="submit">Make this a wiki</button></form>`;
}

function hostHelp(input: AddWikiInput): string {
  const reload = `<a href="${escapeHtml(input.reload)}">reload this list</a>`;
  if (input.host === 'github') {
    const install =
      input.help.installUrl === undefined
        ? 'Install the GitHub App of this server on it'
        : `<a href="${escapeHtml(input.help.installUrl)}" target="_blank" rel="noreferrer">Install the GitHub App of this server on it</a>`;
    return `<p class="muted">Listed are the repositories you administer that GitQuire can reach. Missing one? ${install}, then ${reload}.</p>`;
  }
  const bot = botName(input.help);
  const who = input.canAdd
    ? ''
    : ' On this server only server administrators add wikis; ask one of them.';
  return `<p class="muted">Listed are the repositories you administer that ${bot} can reach. To add one, make that account an administrator of the repository. Then a server administrator signs in to ${escapeHtml(input.label)} as that account, creates a token limited to the repository with the <code>write:repository</code> permission, and enters it here.${who} Then ${reload}.</p>`;
}

export function addWikiBody(input: AddWikiInput): string {
  const message =
    input.message === undefined
      ? ''
      : `<p role="alert"><strong>${escapeHtml(input.message)}</strong></p>`;
  let list: string;
  if (input.state === 'refused') {
    list = `<p>${escapeHtml(input.label)} did not give GitQuire the list of your repositories. <a href="${escapeHtml(input.reload)}">Try again</a>.</p>`;
  } else if (input.state === 'unreachable') {
    list = `<p>${escapeHtml(input.label)} cannot be reached right now. <a href="${escapeHtml(input.reload)}">Try again</a> in a moment.</p>`;
  } else if (input.repos.length === 0) {
    list = '<p>None of the repositories you administer can become a wiki here.</p>';
  } else {
    const rows = input.repos
      .map(
        (repo) =>
          `<tr data-repo="${repo.id}"><td><code>${escapeHtml(`${repo.owner}/${repo.name}`)}</code></td><td>${addAction(repo, input)}</td></tr>`,
      )
      .join('');
    list = `<table><tbody>${rows}</tbody></table>`;
  }
  return `${message}${list}${hostHelp(input)}<p class="muted">${escapeHtml(input.hosts)}</p><p><a href="/">Your wikis</a></p>`;
}
