export interface Config {
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  hosted?: boolean;
  allowedProviderUrls?: string[];
  /** Never included in ReviewSession or analysis exports. */
  apiKey?: string;
  remember?: boolean;
}
export const PROVIDER_STORAGE_KEY = 'blotlens.provider.v1';

export function restoreProvider(config: Config, storage: Pick<Storage, 'getItem' | 'removeItem'>): Config {
  if (!config.hosted) return config;
  try {
    const raw = storage.getItem(PROVIDER_STORAGE_KEY);
    if (!raw) return config;
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !config.allowedProviderUrls?.includes(value.baseUrl) ||
      typeof value.model !== 'string' || !value.model.trim() || value.model.length > 256 ||
      /[\u0000-\u001f]/.test(value.model) || typeof value.apiKey !== 'string' ||
      !value.apiKey.trim() || value.apiKey.length > 4096 || /[\u0000-\u001f\u007f-\uffff]/.test(value.apiKey)) {
      storage.removeItem(PROVIDER_STORAGE_KEY);
      return config;
    }
    return { ...config, baseUrl: value.baseUrl, model: value.model, apiKey: value.apiKey, keyConfigured: true, remember: true };
  } catch { return config; }
}

export function persistProvider(config: Config, storage: Pick<Storage, 'setItem' | 'removeItem'>): void {
  if (!config.hosted) return;
  if (!config.remember || !config.apiKey) storage.removeItem(PROVIDER_STORAGE_KEY);
  else storage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify({ version: 1, baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey }));
}
