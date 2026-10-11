import { describe, it, expect } from 'vitest';
import { persistProvider, restoreProvider, PROVIDER_STORAGE_KEY, type Config } from './provider-config';
const base: Config = { hosted: true, baseUrl: 'https://api.deepseek.com/v1', allowedProviderUrls: ['https://api.deepseek.com/v1'], model: '', keyConfigured: false };
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
describe('opt-in browser provider storage', () => {
  it('defaults to no saved credentials; restores only explicitly saved, currently allowed providers', () => {
    const store = storage();
    const value = { ...base, model: 'deepseek-flash', apiKey: 'test-only-secret' };
    persistProvider(value, store); expect(store.getItem(PROVIDER_STORAGE_KEY)).toBeNull();
    persistProvider({ ...value, remember: true }, store);
    expect(restoreProvider(base, store)).toMatchObject({ ...value, keyConfigured: true, remember: true });
    expect(restoreProvider({ ...base, allowedProviderUrls: [] }, store)).toMatchObject({ keyConfigured: false });
    expect(store.getItem(PROVIDER_STORAGE_KEY)).toBeNull();
  });
  it('removes saved credentials on opt-out or clearing and ignores storage in local mode', () => {
    const store = storage(); const value = { ...base, model: 'model', apiKey: 'secret', remember: true };
    persistProvider(value, store);
    expect(restoreProvider({ ...base, hosted: false }, store)).not.toHaveProperty('apiKey');
    persistProvider({ ...value, remember: false }, store); expect(store.getItem(PROVIDER_STORAGE_KEY)).toBeNull();
    persistProvider(value, store);
    persistProvider({ ...value, apiKey: '' }, store); expect(store.getItem(PROVIDER_STORAGE_KEY)).toBeNull();
  });
  it('survives malformed or blocked storage without accepting unvalidated credentials', () => {
    const store = storage(); store.setItem(PROVIDER_STORAGE_KEY, '{');
    expect(restoreProvider(base, store)).toEqual(base);
    expect(restoreProvider(base, { ...store, getItem: () => { throw Error('blocked'); } })).toEqual(base);
  });
});
