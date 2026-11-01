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
  /**
   * Auth-index of the `console.mistral.ai` config entry that holds the console session
   * cookie, when one is configured. Read-only: it is never used for inference.
   */
  consoleAuthIndex?: string;
}

export const isApiKeyQuotaFile = (file: AuthFileItem): file is ApiKeyQuotaFile =>
  file['quotaSource'] === API_KEY_QUOTA_SOURCE;

export const isApiKeyQuotaFileFor = (file: AuthFileItem, provider: ApiKeyQuotaProvider): boolean =>
  isApiKeyQuotaFile(file) && file.provider === provider;

/** Host of the console entry whose `api-key` is the Mistral console session cookie. */
export const MISTRAL_CONSOLE_HOST = 'console.mistral.ai';

/** Base URL stored on that entry; only the billing endpoints are ever called. */
export const MISTRAL_CONSOLE_BASE_URL = 'https://console.mistral.ai/api/billing/v2';

/** Name given to the console entry when the dashboard creates it. */
export const MISTRAL_CONSOLE_PROVIDER_NAME = 'mistral-console';

const isMistralConsoleBaseUrl = (baseUrl: unknown): boolean => {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return false;
  const url = parseUrl(baseUrl);
  return url !== null && url.hostname.toLowerCase() === MISTRAL_CONSOLE_HOST;
};

/**
 * Auth-index discovered by the last `buildApiKeyQuotaFiles` call.
 *
 * Quota bodies only receive their own file, so a card refreshed right after the cookie is
 * saved would otherwise keep using the pre-save index (usually none at all).
 */
let currentConsoleAuthIndex: string | null = null;

export const getMistralConsoleAuthIndex = (): string | null => currentConsoleAuthIndex;

/**
 * Auth-index of the first enabled `console.mistral.ai` provider key, if any.
 *
 * That entry holds the console session cookie instead of an inference key, so it never
 * produces a quota card of its own; the Mistral card borrows its auth-index to read the
 * monthly included-budget endpoint through api-call.
 */
export function findMistralConsoleAuthIndex(
  providers: readonly OpenAIProviderConfig[]
): string | null {
  for (const provider of providers) {
    if (provider.disabled || !isMistralConsoleBaseUrl(provider.baseUrl)) continue;
    for (const entry of provider.apiKeyEntries ?? []) {
      const authIndex = normalizeAuthIndex(entry.authIndex);
      if (authIndex) return authIndex;
    }
  }
  return null;
}

/**
 * Provider config that stores a console session cookie, reusing the existing entry (and
 * its `source`, which the update call needs) when the dashboard already created one.
 */
export function buildMistralConsoleProviderConfig(
  providers: readonly OpenAIProviderConfig[],
  cookie: string
): { config: OpenAIProviderConfig; existing: OpenAIProviderConfig | null } {
  const existing = providers.find((provider) => isMistralConsoleBaseUrl(provider.baseUrl)) ?? null;
  const config: OpenAIProviderConfig = {
    ...(existing ?? {}),
    name: existing?.name || MISTRAL_CONSOLE_PROVIDER_NAME,
    baseUrl: MISTRAL_CONSOLE_BASE_URL,
    apiKeyEntries: [{ apiKey: cookie.trim() }],
    models: [],
    disabled: false,
  };
  return { config, existing };
}

/**
 * One entry per enabled key of every recognised OpenAI-compatible provider.
 * Keys without an auth-index are skipped: the api-call endpoint cannot resolve them.
 */
export function buildApiKeyQuotaFiles(
  providers: readonly OpenAIProviderConfig[]
): ApiKeyQuotaFile[] {
  const files: ApiKeyQuotaFile[] = [];
  const usedNames = new Set<string>();
  const consoleAuthIndex = findMistralConsoleAuthIndex(providers);
  currentConsoleAuthIndex = consoleAuthIndex;
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
        ...(kind === 'mistral' && consoleAuthIndex ? { consoleAuthIndex } : {}),
      });
    });
  }
  return files;
}
