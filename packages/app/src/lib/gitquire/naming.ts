import {
  type NamingRule,
  parseNamingRule,
  slugifySegment,
} from '@inkeep/open-knowledge-core/gitquire/naming';

interface NamingResponse {
  rule?: unknown;
}

let rule: NamingRule = 'slug';
let loading: Promise<void> | undefined;

export function loadNamingRule(): Promise<void> {
  loading ??= fetch('/api/gitquire/naming', { credentials: 'same-origin' })
    .then((res): Promise<NamingResponse> => (res.ok ? res.json() : Promise.resolve({})))
    .then((body) => {
      rule = parseNamingRule(typeof body.rule === 'string' ? body.rule : undefined);
    })
    .catch(() => undefined);
  return loading;
}

export function currentNamingRule(): NamingRule {
  return rule;
}

export function nameLastSegment(path: string, isFile: boolean, active = rule): string {
  if (active === 'off') return path;
  const trailingSlash = path.endsWith('/');
  const trimmed = trailingSlash ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf('/');
  const leaf = trimmed.slice(slash + 1);
  const named = `${trimmed.slice(0, slash + 1)}${slugifySegment(leaf, isFile)}`;
  return trailingSlash ? `${named}/` : named;
}
