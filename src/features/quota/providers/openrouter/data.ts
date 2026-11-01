/**
 * OpenRouter quota data layer. React-free / SCSS-free.
 *
 * Reads `GET /api/v1/key` (key limits, budgets, free-model daily requests, spend) and
 * `GET /api/v1/credits` (account credit balance). Neither call consumes credits.
 */

import type { TFunction } from 'i18next';
import type {
  ApiKeyQuotaDetail,
  ApiKeyQuotaRow,
  AuthFileItem,
  OpenRouterQuotaState,
} from '@/types';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores/useQuotaStore';
import { createStatusError } from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { isRecord } from '@/utils/helpers';
import type { QuotaProviderData } from '../types';
import { isApiKeyQuotaFile, isApiKeyQuotaFileFor } from '../apiKey/compat';

type OpenRouterQuotaData = Pick<OpenRouterQuotaState, 'rows' | 'details' | 'note'>;

export const OPENROUTER_DEFAULT_API_BASE = 'https://openrouter.ai/api/v1';

/** The quota endpoints live under `/api/v1` on the configured origin. */
export const resolveOpenRouterApiBase = (baseUrl: string | undefined): string => {
  try {
    const url = new URL(String(baseUrl ?? ''));
    return `${url.origin}/api/v1`;
  } catch {
    return OPENROUTER_DEFAULT_API_BASE;
  }
};

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : null;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export const formatUsd = (value: number): string => {
  const abs = Math.abs(value);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  return `${value < 0 ? '-' : ''}$${abs.toFixed(digits)}`;
};

const INTERVAL_HOURS: Record<string, number> = { daily: 24, weekly: 24 * 7, monthly: 24 * 30 };

/** Next UTC boundary for OpenRouter's calendar resets (day, ISO week from Monday, month). */
export const nextUtcReset = (interval: string | null, nowMs: number): number | null => {
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (interval === 'daily') return Date.UTC(y, m, d + 1);
  if (interval === 'weekly') {
    const daysUntilMonday = (8 - now.getUTCDay()) % 7 || 7;
    return Date.UTC(y, m, d + daysUntilMonday);
  }
  if (interval === 'monthly') return Date.UTC(y, m + 1, 1);
  return null;
};

const parseIsoMs = (value: unknown): number | null => {
  const text = str(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
};

export interface OpenRouterPayloads {
  key: unknown;
  credits?: unknown;
}

export function buildOpenRouterQuota(
  payloads: OpenRouterPayloads,
  t: TFunction,
  nowMs: number = Date.now()
): OpenRouterQuotaData {
  const key = isRecord(payloads.key) && isRecord(payloads.key.data) ? payloads.key.data : {};
  const credits =
    isRecord(payloads.credits) && isRecord(payloads.credits.data) ? payloads.credits.data : null;
  const rows: ApiKeyQuotaRow[] = [];
  const details: ApiKeyQuotaDetail[] = [];

  const totalCredits = num(credits?.total_credits);
  const totalUsage = num(credits?.total_usage);
  if (totalCredits !== null && totalUsage !== null) {
    rows.push({
      id: 'openrouter:credits',
      label: t('openrouter_quota.credits'),
      used: totalUsage,
      limit: totalCredits,
      unit: 'usd',
      resetAtMs: null,
      periodHours: null,
    });
    details.push({
      id: 'balance',
      label: t('openrouter_quota.balance'),
      value: formatUsd(totalCredits - totalUsage),
    });
  }

  const keyLimit = num(key.limit);
  if (keyLimit !== null && keyLimit > 0) {
    const remaining = num(key.limit_remaining);
    const interval = str(key.limit_reset);
    rows.push({
      id: 'openrouter:key-limit',
      label: interval
        ? t('openrouter_quota.key_limit_interval', {
            interval: t(`openrouter_quota.interval_${interval}`, { defaultValue: interval }),
          })
        : t('openrouter_quota.key_limit'),
      used: remaining !== null ? Math.max(0, keyLimit - remaining) : (num(key.usage) ?? 0),
      limit: keyLimit,
      unit: 'usd',
      resetAtMs: nextUtcReset(interval, nowMs),
      periodHours: interval ? (INTERVAL_HOURS[interval] ?? null) : null,
    });
  }

  // Guardrail budgets: the same guardrail is reported once per scope, so dedupe.
  const seenBudgets = new Set<string>();
  const budgets = Array.isArray(key.budgets) ? key.budgets : [];
  budgets.forEach((budget, index) => {
    if (!isRecord(budget)) return;
    const scope = str(budget.scope) ?? 'budget';
    if (scope === 'key_limit') return; // Same as the key limit row above.
    const limit = num(budget.limit_usd);
    if (limit === null || limit <= 0) return;
    const interval = str(budget.reset_interval);
    const identity = str(budget.guardrail_id) ?? str(budget.budget_id) ?? `${scope}:${index}`;
    if (seenBudgets.has(identity)) return;
    seenBudgets.add(identity);
    const spend = num(budget.spend_usd);
    const remaining = num(budget.remaining_usd);
    const scopeLabel = t('openrouter_quota.budget');
    rows.push({
      id: `openrouter:budget:${identity}`,
      label: interval
        ? `${scopeLabel} · ${t(`openrouter_quota.interval_${interval}`, { defaultValue: interval })}`
        : scopeLabel,
      used: spend ?? (remaining !== null ? Math.max(0, limit - remaining) : 0),
      limit,
      unit: 'usd',
      resetAtMs: parseIsoMs(budget.resets_at) ?? nextUtcReset(interval, nowMs),
      periodHours: interval ? (INTERVAL_HOURS[interval] ?? null) : null,
    });
  });

  const freeDaily = isRecord(key.free_model_daily_requests) ? key.free_model_daily_requests : null;
  const freeLimit = num(freeDaily?.limit);
  if (freeDaily && freeLimit !== null && freeLimit > 0) {
    const used = num(freeDaily.used);
    const remaining = num(freeDaily.remaining);
    rows.push({
      id: 'openrouter:free-daily',
      label: t('openrouter_quota.free_daily_requests'),
      used: used ?? (remaining !== null ? Math.max(0, freeLimit - remaining) : 0),
      limit: freeLimit,
      unit: 'count',
      resetAtMs: nextUtcReset('daily', nowMs),
      periodHours: 24,
    });
  }

  if (typeof key.is_free_tier === 'boolean') {
    details.push({
      id: 'tier',
      label: t('openrouter_quota.tier'),
      value: key.is_free_tier ? t('openrouter_quota.tier_free') : t('openrouter_quota.tier_paid'),
    });
  }
  (
    [
      ['usage_daily', 'spend_today'],
      ['usage_weekly', 'spend_week'],
      ['usage_monthly', 'spend_month'],
    ] as const
  ).forEach(([field, labelKey]) => {
    const value = num(key[field]);
    if (value === null) return;
    details.push({ id: field, label: t(`openrouter_quota.${labelKey}`), value: formatUsd(value) });
  });

  const note = credits ? null : t('openrouter_quota.credits_unavailable');
  return { rows, details, note };
}

const fetchOpenRouterQuota = async (
  file: AuthFileItem,
  t: TFunction
): Promise<OpenRouterQuotaData> => {
  const authIndex = normalizeAuthIndex(file.authIndex);
  if (!authIndex || !isApiKeyQuotaFile(file)) {
    throw new Error(t('openrouter_quota.missing_auth_index'));
  }

  const generation = captureQuotaCacheGeneration(file.name);
  const apiBase = resolveOpenRouterApiBase(file.baseUrl);
  const request = (path: string) =>
    apiCallApi.request({
      authIndex,
      method: 'GET',
      url: `${apiBase}${path}`,
      header: { Authorization: 'Bearer $TOKEN$', Accept: 'application/json' },
    });

  const [keyResult, creditsResult] = await Promise.all([
    request('/key'),
    request('/credits').catch(() => null),
  ]);
  if (!commitIfQuotaCacheCurrent(generation, () => {})) {
    throw new Error(t('openrouter_quota.stale_request'));
  }
  if (keyResult.statusCode < 200 || keyResult.statusCode >= 300) {
    throw createStatusError(getApiCallErrorMessage(keyResult), keyResult.statusCode);
  }
  const creditsOk =
    creditsResult && creditsResult.statusCode >= 200 && creditsResult.statusCode < 300;

  return buildOpenRouterQuota(
    { key: keyResult.body, credits: creditsOk ? creditsResult.body : undefined },
    t
  );
};

export const OPENROUTER_CONFIG: QuotaProviderData<OpenRouterQuotaState, OpenRouterQuotaData> = {
  type: 'openrouter',
  i18nPrefix: 'openrouter_quota',
  filterFn: (file) => isApiKeyQuotaFileFor(file, 'openrouter'),
  fetchQuota: fetchOpenRouterQuota,
  storeSelector: (state) => state.openrouterQuota,
  storeSetter: 'setOpenrouterQuota',
  buildLoadingState: () => ({ status: 'loading', rows: [] }),
  buildSuccessState: (data) => ({ status: 'success', ...data }),
  buildErrorState: (message, status) => ({
    status: 'error',
    rows: [],
    error: message,
    errorStatus: status,
  }),
};
