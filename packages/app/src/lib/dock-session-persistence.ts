export type DockSurface = 'agents';

export interface DockSessionOrder {
  readonly order: readonly string[];
  readonly activeKey: string | null;
}

export interface WebAgentsDockSessionOrder extends DockSessionOrder {
  readonly agentPanelVisible?: boolean;
}

const WEB_STORAGE_KEYS: Record<DockSurface, string> = {
  agents: 'ok-agent-session-order-v1',
};

function coerceOrder(raw: {
  order?: unknown;
  activeKey?: unknown;
  agentPanelVisible?: unknown;
}): WebAgentsDockSessionOrder {
  const order = Array.isArray(raw.order)
    ? raw.order.filter((k): k is string => typeof k === 'string')
    : [];
  const activeKey = typeof raw.activeKey === 'string' ? raw.activeKey : null;
  const agentPanelVisible =
    typeof raw.agentPanelVisible === 'boolean' ? raw.agentPanelVisible : undefined;
  return agentPanelVisible === undefined
    ? { order, activeKey }
    : { order, activeKey, agentPanelVisible };
}

type WebRecordRead =
  | { readonly status: 'absent' }
  | { readonly status: 'parsed'; readonly record: WebAgentsDockSessionOrder }
  | { readonly status: 'corrupt' }
  | { readonly status: 'blocked' };

function readWebRecord(surface: DockSurface): WebRecordRead {
  if (typeof window === 'undefined') return { status: 'absent' };
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(WEB_STORAGE_KEYS[surface]);
  } catch (err) {
    console.warn(
      `[dock-session-persistence] reading ${WEB_STORAGE_KEYS[surface]} failed: ${String(err)}`,
    );
    return { status: 'blocked' };
  }
  if (raw === null) return { status: 'absent' };
  try {
    return {
      status: 'parsed',
      record: coerceOrder(
        JSON.parse(raw) as { order?: unknown; activeKey?: unknown; agentPanelVisible?: unknown },
      ),
    };
  } catch (err) {
    console.warn(
      `[dock-session-persistence] stored ${WEB_STORAGE_KEYS[surface]} record was not valid JSON; ignoring it: ${String(err)}`,
    );
    return { status: 'corrupt' };
  }
}

export function readWebDockSessionOrder(surface: DockSurface): WebAgentsDockSessionOrder | null {
  const read = readWebRecord(surface);
  return read.status === 'parsed' ? read.record : null;
}
