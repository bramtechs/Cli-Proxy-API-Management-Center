/**
 * Quota entries for OpenAI-compatible providers configured with plain API keys.
 *
 * These credentials live in config (`api-keys.openai-compatibility`), not in auth files,
 * so the quota page synthesizes one card per key. Each card carries the key's
 * auth-index; the management api-call endpoint substitutes the key for `$TOKEN$`,
 * so the key itself never reaches the browser.
 *
 * React-free: consumed directly by bun tests.
 */

import type { AuthFileItem, OpenAIProviderConfig } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';

export type ApiKeyQuotaProvider = 'mistral' | 'openrouter';

/** Quota tabs fed only by config API keys; auth files of these types keep plugin cards. */
export const API_KEY_QUOTA_PROVIDERS: ReadonlySet<string> = new Set<ApiKeyQuotaProvider>([
  'mistral',
  'openrouter',
]);

/** Marker set on synthesized entries so they never match auth-file based adapters. */
export const API_KEY_QUOTA_SOURCE = 'openai-compatibility';

const HOST_MATCHERS: Array<{ provider: ApiKeyQuotaProvider; hosts: string[] }> = [
  { provider: 'mistral', hosts: ['api.mistral.ai'] },
  { provider: 'openrouter', hosts: ['openrouter.ai'] },
];

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
};

export const resolveApiKeyQuotaProvider = (baseUrl: unknown): ApiKeyQuotaProvider | null => {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null;
  const url = parseUrl(baseUrl);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const match = HOST_MATCHERS.find(({ hosts }) =>
    hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))
  );
  return match?.provider ?? null;
};

/** Base URL without trailing slashes, e.g. `https://api.mistral.ai/v1`. */
export const trimBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '');

export interface ApiKeyQuotaFile extends AuthFileItem {
  quotaSource: typeof API_KEY_QUOTA_SOURCE;
  type: ApiKeyQuotaProvider;
  provider: ApiKeyQuotaProvider;
  baseUrl: string;
  /** Upstream model names configured for the provider, in config order. */
  models: string[];
  providerName: string;
}

export const isApiKeyQuotaFile = (file: AuthFileItem): file is ApiKeyQuotaFile =>
  file['quotaSource'] === API_KEY_QUOTA_SOURCE;

export const isApiKeyQuotaFileFor = (file: AuthFileItem, provider: ApiKeyQuotaProvider): boolean =>
  isApiKeyQuotaFile(file) && file.provider === provider;

/**
 * One entry per enabled key of every recognised OpenAI-compatible provider.
 * Keys without an auth-index are skipped: the api-call endpoint cannot resolve them.
 */
export function buildApiKeyQuotaFiles(
  providers: readonly OpenAIProviderConfig[]
): ApiKeyQuotaFile[] {
  const files: ApiKeyQuotaFile[] = [];
  const usedNames = new Set<string>();
  for (const provider of providers) {
    if (provider.disabled) continue;
    const kind = resolveApiKeyQuotaProvider(provider.baseUrl);
    if (!kind) continue;
    const entries = provider.apiKeyEntries ?? [];
    const models = (provider.models ?? [])
      .map((model) => (typeof model?.name === 'string' ? model.name.trim() : ''))
      .filter(Boolean);
    const providerName = String(provider.name ?? '').trim() || kind;
    entries.forEach((entry, index) => {
      const authIndex = normalizeAuthIndex(entry.authIndex);
      if (!authIndex) return;
      const baseName = entries.length > 1 ? `${providerName} #${index + 1}` : providerName;
      let name = baseName;
      for (let suffix = 2; usedNames.has(name); suffix += 1) name = `${baseName} (${suffix})`;
      usedNames.add(name);
      files.push({
        name,
        type: kind,
        provider: kind,
        authIndex,
        quotaSource: API_KEY_QUOTA_SOURCE,
        baseUrl: trimBaseUrl(provider.baseUrl),
        models,
        providerName,
      });
    });
  }
  return files;
}
