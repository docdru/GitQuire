export const CHAT_PROVIDERS = ['claude', 'mistral'] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

export interface ChatModel {
  id: string;
  label: string;
  note: string;
}

export interface ProviderInfo {
  label: string;
  models: readonly ChatModel[];
  defaultModel: string;
  keyUrl: string;
  limitsUrl: string;
}

export const PROVIDER_INFO: Record<ChatProvider, ProviderInfo> = {
  claude: {
    label: 'Claude (Anthropic)',
    models: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Balanced' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Most capable, costs more' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fastest, cheapest' },
    ],
    defaultModel: 'claude-sonnet-5-5',
    keyUrl: 'https://platform.claude.com/settings/keys',
    limitsUrl: 'https://platform.claude.com/settings/limits',
  },
  mistral: {
    label: 'Mistral (La Plateforme)',
    models: [
      { id: 'mistral-medium-latest', label: 'Mistral Medium', note: 'Balanced' },
      { id: 'mistral-large-latest', label: 'Mistral Large', note: 'Most capable, costs more' },
      { id: 'mistral-small-latest', label: 'Mistral Small', note: 'Fastest, cheapest' },
    ],
    defaultModel: 'mistral-medium-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
    limitsUrl: 'https://admin.mistral.ai/plateforme/limits',
  },
};

export function isChatProvider(value: unknown): value is ChatProvider {
  return typeof value === 'string' && (CHAT_PROVIDERS as readonly string[]).includes(value);
}

export function resolveModel(provider: ChatProvider, requested: unknown): string {
  const info = PROVIDER_INFO[provider];
  if (typeof requested === 'string' && info.models.some((model) => model.id === requested)) {
    return requested;
  }
  return info.defaultModel;
}
