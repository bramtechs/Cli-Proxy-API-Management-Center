import { afterEach, describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import type { OpenAIProviderConfig } from '@/types';
import { classifyQuotaFiles } from '@/features/quota/logic';
import {
  buildApiKeyQuotaFiles,
  resolveApiKeyQuotaProvider,
} from '@/features/quota/providers/apiKey/compat';
import {
  MISTRAL_CONFIG,
  parseMistralBudget,
  parseMistralRateLimitRows,
  pickMistralProbeModel,
} from '@/features/quota/providers/mistral/data';
import {
  OPENROUTER_CONFIG,
  buildOpenRouterQuota,
  nextUtcReset,
  resolveOpenRouterApiBase,
} from '@/features/quota/providers/openrouter/data';
import { apiCallApi, type ApiCallRequest, type ApiCallResult } from '@/services/api';

const t = ((key: string) => key) as unknown as TFunction;
const originalApiCallRequest = apiCallApi.request;

afterEach(() => {
  apiCallApi.request = originalApiCallRequest;
});

const provider = (overrides: Partial<OpenAIProviderConfig>): OpenAIProviderConfig => ({
  name: 'mistral',
  baseUrl: 'https://api.mistral.ai/v1/',
  apiKeyEntries: [{ apiKey: 'sk-1', authIndex: 'idx-1' }],
  models: [{ name: 'mistral-embed' }, { name: 'mistral-large-latest' }],
  ...overrides,
});

describe('API-key quota entries', () => {
  test('recognises Mistral and OpenRouter base URLs only', () => {
    expect(resolveApiKeyQuotaProvider('https://api.mistral.ai/v1')).toBe('mistral');
    expect(resolveApiKeyQuotaProvider('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(resolveApiKeyQuotaProvider('https://api.openai.com/v1')).toBeNull();
    expect(resolveApiKeyQuotaProvider('https://evil.com/api.mistral.ai')).toBeNull();
    expect(resolveApiKeyQuotaProvider('not a url')).toBeNull();
  });

  test('builds one entry per key and skips disabled or index-less keys', () => {
    const files = buildApiKeyQuotaFiles([
      provider({
        apiKeyEntries: [
          { apiKey: 'sk-1', authIndex: 'idx-1' },
          { apiKey: 'sk-2' },
          { apiKey: 'sk-3', authIndex: 'idx-3' },
        ],
      }),
      provider({ name: 'off', disabled: true }),
      provider({ name: 'openai', baseUrl: 'https://api.openai.com/v1' }),
      provider({ name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', models: [] }),
    ]);

    expect(files.map((file) => [file.name, file.provider, file.authIndex])).toEqual([
      ['mistral #1', 'mistral', 'idx-1'],
      ['mistral #3', 'mistral', 'idx-3'],
      ['openrouter', 'openrouter', 'idx-1'],
    ]);
    expect(files[0].baseUrl).toBe('https://api.mistral.ai/v1');
    // Never carry the secret key into the quota page state.
    expect(JSON.stringify(files)).not.toContain('sk-');
  });

  test('entries classify into their own quota tabs', () => {
    const files = buildApiKeyQuotaFiles([
      provider({}),
      provider({ name: 'or', baseUrl: 'https://openrouter.ai/api/v1' }),
    ]);
    expect(classifyQuotaFiles(files).map((entry) => entry.type)).toEqual(['mistral', 'openrouter']);
    // An auth file that merely claims the provider type is not an API-key entry.
    expect(MISTRAL_CONFIG.filterFn({ name: 'x.json', type: 'mistral' })).toBe(false);
  });
});

describe('Mistral rate-limit parsing', () => {
  test('skips non-chat models when picking the probe model', () => {
    expect(pickMistralProbeModel(['mistral-embed', 'codestral-latest'])).toBe('codestral-latest');
    expect(pickMistralProbeModel([])).toBe('mistral-small-latest');
  });

  test('pairs limit and remaining headers, ordered by window', () => {
    const rows = parseMistralRateLimitRows(
      {
        'X-Ratelimit-Limit-Tokens-Minute': ['100000'],
        'X-Ratelimit-Remaining-Tokens-Minute': ['99983'],
        'X-Ratelimit-Limit-Req-Minute': ['100'],
        'X-Ratelimit-Remaining-Req-Minute': ['99'],
        'X-Ratelimit-Limit-Tokens-Month': ['1000000000'],
        'X-Ratelimit-Remaining-Tokens-Month': ['999000000'],
        'X-Ratelimit-Limit-Tokens-Hour': ['5'],
        'X-Ratelimit-Tokens-Query-Cost': ['17'],
      },
      t
    );
    expect(rows.map((row) => [row.id, row.used, row.limit, row.unit])).toEqual([
      ['mistral:req:minute', 1, 100, 'count'],
      ['mistral:tokens:minute', 17, 100000, 'tokens'],
      ['mistral:tokens:month', 1000000, 1000000000, 'tokens'],
    ]);
  });

  test('a refresh sends one minimal completion and reports the limits', async () => {
    const calls: ApiCallRequest[] = [];
    apiCallApi.request = async (payload: ApiCallRequest): Promise<ApiCallResult> => {
      calls.push(payload);
      return {
        statusCode: 200,
        header: {
          'X-Ratelimit-Limit-Req-Minute': ['100'],
          'X-Ratelimit-Remaining-Req-Minute': ['99'],
          'X-Ratelimit-Tokens-Query-Cost': ['17'],
        },
        bodyText: '{}',
        body: {},
      };
    };
    const [file] = buildApiKeyQuotaFiles([provider({})]);
    const data = await MISTRAL_CONFIG.fetchQuota(file, t);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(calls[0].header?.Authorization).toBe('Bearer $TOKEN$');
    expect(JSON.parse(calls[0].data ?? '{}')).toMatchObject({
      model: 'mistral-large-latest',
      max_tokens: 1,
    });
    expect(data.rows).toHaveLength(1);
    expect(data.note).toBe('mistral_quota.minute_only_note');
  });

  test('a 429 with headers still reports the exhausted limits', async () => {
    apiCallApi.request = async (): Promise<ApiCallResult> => ({
      statusCode: 429,
      header: {
        'X-Ratelimit-Limit-Req-Minute': ['100'],
        'X-Ratelimit-Remaining-Req-Minute': ['0'],
      },
      bodyText: '{"message":"Requests rate limit exceeded"}',
      body: { message: 'Requests rate limit exceeded' },
    });
    const [file] = buildApiKeyQuotaFiles([provider({})]);
    const data = await MISTRAL_CONFIG.fetchQuota(file, t);
    expect(data.rows[0]).toMatchObject({ used: 100, limit: 100 });
    expect(data.note).toBe('mistral_quota.rate_limited');
  });

  test('an auth error without headers fails the card', async () => {
    apiCallApi.request = async (): Promise<ApiCallResult> => ({
      statusCode: 401,
      header: {},
      bodyText: '{"message":"Unauthorized"}',
      body: { message: 'Unauthorized' },
    });
    const [file] = buildApiKeyQuotaFiles([provider({})]);
    await expect(MISTRAL_CONFIG.fetchQuota(file, t)).rejects.toThrow('401 Unauthorized');
  });
});

describe('Mistral included monthly budget', () => {
  const consoleProvider = (overrides: Partial<OpenAIProviderConfig> = {}) =>
    provider({
      name: 'mistral-console',
      baseUrl: 'https://console.mistral.ai/api/billing/v2',
      apiKeyEntries: [{ apiKey: 'ory_session_x=1', authIndex: 'idx-console' }],
      models: [],
      ...overrides,
    });

  const budgetBody = {
    vibe_budget: { usage_percentage: 0, initial_budget: 8.5, currency: 'EUR' },
    api_budget: {
      usage_percentage: 10.94,
      initial_budget: 8.5,
      currency: 'EUR',
      reset_at: '2026-12-01T00:00:00Z',
      payg_enabled: false,
    },
    usage_percentage: 10.94,
    initial_budget: 8.5,
    currency: 'EUR',
    reset_at: '2026-12-01T00:00:00Z',
  };

  test('the console entry lends its auth-index and produces no card of its own', () => {
    const files = buildApiKeyQuotaFiles([provider({}), consoleProvider()]);
    expect(files).toHaveLength(1);
    expect(files[0].provider).toBe('mistral');
    expect(files[0].consoleAuthIndex).toBe('idx-console');
    // The session cookie never reaches the quota page state.
    expect(JSON.stringify(files)).not.toContain('ory_session');
  });

  test('maps the console payload to a monthly currency row', () => {
    const { row, details } = parseMistralBudget(budgetBody, t);
    expect(row).toMatchObject({
      id: 'mistral:monthly-budget',
      label: 'mistral_quota.monthly_budget',
      limit: 8.5,
      unit: 'currency',
      currency: 'EUR',
      periodHours: null,
    });
    expect(row?.used).toBeCloseTo(0.9299, 6);
    expect(row?.resetAtMs).toBe(Date.parse('2026-12-01T00:00:00Z'));
    expect(details.map((detail) => detail.id)).toEqual(['budget-spent']);
  });

  test('falls back to the root budget fields and ignores unusable payloads', () => {
    const { row } = parseMistralBudget(
      { usage_percentage: 50, initial_budget: 4, currency: 'USD', reset_at: null },
      t
    );
    expect(row).toMatchObject({ used: 2, limit: 4, currency: 'USD', resetAtMs: null });
    expect(parseMistralBudget({ api_budget: { initial_budget: 0 } }, t).row).toBeNull();
    expect(parseMistralBudget(null, t).row).toBeNull();
  });

  test('a refresh reads the budget through the console cookie', async () => {
    const calls: ApiCallRequest[] = [];
    apiCallApi.request = async (payload: ApiCallRequest): Promise<ApiCallResult> => {
      calls.push(payload);
      if (payload.url.includes('console.mistral.ai')) {
        return { statusCode: 200, header: {}, bodyText: '{}', body: budgetBody };
      }
      return {
        statusCode: 200,
        header: {
          'X-Ratelimit-Limit-Req-Minute': ['100'],
          'X-Ratelimit-Remaining-Req-Minute': ['99'],
        },
        bodyText: '{}',
        body: {},
      };
    };
    const files = buildApiKeyQuotaFiles([provider({}), consoleProvider()]);
    const data = await MISTRAL_CONFIG.fetchQuota(files[0], t);

    const consoleCall = calls.find((call) => call.url.includes('console.mistral.ai'));
    expect(consoleCall?.url).toBe('https://console.mistral.ai/api/billing/v2/budget');
    expect(consoleCall?.header?.Cookie).toBe('$TOKEN$');
    expect(data.rows.map((row) => row.id)).toEqual(['mistral:monthly-budget', 'mistral:req:minute']);
    expect(data.note).toBeNull();
  });

  test('an expired console session keeps the rate limits and says why', async () => {
    apiCallApi.request = async (payload: ApiCallRequest): Promise<ApiCallResult> => {
      if (payload.url.includes('console.mistral.ai')) {
        return { statusCode: 401, header: {}, bodyText: '{"detail":null}', body: { detail: null } };
      }
      return {
        statusCode: 200,
        header: {
          'X-Ratelimit-Limit-Req-Minute': ['100'],
          'X-Ratelimit-Remaining-Req-Minute': ['99'],
        },
        bodyText: '{}',
        body: {},
      };
    };
    const files = buildApiKeyQuotaFiles([provider({}), consoleProvider()]);
    const data = await MISTRAL_CONFIG.fetchQuota(files[0], t);
    expect(data.rows.map((row) => row.id)).toEqual(['mistral:req:minute']);
    expect(data.note).toBe('mistral_quota.console_session_expired');
  });
});

describe('OpenRouter credits', () => {
  const NOW = Date.UTC(2026, 10, 1, 18, 30); // Sunday 2026-11-01 18:30 UTC

  test('computes calendar resets in UTC', () => {
    expect(nextUtcReset('daily', NOW)).toBe(Date.UTC(2026, 10, 2));
    expect(nextUtcReset('weekly', NOW)).toBe(Date.UTC(2026, 10, 2)); // next Monday
    expect(nextUtcReset('monthly', NOW)).toBe(Date.UTC(2026, 11, 1));
    expect(nextUtcReset(null, NOW)).toBeNull();
  });

  test('derives the API base from the configured origin', () => {
    expect(resolveOpenRouterApiBase('https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1'
    );
    expect(resolveOpenRouterApiBase('garbage')).toBe('https://openrouter.ai/api/v1');
  });

  test('maps credits, deduped budgets and free-model requests', () => {
    const data = buildOpenRouterQuota(
      {
        key: {
          data: {
            limit: 0,
            limit_reset: null,
            limit_remaining: 0,
            budgets: [
              {
                scope: 'workspace_default_member',
                guardrail_id: 'g1',
                limit_usd: 10,
                spend_usd: 2.5,
                remaining_usd: 7.5,
                reset_interval: 'daily',
                resets_at: '2026-11-02T00:00:00.000Z',
              },
              {
                scope: 'workspace_default_key',
                guardrail_id: 'g1',
                limit_usd: 10,
                spend_usd: 2.5,
                reset_interval: 'daily',
              },
              { scope: 'key_limit', limit_usd: 0 },
            ],
            usage_daily: 2.5,
            usage_weekly: 3,
            usage_monthly: 12.345,
            is_free_tier: false,
            free_model_daily_requests: { used: 40, limit: 1000, remaining: 960 },
          },
        },
        credits: { data: { total_credits: 164, total_usage: 163.818297705 } },
      },
      t,
      NOW
    );

    expect(data.rows.map((row) => [row.id, row.used, row.limit, row.unit])).toEqual([
      ['openrouter:credits', 163.818297705, 164, 'usd'],
      ['openrouter:budget:g1', 2.5, 10, 'usd'],
      ['openrouter:free-daily', 40, 1000, 'count'],
    ]);
    expect(data.rows[1].resetAtMs).toBe(Date.UTC(2026, 10, 2));
    expect(data.details?.map((detail) => [detail.id, detail.value])).toEqual([
      ['balance', '$0.18'],
      ['tier', 'openrouter_quota.tier_paid'],
      ['usage_daily', '$2.50'],
      ['usage_weekly', '$3.00'],
      ['usage_monthly', '$12.35'],
    ]);
    expect(data.note).toBeNull();
  });

  test('a key limit becomes its own row', () => {
    const data = buildOpenRouterQuota(
      { key: { data: { limit: 5, limit_remaining: 4, limit_reset: 'monthly' } } },
      t,
      NOW
    );
    expect(data.rows).toEqual([
      expect.objectContaining({ id: 'openrouter:key-limit', used: 1, limit: 5 }),
    ]);
    expect(data.rows[0].resetAtMs).toBe(Date.UTC(2026, 11, 1));
    expect(data.note).toBe('openrouter_quota.credits_unavailable');
  });

  test('a refresh reads /key and /credits through api-call without spending', async () => {
    const urls: string[] = [];
    apiCallApi.request = async (payload: ApiCallRequest): Promise<ApiCallResult> => {
      urls.push(`${payload.method} ${payload.url}`);
      const body = payload.url.endsWith('/credits')
        ? { data: { total_credits: 10, total_usage: 4 } }
        : { data: { is_free_tier: true } };
      return { statusCode: 200, header: {}, bodyText: JSON.stringify(body), body };
    };
    const [file] = buildApiKeyQuotaFiles([
      provider({ name: 'or', baseUrl: 'https://openrouter.ai/api/v1' }),
    ]);
    const data = await OPENROUTER_CONFIG.fetchQuota(file, t);
    expect(urls.sort()).toEqual([
      'GET https://openrouter.ai/api/v1/credits',
      'GET https://openrouter.ai/api/v1/key',
    ]);
    expect(data.details?.[0]).toMatchObject({ id: 'balance', value: '$6.00' });
  });
});

describe('v8 config auth index parsing', () => {
  test('reads auth_index from v8 openai-compatibility keys', async () => {
    const { normalizeProviderGroups } = await import('@/services/api/transformers');
    const [group] = normalizeProviderGroups(
      [
        {
          name: 'mistral',
          'base-url': 'https://api.mistral.ai/v1',
          keys: [{ 'api-key': 'sk-x', auth_index: '511d92c40517f6f2' }],
          models: [{ name: 'mistral-small-latest' }],
        },
      ],
      true
    ) as OpenAIProviderConfig[];
    expect(group.apiKeyEntries[0].authIndex).toBe('511d92c40517f6f2');
    expect(buildApiKeyQuotaFiles([group]).map((file) => file.authIndex)).toEqual([
      '511d92c40517f6f2',
    ]);
  });
});
