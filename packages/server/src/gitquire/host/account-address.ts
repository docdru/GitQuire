import { isEmailAddress } from '../mail.ts';
import type { AccountAddress, HostNames } from './types.ts';

const GITHUB_NOREPLY = '@users.noreply.github.com';

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

export function isNoReplyAddress(address: string, names: Pick<HostNames, 'noreplyEmail'>): boolean {
  const lower = address.toLowerCase();
  if (lower.endsWith(GITHUB_NOREPLY)) return true;
  const sample = names.noreplyEmail({ id: 1, login: 'gitquire' });
  return sample.includes('@') && domainOf(sample) === domainOf(lower);
}

export function withoutNoReply(
  found: AccountAddress,
  names: Pick<HostNames, 'noreplyEmail'>,
): AccountAddress {
  return found.state === 'found' && isNoReplyAddress(found.address, names)
    ? { state: 'none' }
    : found;
}

export function primaryVerifiedAddress(status: number, body: unknown): AccountAddress {
  if (status === 401 || status === 403 || status === 404) return { state: 'refused' };
  if (status !== 200 || !Array.isArray(body)) return { state: 'unreachable' };
  for (const item of body) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as { email?: unknown; primary?: unknown; verified?: unknown };
    if (entry.primary !== true || entry.verified !== true) continue;
    if (typeof entry.email !== 'string') continue;
    const address = entry.email.trim();
    if (!isEmailAddress(address) || address.toLowerCase().endsWith(GITHUB_NOREPLY)) continue;
    return { state: 'found', address };
  }
  return { state: 'none' };
}
export const ACCOUNT_ADDRESS_DEADLINE_MS = 5000;
