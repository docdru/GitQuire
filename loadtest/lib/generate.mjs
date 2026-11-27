import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

export function rng(seed) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  return {
    next,
    int: (max) => Math.floor(next() * max),
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

const WORDS =
  'team plan budget review decision meeting customer release design draft note roadmap risk owner deadline quarter goal metric launch feedback research hiring process policy support vendor contract onboarding security incident retro sprint backlog'.split(
    ' ',
  );

export function pageName(index) {
  return `Topic ${String(index).padStart(5, '0')}`;
}

export function pagePath(index, folders) {
  return `${folders > 0 ? `area-${index % folders}/` : ''}${pageName(index)}`;
}

function sentence(r, words) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(r.pick(WORDS));
  out[0] = out[0][0].toUpperCase() + out[0].slice(1);
  return `${out.join(' ')}.`;
}

function pageBody(index, pages, r, hubs) {
  const lines = [];
  if (index % 20 === 0) {
    lines.push(
      '---',
      `status: ${r.pick(['open', 'done', 'blocked'])}`,
      `owner: u${String(1 + r.int(9)).padStart(3, '0')}`,
      `due: 2026-${String(1 + r.int(12)).padStart(2, '0')}-15`,
      '---',
      '',
    );
  }
  lines.push(`# ${pageName(index)}`, '');
  const sections = 2 + r.int(4);
  const threads = [];
  for (let s = 0; s < sections; s++) {
    lines.push(`## ${sentence(r, 3).slice(0, -1)}`, '');
    const paragraphs = 1 + r.int(3);
    for (let p = 0; p < paragraphs; p++) {
      const parts = [];
      for (let k = 0; k < 2 + r.int(4); k++) parts.push(sentence(r, 6 + r.int(10)));
      if (r.next() < 0.6) {
        const target = r.next() < 0.3 ? r.pick(hubs) : r.int(pages);
        if (target !== index) parts.push(`See [[${pageName(target)}]].`);
      }
      if (index % 10 === 3 && threads.length < 2 && r.next() < 0.5) {
        const label = `c-${(index * 7 + threads.length).toString(16).padStart(4, '0')}`;
        parts[0] = `${parts[0].slice(0, -1)}[^${label}].`;
        threads.push(label);
      }
      lines.push(parts.join(' '), '');
    }
    if (r.next() < 0.3) {
      lines.push(`- [ ] ${sentence(r, 5)}`, `- [x] ${sentence(r, 4)}`, '');
    }
  }
  for (const label of threads) {
    lines.push(
      `[^${label}]: 💬 on "${r.pick(WORDS)}"`,
      '',
      `    - **@u001** · 2026-11-14 10:32 — ${sentence(r, 8)}`,
      `    - **@u002** · 2026-11-14 11:02 — ${sentence(r, 6)}`,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function generateBareRepo(target, { pages, commits = 1, folders = 10, seed = 1 }) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch', 'main', target]);
  const r = rng(seed);
  const hubs = [0, 1, 2, 3, 4];
  const bodies = [];
  for (let i = 0; i < pages; i++) bodies.push(pageBody(i, pages, r, hubs));
  for (const hub of hubs) {
    if (hub >= pages) continue;
    const links = [];
    for (let i = 0; i < Math.min(pages, 200); i++)
      if (i !== hub) links.push(`- [[${pageName(i)}]]`);
    bodies[hub] = bodies[hub].replace(/\n$/, `\n\n## Linked pages\n\n${links.join('\n')}\n`);
  }
  const chunks = [];
  const author = 'Load Test <loadtest@example.org>';
  let time = 1_760_000_000;
  const data = (text) => {
    const buf = Buffer.from(text, 'utf8');
    return `data ${buf.length}\n${text}\n`;
  };
  const batch = Math.max(1, Math.ceil(pages / Math.max(1, Math.min(commits, pages))));
  let mark = 0;
  let written = 0;
  for (let c = 0; c < commits; c++) {
    mark++;
    time += 3600;
    const lines = [];
    if (written < pages) {
      const end = Math.min(pages, written + batch);
      for (let i = written; i < end; i++) {
        lines.push(`M 100644 inline ${pagePath(i, folders)}.md\n${data(bodies[i])}`);
      }
      if (c === 0)
        lines.push(
          `M 100644 inline README.md\n${data('# Load test wiki\n\nStart at [[Topic 00000]].\n')}`,
        );
      written = end;
    } else {
      const i = r.int(pages);
      bodies[i] = `${bodies[i].trimEnd()}\n\n${sentence(r, 10)}\n`;
      lines.push(`M 100644 inline ${pagePath(i, folders)}.md\n${data(bodies[i])}`);
    }
    const message = `Change ${c}`;
    chunks.push(
      `commit refs/heads/main\nmark :${mark}\nauthor ${author} ${time} +0000\ncommitter ${author} ${time} +0000\n${data(message)}${c > 0 ? `from :${mark - 1}\n` : ''}${lines.join('')}\n`,
    );
  }
  const result = spawnSync('git', ['fast-import', '--quiet'], {
    cwd: target,
    input: chunks.join(''),
    maxBuffer: 1 << 30,
  });
  if (result.status !== 0) throw new Error(`fast-import failed: ${result.stderr}`);
  return { pages, commits, hubs: hubs.filter((h) => h < pages).map(pageName) };
}
