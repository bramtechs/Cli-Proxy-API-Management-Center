/**
 * Mistral quota data layer. React-free / SCSS-free.
 *
 * Mistral has no usage API for plain API keys: rate-limit state is only reported as
 * `x-ratelimit-*` response headers on inference calls. A refresh therefore sends one
 * minimal chat completion (`max_tokens: 1`, a few tokens of quota) and reads the headers.
 * Limits are per model, so the probe uses the provider's first configured model.
 */

import type { TFunction } from 'i18next';
import type { ApiKeyQuotaDetail, ApiKeyQuotaRow, AuthFileItem, MistralQuotaState } from '@/types';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores/useQuotaStore';
import { createStatusError } from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/authIndex';
import type { QuotaProviderData } from '../types';
import { isApiKeyQuotaFile, isApiKeyQuotaFileFor } from '../apiKey/compat';

export const MISTRAL_DEFAULT_PROBE_MODEL = 'mistral-small-latest';

/** Models that cannot serve a chat completion probe. */
const NON_CHAT_MODEL_PATTERN = /(embed|moderation|ocr|fim|voxtral|transcribe|tts)/i;

type MistralQuotaData = Pick<MistralQuotaState, 'rows' | 'details' | 'note'>;

export const pickMistralProbeModel = (models: readonly string[] | undefined): string =>
  (models ?? []).find((model) => model && !NON_CHAT_MODEL_PATTERN.test(model)) ??
  MISTRAL_DEFAULT_PROBE_MODEL;

const WINDOW_HOURS: Record<string, number> = {
  second: 1 / 3600,
  minute: 1 / 60,
  hour: 1,
  day: 24,
  week: 24 * 7,
  month: 24 * 30,
};

const WINDOW_ORDER = ['second', 'minute', 'hour', 'day', 'week', 'month'];

const headerValue = (headers: Record<string, string[] | string>, name: string): string | null => {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' ? first.trim() : null;
  }
  return null;
};

const toNumber = (value: string | null): number | null => {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Parse every `x-ratelimit-limit-<metric>-<window>` header that has a matching
 * `x-ratelimit-remaining-<metric>-<window>` into a quota row.
 */
export function parseMistralRateLimitRows(
  headers: Record<string, string[] | string>,
  t: TFunction
): ApiKeyQuotaRow[] {
  const rows: Array<ApiKeyQuotaRow & { order: number }> = [];
  for (const key of Object.keys(headers)) {
    const match = /^x-ratelimit-limit-([a-z]+)-([a-z]+)$/i.exec(key);
    if (!match) continue;
    const metric = match[1].toLowerCase();
    const window = match[2].toLowerCase();
    const limit = toNumber(headerValue(headers, key));
    const remaining = toNumber(headerValue(headers, `x-ratelimit-remaining-${metric}-${window}`));
    if (limit === null || remaining === null) continue;
    const isTokens = metric.startsWith('token');
    const metricLabel = isTokens
      ? t('mistral_quota.metric_tokens')
      : metric.startsWith('req')
        ? t('mistral_quota.metric_requests')
        : metric;
    const windowLabel = t(`mistral_quota.window_${window}`, { defaultValue: window });
    rows.push({
      id: `mistral:${metric}:${window}`,
      label: `${metricLabel} / ${windowLabel}`,
      used: Math.max(0, limit - remaining),
      limit,
      unit: isTokens ? 'tokens' : 'count',
      resetAtMs: null,
      periodHours: WINDOW_HOURS[window] ?? null,
      order: (WINDOW_ORDER.indexOf(window) + 1) * 10 + (isTokens ? 1 : 0),
    });
  }
  return rows.sort((a, b) => a.order - b.order).map(({ order: _order, ...row }) => row);
}

const fetchMistralQuota = async (file: AuthFileItem, t: TFunction): Promise<MistralQuotaData> => {
  const authIndex = normalizeAuthIndex(file.authIndex);
  if (!authIndex || !isApiKeyQuotaFile(file)) {
    throw new Error(t('mistral_quota.missing_auth_index'));
  }

  const generation = captureQuotaCacheGeneration(file.name);
  const model = pickMistralProbeModel(file.models);
  const result = await apiCallApi.request({
    authIndex,
    method: 'POST',
    url: `${file.baseUrl}/chat/completions`,
    header: {
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    data: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }],
    }),
  });
  if (!commitIfQuotaCacheCurrent(generation, () => {})) {
    throw new Error(t('mistral_quota.stale_request'));
  }

  const rows = parseMistralRateLimitRows(result.header ?? {}, t);
  const rateLimited = result.statusCode === 429;
  if ((result.statusCode < 200 || result.statusCode >= 300) && !(rateLimited && rows.length)) {
    throw createStatusError(getApiCallErrorMessage(result), result.statusCode);
  }

  const details: ApiKeyQuotaDetail[] = [
    { id: 'model', label: t('mistral_quota.probe_model'), value: model },
  ];
  const cost = toNumber(headerValue(result.header ?? {}, 'x-ratelimit-tokens-query-cost'));
  if (cost !== null) {
    details.push({
      id: 'cost',
      label: t('mistral_quota.probe_cost'),
      value: t('mistral_quota.probe_cost_value', { tokens: cost }),
    });
  }

  const hasLongWindow = rows.some((row) => (row.periodHours ?? 0) >= 24);
  const note = rateLimited
    ? t('mistral_quota.rate_limited')
    : hasLongWindow
      ? null
      : t('mistral_quota.minute_only_note');
  return { rows, details, note };
};

export const MISTRAL_CONFIG: QuotaProviderData<MistralQuotaState, MistralQuotaData> = {
  type: 'mistral',
  i18nPrefix: 'mistral_quota',
  filterFn: (file) => isApiKeyQuotaFileFor(file, 'mistral'),
  fetchQuota: fetchMistralQuota,
  storeSelector: (state) => state.mistralQuota,
  storeSetter: 'setMistralQuota',
  buildLoadingState: () => ({ status: 'loading', rows: [] }),
  buildSuccessState: (data) => ({ status: 'success', ...data }),
  buildErrorState: (message, status) => ({
    status: 'error',
    rows: [],
    error: message,
    errorStatus: status,
  }),
};
