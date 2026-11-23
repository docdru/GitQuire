export interface PageMentionTarget {
  docName: string;
  login: string;
  occurrence: number;
  snippet: string;
}

export interface MentionPanelRequest {
  tab: 'inbox' | 'pages';
  login?: string;
}

const REVEAL_WAIT_MS = 15_000;

let pendingReveal: { target: PageMentionTarget; at: number } | null = null;
const revealListeners = new Set<() => void>();

export function revealPageMention(target: PageMentionTarget, now: number = Date.now()): void {
  pendingReveal = { target, at: now };
  for (const listener of revealListeners) listener();
}

export function claimPageMentionReveal(
  docName: string,
  use: (target: PageMentionTarget) => boolean,
  now: number = Date.now(),
): boolean {
  if (pendingReveal === null) return false;
  if (now - pendingReveal.at > REVEAL_WAIT_MS) {
    pendingReveal = null;
    return false;
  }
  if (pendingReveal.target.docName !== docName || !use(pendingReveal.target)) return false;
  pendingReveal = null;
  return true;
}

export function subscribePageMentionReveal(listener: () => void): () => void {
  revealListeners.add(listener);
  return () => revealListeners.delete(listener);
}

let pendingPanel: MentionPanelRequest | null = null;
const panelListeners = new Set<(request: MentionPanelRequest) => void>();

export function openMentionPanel(request: MentionPanelRequest): void {
  if (panelListeners.size === 0) {
    pendingPanel = request;
    return;
  }
  pendingPanel = null;
  for (const listener of panelListeners) listener(request);
}

export function listenMentionPanel(listener: (request: MentionPanelRequest) => void): () => void {
  panelListeners.add(listener);
  if (pendingPanel !== null) {
    const request = pendingPanel;
    pendingPanel = null;
    listener(request);
  }
  return () => panelListeners.delete(listener);
}
