import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENTS_FILE_NAME = 'AGENTS.md';
export const AGENTS_SECTION_BEGIN =
  '<!-- gitquire:begin — written by GitQuire; edit outside this section -->';
export const AGENTS_SECTION_END = '<!-- gitquire:end -->';

export const AGENTS_SECTION = `# Working in this wiki

This repository is a team wiki edited with GitQuire. Every page is a Markdown
file. People edit the same files live, so keep changes small and targeted.

## Editing pages
- Change only the passage you were asked to change. Do not reformat, rewrap
  or reorder the rest of the file.
- Edit in place. Never regenerate a whole file from memory.
- Leave the frontmatter at the top alone unless asked; keep unknown fields.
- Leave \`gitquire-view\` blocks unchanged; they are saved views, not text.

## Names and links
- File and folder names are lowercase words joined by hyphens:
  \`meeting-notes-2026.md\`. The readable title is the \`# Title\` in the page.
- Link pages as \`[[Meeting Notes 2026]]\`. Do not rename or move a page by
  hand; links in other pages would break. Ask for it to be done in GitQuire.
- A relation to another page is a frontmatter property or a line
  \`relation:: [[Page]]\`.

## Action items
- \`- [ ] Send draft to Anna 📅 2026-11-20\`. Tick with \`- [x]\`.
- \`@login\` in an action item or comment notifies that person. Only mention
  someone when they need to act.

## Comments
Comments are footnotes whose label starts with \`c-\`.

    The quarterly numbers[^c-7f3a] look good.

    [^c-7f3a]: 💬 on "quarterly numbers"

        - **@alice** · 2026-11-14 10:32 — Where do these come from?

- **Read them first.** A comment on a passage you are about to change may
  be an instruction or an open question about it.
- **Keep the mark.** When you rewrite a sentence, keep its \`[^c-…]\` mark at
  the end of the passage it belongs to. If you delete the passage, delete
  only the mark and leave the thread.
- **Reply** by adding one list line at the end of the thread, indented like
  the others: \`- **@your-name** · YYYY-MM-DD HH:MM — text\` (time in UTC).
  Say what you changed.
- **Do not** edit or delete other people's lines, resolve threads, or
  invent a thread under someone else's name.
- **New comment:** add a mark \`[^c-xxxx]\` with four new random letters or
  digits after the passage, and a thread at the end of the file in the form
  above.
- Real footnotes (labels not starting with \`c-\`) are page content.

## Committing
- One commit per request, with a message saying what changed and why.
- Pull before you start and before you push; do not force-push.
- Never touch hidden folders such as \`.gitquire/\`.`;

function block(): string {
  return `${AGENTS_SECTION_BEGIN}\n${AGENTS_SECTION}\n${AGENTS_SECTION_END}`;
}

export function withAgentsSection(existing: string | undefined): string {
  if (existing === undefined || existing.trim() === '') return `${block()}\n`;
  const begin = existing.indexOf(AGENTS_SECTION_BEGIN);
  const end = begin === -1 ? -1 : existing.indexOf(AGENTS_SECTION_END, begin);
  if (begin !== -1 && end !== -1) {
    return `${existing.slice(0, begin)}${block()}${existing.slice(end + AGENTS_SECTION_END.length)}`;
  }
  return `${existing.trimEnd()}\n\n${block()}\n`;
}

export type AgentsFileOutcome = 'created' | 'updated' | 'unchanged' | 'off';

export function ensureAgentsFile(
  dir: string,
  env: { GITQUIRE_AGENTS_FILE?: string },
): AgentsFileOutcome {
  if ((env.GITQUIRE_AGENTS_FILE ?? '').trim().toLowerCase() === 'off') return 'off';
  const path = join(dir, AGENTS_FILE_NAME);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const next = withAgentsSection(existing);
  if (next === existing) return 'unchanged';
  writeFileSync(path, next);
  return existing === undefined ? 'created' : 'updated';
}
