const MAX_CAUSE_DEPTH = 5;

function describeValue(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  return `${typeof value} keys=[${Object.keys(value).join(',')}]`;
}

function describeConfigFailure(context: string, err: unknown): string {
  const messages: string[] = [];
  const seen = new WeakSet<object>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  if (messages.length === 0) return `${context}: ${describeValue(err)}`;
  return `${context}: ${messages.reverse().slice(0, MAX_CAUSE_DEPTH).join(' -> ')}`;
}

export function debugConfigFailure(context: string, err: unknown): void {
  if (!process.env.OK_DEBUG_CONFIG) return;
  process.stderr.write(`[ok] config ${describeConfigFailure(context, err)}\n`);
}
