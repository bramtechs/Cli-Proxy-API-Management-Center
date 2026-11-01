import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import {
  MistralQuotaBody,
  OpenRouterQuotaBody,
} from '@/features/quota/providers/apiKey/ApiKeyQuotaBody';
import { buildApiKeyQuotaFiles } from '@/features/quota/providers/apiKey/compat';
import type { ApiKeyQuotaState } from '@/types';

const classes = {} as never;
const quota: ApiKeyQuotaState = { status: 'success', rows: [], details: [] };

describe('Mistral console cookie entry', () => {
  test('the Mistral card offers the console session form', () => {
    buildApiKeyQuotaFiles([]);
    const markup = renderToStaticMarkup(
      createElement(MistralQuotaBody, { quota, classes, onRefresh: () => {} })
    );
    expect(markup).toContain(i18n.t('mistral_quota.console_cookie_connect'));
    expect(markup).toContain('type="button"');
  });

  test('the OpenRouter card does not', () => {
    const markup = renderToStaticMarkup(
      createElement(OpenRouterQuotaBody, { quota, classes, onRefresh: () => {} })
    );
    expect(markup).not.toContain(i18n.t('mistral_quota.console_cookie_connect'));
  });
});
