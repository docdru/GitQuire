const ORIGIN_PREFIX = 'refs/remotes/origin/';

export interface GoneBranch {
  name: string;
  tip: string;
}

export function goneBranches(git: (args: readonly string[]) => string): GoneBranch[] {
  const out = git([
    'for-each-ref',
    '--format=%(refname:short)%09%(objectname)%09%(upstream)%09%(upstream:track)',
    'refs/heads',
  ]);
  const gone: GoneBranch[] = [];
  for (const line of out.split('\n')) {
    const [name, tip, upstream, track] = line.split('\t');
    if (name === undefined || name === '' || tip === undefined) continue;
    if (!upstream?.startsWith(ORIGIN_PREFIX) || track?.trim() !== '[gone]') continue;
    gone.push({ name, tip });
  }
  return gone;
}

function isAncestor(git: (args: readonly string[]) => string, tip: string, base: string): boolean {
  try {
    git(['merge-base', '--is-ancestor', tip, `${ORIGIN_PREFIX}${base}`]);
    return true;
  } catch {
    return false;
  }
}

export async function mergedGoneBranches(
  git: (args: readonly string[]) => string,
  base: string,
  mergedPullHeads?: (branch: string) => Promise<string[]>,
): Promise<string[]> {
  const merged: string[] = [];
  for (const branch of goneBranches(git)) {
    if (branch.name === base) continue;
    if (isAncestor(git, branch.tip, base)) {
      merged.push(branch.name);
      continue;
    }
    if (mergedPullHeads === undefined) continue;
    const heads = await mergedPullHeads(branch.name).catch(() => []);
    if (heads.includes(branch.tip)) merged.push(branch.name);
  }
  return merged;
}
