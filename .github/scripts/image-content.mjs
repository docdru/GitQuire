import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

function walk(dir, skip = () => false) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (skip(entry, path)) continue;
    if (entry.isDirectory()) files.push(...walk(path, skip));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const version = execFileSync('gitquire', ['--version'], { encoding: 'utf8' }).trim();
const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const packageRoot = join(globalRoot, '@gitquire', 'cli');

const ownFiles = walk(
  packageRoot,
  (entry, path) => entry.isDirectory() && path === join(packageRoot, 'node_modules'),
)
  .map((path) => {
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    return `${hash}  ${relative(packageRoot, path)}`;
  })
  .sort((a, b) => byCodePoint(a.slice(66), b.slice(66)));

const installed = new Set();
for (const path of walk(join(packageRoot, 'node_modules'))) {
  if (!path.endsWith('/package.json')) continue;
  const parent = `/${relative(packageRoot, path)}`.split('/node_modules/').pop();
  const segments = parent.split('/');
  const depth = segments[0].startsWith('@') ? 3 : 2;
  if (segments.length !== depth) continue;
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (manifest.name && manifest.version) installed.add(`${manifest.name}@${manifest.version}`);
  } catch {}
}

console.log(`gitquire --version: ${version}`);
console.log(`files: ${ownFiles.length}`);
for (const line of ownFiles) console.log(line);
console.log(`dependencies: ${installed.size}`);
for (const line of [...installed].sort(byCodePoint)) console.log(line);
