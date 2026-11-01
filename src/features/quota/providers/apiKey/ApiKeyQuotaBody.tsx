/**
 * Shared quota body for API-key providers (Mistral, OpenRouter): detail chips plus
 * one meter per limit window, showing remaining amount, cap and reset.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiKeyQuotaRow, ApiKeyQuotaState } from '@/types';
import { buildResetDisplay } from '@/utils/quota';
import { useNow } from '@/hooks/useNow';
import { QuotaMeter } from '../../components/QuotaMeter';
import { QuotaResetLabel } from '../../components/QuotaResetLabel';
import { collectQuotaRowInstants, pickUrgentRowId } from '../../resetSchedule';
import { getMistralConsoleAuthIndex } from '../apiKey/compat';
import { ConsoleSessionForm } from '../mistral/ConsoleSessionForm';
import type { QuotaBodyProps } from '../../types';
import type { QuotaProviderType } from '../types';

const formatAmount = (
  value: number,
  unit: ApiKeyQuotaRow['unit'],
  locale?: string,
  currency?: string | null
): string => {
  if (unit === 'usd') {
    const abs = Math.abs(value);
    const digits = abs > 0 && abs < 0.01 ? 4 : 2;
    return `${value < 0 ? '-' : ''}$${abs.toFixed(digits)}`;
  }
  if (unit === 'currency') {
    const code = (currency ?? 'USD').toUpperCase();
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: code,
        maximumFractionDigits: Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 2,
      }).format(value);
    } catch {
      return `${value.toFixed(2)} ${code}`;
    }
  }
  return new Intl.NumberFormat(locale, {
    notation: value >= 100_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
};

const remainingPercent = (row: Pick<ApiKeyQuotaRow, 'used' | 'limit'>): number | null =>
  row.limit > 0
    ? Math.max(0, Math.min(100, Math.round(((row.limit - row.used) / row.limit) * 100)))
    : null;

function ApiKeyQuotaBody({
  provider,
  quota,
  classes,
  onRefresh,
}: QuotaBodyProps<ApiKeyQuotaState> & { provider: QuotaProviderType }) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const locale = i18n.resolvedLanguage;
  const soonestRowId = useMemo(
    () => pickUrgentRowId(collectQuotaRowInstants(provider, quota), now),
    [provider, quota, now]
  );
  const rows = quota.rows ?? [];
  const details = quota.details ?? [];

  return (
    <>
      {details.length > 0 && (
        <div className={classes.codexPlan}>
          {details.map((detail) => (
            <span key={detail.id} className={classes.codexPlanItem}>
              <span className={classes.codexPlanLabel}>{detail.label}</span>
              <span className={classes.codexPlanValue} style={{ textTransform: 'none' }}>
                {detail.value}
              </span>
            </span>
          ))}
        </div>
      )}
      {rows.length === 0 && (
        <div className={classes.quotaMessage}>{t('api_key_quota.empty_data')}</div>
      )}
      {rows.map((row, index) => {
        const remaining = remainingPercent(row);
        const resetDisplay = buildResetDisplay(null, row.resetAtMs, now, locale);
        const soon = row.id === soonestRowId;
        const amount =
          row.limit > 0
            ? t('api_key_quota.amount_left', {
                remaining: formatAmount(
                  Math.max(0, row.limit - row.used),
                  row.unit,
                  locale,
                  row.currency
                ),
                limit: formatAmount(row.limit, row.unit, locale, row.currency),
              })
            : t('api_key_quota.amount_used', {
                used: formatAmount(row.used, row.unit, locale, row.currency),
              });

        return (
          <div
            key={row.id}
            className={classes.quotaRow}
            title={soon ? t('quota_management.soonest_row_hint') : undefined}
          >
            <div className={classes.quotaRowHeader}>
              <span className={classes.quotaModel}>{row.label}</span>
              <div className={classes.quotaMeta}>
                <span className={classes.quotaPercent}>
                  {remaining === null ? '--' : `${remaining}%`}
                </span>
                {resetDisplay && (
                  <QuotaResetLabel display={resetDisplay} classes={classes} soon={soon} />
                )}
              </div>
            </div>
            <QuotaMeter percent={remaining} classes={classes} index={index} />
            <span className={classes.quotaAmount}>{amount}</span>
          </div>
        );
      })}
      {quota.note && <div className={classes.quotaMessage}>{quota.note}</div>}
      {provider === 'mistral' && (
        <ConsoleSessionForm hasSession={Boolean(getMistralConsoleAuthIndex())} onSaved={onRefresh} />
      )}
    </>
  );
}

export function MistralQuotaBody(props: QuotaBodyProps<ApiKeyQuotaState>) {
  return <ApiKeyQuotaBody provider="mistral" {...props} />;
}

export function OpenRouterQuotaBody(props: QuotaBodyProps<ApiKeyQuotaState>) {
  return <ApiKeyQuotaBody provider="openrouter" {...props} />;
}
