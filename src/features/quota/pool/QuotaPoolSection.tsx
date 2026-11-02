/**
 * Pool charts: one card per provider showing what its accounts have left
 * together, recorded history from the quota recorder, and a projection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconChevronLeft } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import {
  defaultRecorderUrl,
  normalizeRecorderUrl,
  quotaRecorderApi,
} from '@/services/api/quotaRecorder';
import { useAuthStore } from '@/stores';
import type { ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import type { QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { QUOTA_TAB_ORDER, type QuotaTabId } from '../constants';
import type { QuotaFileEntry } from '../logic';
import {
  BURN_WINDOWS,
  FUTURE_USAGE_MODES,
  buildPoolAccounts,
  buildRecordedDrain,
  buildRecordedSeries,
  isPoolProvider,
  poolBurnRate,
  poolSpan,
  projectPool,
  sampleFromQuota,
  summarizePool,
  weightKey,
  type PoolSample,
  type PoolSnapshot,
} from './poolModel';
import { formatDuration, formatPercent, formatRate, niceCeiling } from './poolFormat';
import { readPoolSettings, writePoolSettings, type PoolSettings } from './poolSettings';
import { QuotaPoolChart } from './QuotaPoolChart';
import styles from './QuotaPool.module.scss';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** History before the span feeds carried-forward values and the weekly average. */
const HISTORY_LEAD_MS = 7 * DAY_MS;
const REFETCH_MS = 5 * 60_000;
/** Projection reaches at least this far even when the view ends sooner. */
const MIN_HORIZON_MS = 7 * DAY_MS;

/** Line colour per provider; brand-adjacent, readable on both themes. */
const POOL_COLORS: Partial<Record<QuotaProviderType, string>> = {
  claude: '#d97757',
  codex: '#6f8cff',
  antigravity: '#3fa4f0',
  xai: '#9a948d',
  kimi: '#7c6cf2',
  devin: '#2bb5a0',
  meta: '#4c7dff',
  plugin: '#c58b2c',
};

export interface QuotaPoolSectionProps {
  tab: QuotaTabId;
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  showEmails: boolean;
  /** Bumped by "Refresh all credentials": ask the recorder for a fresh sample. */
  refreshToken: number;
}

type LoadState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; snapshots: PoolSnapshot[]; intervalMs: number; lastPollAt: number | null }
  | { status: 'error'; message: string };

export function QuotaPoolSection(props: QuotaPoolSectionProps) {
  const { tab, entries, quotaFor, resolvedTheme, showEmails, refreshToken } = props;
  const { t, i18n } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const now = useNow();

  const [settings, setSettingsState] = useState<PoolSettings>(() => readPoolSettings());
  const updateSettings = useCallback((patch: Partial<PoolSettings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      writePoolSettings(next);
      return next;
    });
  }, []);

  const [offsetWeeks, setOffsetWeeks] = useState(0);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const span = useMemo(() => poolSpan(now, offsetWeeks), [now, offsetWeeks]);

  const recorderUrl = normalizeRecorderUrl(settings.recorderUrl) || defaultRecorderUrl(apiBase);

  /* ---------- history ---------- */

  const [load, setLoad] = useState<LoadState>({ status: 'idle' });
  const requestRef = useRef(0);
  const lastFetchRef = useRef(0);

  const fetchHistory = useCallback(
    async (pollFirst: boolean) => {
      if (!recorderUrl || !managementKey) return;
      const requestId = ++requestRef.current;
      lastFetchRef.current = Date.now();
      setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
      try {
        if (pollFirst)
          await quotaRecorderApi.poll(recorderUrl, managementKey).catch(() => undefined);
        const to = Math.max(Date.now(), span.endMs);
        const history = await quotaRecorderApi.history(
          recorderUrl,
          managementKey,
          span.startMs - HISTORY_LEAD_MS,
          to
        );
        if (requestId !== requestRef.current) return;
        setLoad({ status: 'ready', ...history });
      } catch (error) {
        if (requestId !== requestRef.current) return;
        setLoad({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [recorderUrl, managementKey, span.startMs, span.endMs]
  );

  useEffect(() => {
    void fetchHistory(false);
    return () => {
      requestRef.current += 1;
    };
  }, [fetchHistory]);

  // Minute clock drives a gentle refetch while the page stays open.
  useEffect(() => {
    if (Date.now() - lastFetchRef.current >= REFETCH_MS) void fetchHistory(false);
  }, [now, fetchHistory]);

  const refreshTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (refreshTokenRef.current === refreshToken) return;
    refreshTokenRef.current = refreshToken;
    void fetchHistory(true);
  }, [refreshToken, fetchHistory]);

  /* ---------- live samples from the cards ----------
   * A card refreshed on this page is newer than the recorder's last poll.
   * Stamp each quota state with the moment it first appeared so a stale state
   * is not mistaken for a sample taken "now". */

  const liveQuotas = useMemo(
    () =>
      entries.flatMap((entry) => {
        if (!isPoolProvider(entry.type)) return [];
        const quota = quotaFor(entry);
        return quota && quota.status === 'success' ? [{ entry, quota }] : [];
      }),
    [entries, quotaFor]
  );

  const [seenAt, setSeenAt] = useState(() => new WeakMap<object, number>());
  useEffect(() => {
    if (liveQuotas.every(({ quota }) => seenAt.has(quota))) return;
    const stamped = Date.now();
    setSeenAt((prev) => {
      const next = new WeakMap<object, number>();
      liveQuotas.forEach(({ quota }) => next.set(quota, prev.get(quota) ?? stamped));
      return next;
    });
  }, [liveQuotas, seenAt]);

  const liveSnapshots = useMemo<PoolSnapshot[]>(() => {
    const byTime = new Map<number, PoolSample[]>();
    liveQuotas.forEach(({ entry, quota }) => {
      const stamped = seenAt.get(quota);
      if (stamped === undefined) return;
      const label = entry.file.email?.trim() || entry.file.name;
      const sample = sampleFromQuota(
        { id: getQuotaCacheKey(entry.file), provider: entry.type, label },
        quota
      );
      if (!sample) return;
      byTime.set(stamped, [...(byTime.get(stamped) ?? []), sample]);
    });
    return [...byTime.entries()].map(([time, samples]) => ({ t: time, samples }));
  }, [liveQuotas, seenAt]);

  const snapshots = useMemo(
    () => [...(load.status === 'ready' ? load.snapshots : []), ...liveSnapshots],
    [load, liveSnapshots]
  );

  /* ---------- pools ---------- */

  const excluded = useMemo(() => new Set(settings.excluded), [settings.excluded]);

  const providers = useMemo(() => {
    const present = new Set<QuotaProviderType>();
    snapshots.forEach((snapshot) =>
      snapshot.samples.forEach((sample) => present.add(sample.provider))
    );
    return QUOTA_TAB_ORDER.filter(
      (type) => isPoolProvider(type) && present.has(type) && (tab === 'all' || tab === type)
    );
  }, [snapshots, tab]);

  const locale = i18n.language || undefined;
  const formatters = useMemo(() => {
    const time = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
    const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    const dayOfMonth = new Intl.DateTimeFormat(locale, { day: 'numeric' });
    const date = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
    return {
      time: (ms: number) => time.format(ms),
      // "Fri 23": weekday first reads better along an axis than the locale's "23 Fri".
      day: (ms: number) => `${weekday.format(ms)} ${dayOfMonth.format(ms)}`,
      date: (ms: number) => date.format(ms),
    };
  }, [locale]);

  /* ---------- render ---------- */

  const tabHasPoolProvider = tab === 'all' || isPoolProvider(tab);
  if (!tabHasPoolProvider) return null;

  const futureOptions = FUTURE_USAGE_MODES.map((mode) => ({
    value: mode,
    label: t(`quota_management.pool.future_${mode}`),
  }));

  const lastSpanDay = span.endMs - 1;

  return (
    <section className={styles.section} aria-label={t('quota_management.pool.section_label')}>
      <div className={styles.toolbar}>
        <div
          className={styles.segmented}
          role="group"
          aria-label={t('quota_management.pool.metric_label')}
        >
          {(['remaining', 'drain'] as const).map((metric) => (
            <button
              key={metric}
              type="button"
              aria-pressed={settings.metric === metric}
              onClick={() => updateSettings({ metric })}
            >
              {t(`quota_management.pool.metric_${metric}`)}
            </button>
          ))}
        </div>

        <div className={styles.labelled}>
          <span className={styles.controlLabel} id="pool-burn-label">
            {t('quota_management.pool.burn_rate')}
          </span>
          <div className={styles.segmented} role="group" aria-labelledby="pool-burn-label">
            {BURN_WINDOWS.map((hours) => (
              <button
                key={hours}
                type="button"
                aria-pressed={settings.burnWindow === hours}
                onClick={() => updateSettings({ burnWindow: hours })}
              >
                {t('quota_management.pool.hours', { hours })}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.labelled}>
          <span className={styles.controlLabel}>{t('quota_management.pool.future_usage')}</span>
          <Select
            value={settings.future}
            options={futureOptions}
            onChange={(value) => updateSettings({ future: value as PoolSettings['future'] })}
            ariaLabel={t('quota_management.pool.future_usage')}
            size="sm"
          />
        </div>

        <button type="button" className={styles.chip} onClick={() => setAccountsOpen(true)}>
          {t('quota_management.pool.accounts')}
        </button>

        <div className={styles.rangeNav}>
          <span className={styles.rangeText}>
            {t('quota_management.pool.range', {
              from: formatters.date(span.startMs),
              to: formatters.date(lastSpanDay),
            })}
          </span>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t('quota_management.pool.previous_week')}
            onClick={() => setOffsetWeeks((value) => value - 1)}
          >
            <IconChevronLeft size={16} />
          </button>
          <button
            type="button"
            className={styles.chip}
            aria-pressed={offsetWeeks === 0}
            onClick={() => setOffsetWeeks(0)}
          >
            {t('quota_management.pool.today')}
          </button>
          <button
            type="button"
            className={`${styles.iconButton} ${styles.flip}`}
            aria-label={t('quota_management.pool.next_week')}
            onClick={() => setOffsetWeeks((value) => value + 1)}
          >
            <IconChevronLeft size={16} />
          </button>
        </div>
      </div>

      {load.status === 'error' && (
        <div className={styles.notice} role="status">
          <strong>{t('quota_management.pool.recorder_unreachable_title')}</strong>
          <span>{t('quota_management.pool.recorder_unreachable_desc', { url: recorderUrl })}</span>
          <Button variant="secondary" size="sm" onClick={() => setAccountsOpen(true)}>
            {t('quota_management.pool.accounts')}
          </Button>
        </div>
      )}

      {(load.status === 'loading' || load.status === 'idle') && providers.length === 0 && (
        <Skeleton height={420} rounded={14} />
      )}

      {load.status === 'ready' && providers.length === 0 && (
        <div className={styles.notice} role="status">
          <span>
            {t('quota_management.pool.recorder_empty', {
              minutes: Math.round((load.intervalMs || 600_000) / 60_000),
            })}
          </span>
        </div>
      )}

      {providers.map((provider) => (
        <PoolCard
          key={provider}
          provider={provider}
          snapshots={snapshots}
          settings={settings}
          excluded={excluded}
          span={span}
          now={now}
          resolvedTheme={resolvedTheme}
          showEmails={showEmails}
          formatters={formatters}
        />
      ))}

      <PoolAccountsModal
        open={accountsOpen}
        onClose={() => setAccountsOpen(false)}
        snapshots={snapshots}
        settings={settings}
        updateSettings={updateSettings}
        showEmails={showEmails}
        defaultUrl={defaultRecorderUrl(apiBase)}
        lastPollAt={load.status === 'ready' ? load.lastPollAt : null}
        formatTime={formatters.time}
      />
    </section>
  );
}

/* ------------------------------------------------------------ card */

interface Formatters {
  time: (ms: number) => string;
  day: (ms: number) => string;
  date: (ms: number) => string;
}

interface PoolCardProps {
  provider: QuotaProviderType;
  snapshots: PoolSnapshot[];
  settings: PoolSettings;
  excluded: ReadonlySet<string>;
  span: { startMs: number; endMs: number };
  now: number;
  resolvedTheme: ResolvedTheme;
  showEmails: boolean;
  formatters: Formatters;
}

function PoolCard(props: PoolCardProps) {
  const {
    provider,
    snapshots,
    settings,
    excluded,
    span,
    now,
    resolvedTheme,
    showEmails,
    formatters,
  } = props;
  const { t } = useTranslation();
  const color = POOL_COLORS[provider] ?? 'var(--primary-color)';

  const accounts = useMemo(
    () => buildPoolAccounts(snapshots, provider, settings.weights, excluded),
    [snapshots, provider, settings.weights, excluded]
  );
  const summary = useMemo(() => summarizePool(accounts, now), [accounts, now]);
  const horizon = Math.max(span.endMs, now + MIN_HORIZON_MS);
  const projection = useMemo(
    () => projectPool(accounts, now, horizon, settings.burnWindow, settings.future),
    [accounts, now, horizon, settings.burnWindow, settings.future]
  );
  const recordedBurn = useMemo(
    () => poolBurnRate(accounts, now, settings.burnWindow),
    [accounts, now, settings.burnWindow]
  );
  const recorded = useMemo(
    () => buildRecordedSeries(accounts, span.startMs, Math.min(now, span.endMs)),
    [accounts, span.startMs, span.endMs, now]
  );
  const drain = useMemo(
    () =>
      settings.metric === 'drain'
        ? buildRecordedDrain(accounts, span.startMs, Math.min(now, span.endMs), settings.burnWindow)
        : [],
    [settings.metric, accounts, span.startMs, span.endMs, now, settings.burnWindow]
  );

  const weightLegend = useMemo(() => {
    const seen = new Map<string, { plan: string; weight: number }>();
    accounts.forEach((account) => {
      if (account.weight !== 1 && account.plan) {
        seen.set(account.plan, { plan: account.plan, weight: account.weight });
      }
    });
    return [...seen.values()];
  }, [accounts]);

  const icon = getAuthFileIcon(provider, resolvedTheme);
  const providerLabel = getTypeLabel(t, provider);
  const isDrain = settings.metric === 'drain';

  const drainMax = useMemo(() => {
    if (!isDrain) return 1;
    const values = [...drain, ...projection.drain].map((point) => point.value);
    return niceCeiling(Math.max(1, ...values) * 1.15);
  }, [isDrain, drain, projection.drain]);

  const masked = (label: string) => (
    <span className={showEmails ? undefined : styles.masked} aria-hidden={!showEmails || undefined}>
      {label}
    </span>
  );

  const poolEmptyValue =
    projection.poolEmptyAtMs === null
      ? t('quota_management.pool.not_by', { date: formatters.date(horizon) })
      : projection.poolEmptyAtMs <= now
        ? t('quota_management.pool.empty_now')
        : formatters.time(projection.poolEmptyAtMs);

  return (
    <article className={styles.card} style={{ ['--pool-color' as string]: color }}>
      <header className={styles.cardHead}>
        <div className={styles.cardTitle}>
          {icon && <img src={icon} alt="" className={styles.cardIcon} />}
          <h3>{providerLabel}</h3>
          <span className={styles.cardCount}>
            {t('quota_management.pool.account_count', { count: accounts.length })}
          </span>
        </div>
      </header>

      <div className={styles.cardBody}>
        <div className={styles.headline}>
          <span className={styles.bigNumber}>{formatPercent(summary.remaining)}</span>
          <span className={styles.capacity}>
            {t('quota_management.pool.of_capacity', { capacity: formatPercent(summary.capacity) })}
          </span>
          {weightLegend.map((item) => (
            <span key={item.plan} className={styles.capacity}>
              {t('quota_management.pool.weight_legend', { plan: item.plan, weight: item.weight })}
            </span>
          ))}
        </div>

        <dl className={styles.stats}>
          <div>
            <dt>{t('quota_management.pool.pool_empty')}</dt>
            <dd>{poolEmptyValue}</dd>
          </div>
          <div>
            <dt>{t('quota_management.pool.first_empty')}</dt>
            <dd>
              {projection.firstEmpty ? (
                <>
                  {masked(projection.firstEmpty.label)}{' '}
                  {projection.firstEmpty.atMs <= now
                    ? t('quota_management.pool.empty_now')
                    : t('quota_management.pool.in_duration', {
                        duration: formatDuration(projection.firstEmpty.atMs - now),
                      })}
                </>
              ) : (
                t('quota_management.pool.none')
              )}
            </dd>
          </div>
          <div>
            <dt>{t('quota_management.pool.next_reset')}</dt>
            <dd>
              {projection.nextReset
                ? `+${formatPercent(projection.nextReset.gain)} ${formatters.time(projection.nextReset.t)}`
                : t('quota_management.pool.none')}
            </dd>
          </div>
          <div>
            <dt>{t('quota_management.pool.burn_last', { hours: settings.burnWindow })}</dt>
            <dd>
              {recordedBurn === null ? t('quota_management.pool.none') : formatRate(recordedBurn)}
            </dd>
          </div>
        </dl>

        <QuotaPoolChart
          color={color}
          recorded={isDrain ? drain : recorded.points}
          recordedJumps={isDrain ? [] : recorded.jumps}
          projected={isDrain ? projection.drain : projection.points}
          projectedJumps={isDrain ? [] : projection.jumps}
          spanStartMs={span.startMs}
          spanEndMs={span.endMs}
          nowMs={now}
          yMax={isDrain ? drainMax : Math.max(100, summary.capacity)}
          emptyAtMs={isDrain ? null : projection.poolEmptyAtMs}
          formatValue={isDrain ? formatRate : formatPercent}
          tooltipValueKey={isDrain ? 'tooltip_drain' : 'tooltip_left'}
          formatTime={formatters.time}
          formatDay={formatters.day}
          ariaLabel={t('quota_management.pool.chart_label', {
            provider: providerLabel,
            value: formatPercent(summary.remaining),
            capacity: formatPercent(summary.capacity),
          })}
        />

        <div className={styles.legend}>
          <span className={styles.legendTitle}>{t('quota_management.pool.legend_pool')}</span>
          <span className={styles.legendItem}>
            <span className={styles.legendSolid} aria-hidden="true" />
            {t('quota_management.pool.legend_recorded')}
          </span>
          <span className={styles.legendItem}>
            <span className={styles.legendDashed} aria-hidden="true" />
            {t('quota_management.pool.legend_projected')}
          </span>
        </div>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------ accounts */

interface PoolAccountsModalProps {
  open: boolean;
  onClose: () => void;
  snapshots: PoolSnapshot[];
  settings: PoolSettings;
  updateSettings: (patch: Partial<PoolSettings>) => void;
  showEmails: boolean;
  defaultUrl: string;
  lastPollAt: number | null;
  formatTime: (ms: number) => string;
}

function PoolAccountsModal(props: PoolAccountsModalProps) {
  const {
    open,
    onClose,
    snapshots,
    settings,
    updateSettings,
    showEmails,
    defaultUrl,
    lastPollAt,
    formatTime,
  } = props;
  const { t } = useTranslation();
  const [urlDraft, setUrlDraft] = useState(settings.recorderUrl);

  useEffect(() => {
    if (open) setUrlDraft(settings.recorderUrl);
  }, [open, settings.recorderUrl]);

  // Latest sample per credential, grouped by provider.
  const groups = useMemo(() => {
    const latest = new Map<string, PoolSample>();
    [...snapshots]
      .sort((a, b) => a.t - b.t)
      .forEach((snapshot) => snapshot.samples.forEach((sample) => latest.set(sample.id, sample)));
    return QUOTA_TAB_ORDER.filter(isPoolProvider)
      .map((provider) => {
        const samples = [...latest.values()]
          .filter((sample) => sample.provider === provider)
          .sort((a, b) => a.label.localeCompare(b.label));
        const plans = [...new Set(samples.map((sample) => sample.plan ?? ''))];
        return { provider, samples, plans };
      })
      .filter((group) => group.samples.length > 0);
  }, [snapshots]);

  const toggleAccount = (id: string, include: boolean) => {
    const next = new Set(settings.excluded);
    if (include) next.delete(id);
    else next.add(id);
    updateSettings({ excluded: [...next] });
  };

  const setWeight = (key: string, raw: string) => {
    const value = Number(raw);
    const weights = { ...settings.weights };
    if (Number.isFinite(value) && value > 0 && value !== 1) weights[key] = value;
    else delete weights[key];
    updateSettings({ weights });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('quota_management.pool.accounts_title')}
      width={560}
      footer={
        <Button
          size="sm"
          onClick={() => {
            updateSettings({ recorderUrl: urlDraft.trim() });
            onClose();
          }}
        >
          {t('quota_management.pool.done')}
        </Button>
      }
    >
      <p className={styles.modalIntro}>{t('quota_management.pool.accounts_desc')}</p>

      {groups.length === 0 && (
        <p className={styles.modalIntro}>{t('quota_management.pool.no_accounts')}</p>
      )}

      {groups.map((group) => (
        <div key={group.provider} className={styles.accountGroup}>
          <h4>{getTypeLabel(t, group.provider)}</h4>
          {group.samples.map((sample) => (
            <SelectionCheckbox
              key={sample.id}
              checked={!settings.excluded.includes(sample.id)}
              onChange={(value) => toggleAccount(sample.id, value)}
              ariaLabel={t('quota_management.pool.include_account', {
                account: showEmails ? sample.label : sample.id,
              })}
              label={
                <span className={styles.accountRow}>
                  <span className={showEmails ? undefined : styles.masked}>{sample.label}</span>
                  {sample.plan && <span className={styles.accountPlan}>{sample.plan}</span>}
                </span>
              }
            />
          ))}
          <div className={styles.weights}>
            {group.plans.map((plan) => {
              const key = weightKey(group.provider, plan || null);
              return (
                <label key={key} className={styles.weightRow}>
                  <span>
                    {t('quota_management.pool.plan_weight', {
                      plan: plan || t('quota_management.pool.plan_unknown'),
                    })}
                  </span>
                  <input
                    type="number"
                    min={0.1}
                    step={0.1}
                    defaultValue={settings.weights[key] ?? 1}
                    onBlur={(event) => setWeight(key, event.target.value)}
                  />
                </label>
              );
            })}
          </div>
        </div>
      ))}

      <div className={styles.accountGroup}>
        <Input
          label={t('quota_management.pool.recorder_url')}
          value={urlDraft}
          placeholder={defaultUrl}
          onChange={(event) => setUrlDraft(event.target.value)}
          hint={
            lastPollAt
              ? t('quota_management.pool.recorder_last_poll', { time: formatTime(lastPollAt) })
              : t('quota_management.pool.recorder_url_hint', { url: defaultUrl })
          }
        />
      </div>
    </Modal>
  );
}
