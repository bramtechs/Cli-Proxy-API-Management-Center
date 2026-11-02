/**
 * Quota pool model: what a provider's accounts have left *together*, how fast
 * that is draining, and where it is heading.
 *
 * The quota recorder samples every credential's longest quota window on a
 * schedule. This module turns those samples into:
 * - the recorded pool line (sum of weighted remaining percentages);
 * - a burn rate per account over a trailing window;
 * - a projection that drains each account at its rate and refills it at each
 *   window reset;
 * - the summary numbers above the chart (pool empty, first empty, next reset).
 *
 * Pure functions only — no React, no clock (`now` is always passed in) — so
 * every case is directly testable.
 */

import { buildTimelineLane, HOUR_MS } from '../quotaTimelineModel';
import type { QuotaProviderType } from '../providers/types';

/** Longest window worth pooling: monthly plans still qualify, nothing longer. */
export const POOL_MAX_PERIOD_HOURS = 24 * 31;

/** Providers whose quota checks are cheap reads of subscription windows. */
export const POOL_PROVIDERS: readonly QuotaProviderType[] = [
  'claude',
  'antigravity',
  'codex',
  'xai',
  'kimi',
  'devin',
  'meta',
  'plugin',
];

export const isPoolProvider = (provider: QuotaProviderType): boolean =>
  POOL_PROVIDERS.includes(provider);

/** One credential's quota at one instant. */
export interface PoolSample {
  /** Credential file name; stable across polls. */
  id: string;
  provider: QuotaProviderType;
  /** Account email when known, else the file name. */
  label: string;
  plan: string | null;
  /** Remaining percent of the chosen window, 0..100. */
  remaining: number | null;
  /** When the chosen window next resets. */
  resetAtMs: number | null;
  periodHours: number | null;
}

export interface PoolSnapshot {
  t: number;
  samples: PoolSample[];
}

/* ------------------------------------------------------------ sampling */

const readPlan = (quota: unknown): string | null => {
  if (!quota || typeof quota !== 'object') return null;
  const record = quota as Record<string, unknown>;
  const billing = record.billing as Record<string, unknown> | null | undefined;
  const candidates = [record.planType, record.plan, record.planName, billing?.planLabel];
  const found = candidates.find((value) => typeof value === 'string' && value.trim());
  return typeof found === 'string' ? found.trim() : null;
};

/**
 * Reduce a provider quota state to a pool sample.
 *
 * Reuses the timeline lane builder, which already knows where each provider
 * keeps its windows and whether it reports percent used or percent remaining.
 * Returns null when the state has no window to pool.
 */
export function sampleFromQuota(
  input: { id: string; provider: QuotaProviderType; label: string },
  quota: unknown
): PoolSample | null {
  const lane = buildTimelineLane({
    name: input.id,
    displayName: input.label,
    provider: input.provider,
    quota: quota as { status?: string } | undefined,
    maxPeriodHours: POOL_MAX_PERIOD_HOURS,
  });
  if (lane.remaining === null) return null;
  return {
    id: input.id,
    provider: input.provider,
    label: input.label,
    plan: readPlan(quota),
    remaining: lane.remaining,
    resetAtMs: lane.anchorMs,
    periodHours: lane.periodHours,
  };
}

/* ------------------------------------------------------------ accounts */

export interface PoolPoint {
  t: number;
  remaining: number;
  resetAtMs: number | null;
  periodHours: number | null;
}

export interface PoolAccount {
  id: string;
  provider: QuotaProviderType;
  label: string;
  plan: string | null;
  weight: number;
  /** Samples sorted by time. */
  points: PoolPoint[];
}

export type PoolWeights = Record<string, number>;

/** Weight key: weights apply per plan, so new accounts on a known plan inherit. */
export const weightKey = (provider: QuotaProviderType, plan: string | null): string =>
  `${provider}:${plan ?? ''}`;

export const weightFor = (
  weights: PoolWeights,
  provider: QuotaProviderType,
  plan: string | null
): number => {
  const value = weights[weightKey(provider, plan)];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
};

/**
 * Group snapshots into per-account series for one provider.
 *
 * Label and plan come from the newest sample: an account can change plans, and
 * the pool should be weighted by what it is now.
 */
export function buildPoolAccounts(
  snapshots: readonly PoolSnapshot[],
  provider: QuotaProviderType,
  weights: PoolWeights,
  excluded: ReadonlySet<string> = new Set()
): PoolAccount[] {
  const byId = new Map<string, PoolAccount>();
  const ordered = [...snapshots].sort((a, b) => a.t - b.t);
  for (const snapshot of ordered) {
    for (const sample of snapshot.samples) {
      if (sample.provider !== provider || excluded.has(sample.id)) continue;
      if (typeof sample.remaining !== 'number' || !Number.isFinite(sample.remaining)) continue;
      let account = byId.get(sample.id);
      if (!account) {
        account = {
          id: sample.id,
          provider,
          label: sample.label,
          plan: sample.plan,
          weight: 1,
          points: [],
        };
        byId.set(sample.id, account);
      }
      account.label = sample.label || account.label;
      account.plan = sample.plan ?? account.plan;
      const point: PoolPoint = {
        t: snapshot.t,
        remaining: Math.min(100, Math.max(0, sample.remaining)),
        resetAtMs: sample.resetAtMs,
        periodHours: sample.periodHours,
      };
      const last = account.points[account.points.length - 1];
      if (last && last.t === point.t) account.points[account.points.length - 1] = point;
      else account.points.push(point);
    }
  }
  const accounts = [...byId.values()];
  accounts.forEach((account) => {
    account.weight = weightFor(weights, provider, account.plan);
  });
  return accounts.sort((a, b) => a.label.localeCompare(b.label));
}

/** Index of the last point at or before `t`, or -1. */
function lastIndexAtOrBefore(points: readonly PoolPoint[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Next reset instant at or after `t` for a sample, rolling a stale anchor
 * forward by whole periods. Null when the window has no known reset.
 */
export function nextResetAfter(point: PoolPoint, t: number): number | null {
  const anchor = point.resetAtMs;
  if (anchor === null || !Number.isFinite(anchor)) return null;
  if (anchor > t) return anchor;
  const period = (point.periodHours ?? 0) * HOUR_MS;
  if (!(period > 0)) return null;
  return anchor + Math.ceil((t - anchor) / period) * period;
}

/**
 * Remaining percent of an account at `t` according to the recording.
 *
 * Carries the latest sample forward, except across that sample's reset: once
 * the window it described has ended, the account is back to full until a newer
 * sample says otherwise.
 */
export function recordedValueAt(account: PoolAccount, t: number): number | null {
  const index = lastIndexAtOrBefore(account.points, t);
  if (index < 0) return null;
  const point = account.points[index];
  if (point.resetAtMs !== null && t >= point.resetAtMs) return 100;
  return point.remaining;
}

/* ------------------------------------------------------------ recorded */

export interface ChartPoint {
  t: number;
  value: number;
}

export interface ChartJump {
  t: number;
  /** Pool percent gained at this instant. */
  gain: number;
}

export interface RecordedSeries {
  points: ChartPoint[];
  jumps: ChartJump[];
}

/** Rises smaller than this are noise (rounding, partial refunds), not resets. */
const MIN_LABELLED_JUMP = 5;

/**
 * The recorded pool line between `fromMs` and `toMs`.
 *
 * Steps at reset instants are drawn vertically (two points at the same time)
 * rather than as a slope to the next sample.
 */
export function buildRecordedSeries(
  accounts: readonly PoolAccount[],
  fromMs: number,
  toMs: number
): RecordedSeries {
  if (!(toMs > fromMs) || accounts.length === 0) return { points: [], jumps: [] };

  const times = new Set<number>();
  for (const account of accounts) {
    for (const point of account.points) {
      if (point.t >= fromMs && point.t <= toMs) times.add(point.t);
      if (point.resetAtMs !== null && point.resetAtMs > fromMs && point.resetAtMs <= toMs) {
        times.add(point.resetAtMs);
      }
    }
    // Start the line at the span's left edge when the account was already known.
    if (account.points.length > 0 && account.points[0].t < fromMs) times.add(fromMs);
  }
  const sorted = [...times].sort((a, b) => a - b);

  const points: ChartPoint[] = [];
  const jumps: ChartJump[] = [];
  let previous: (number | null)[] | null = null;
  for (const t of sorted) {
    const values = accounts.map((account) => recordedValueAt(account, t));
    if (values.every((value) => value === null)) continue;
    const before = accounts.map((account) => recordedValueAt(account, t - 1));
    const pool = sumWeighted(accounts, values);
    const poolBefore = sumWeighted(accounts, before);

    let gain = 0;
    accounts.forEach((account, index) => {
      const now = values[index];
      const prev = previous ? previous[index] : null;
      if (now !== null && prev !== null && now > prev) gain += (now - prev) * account.weight;
    });

    // Refills are instantaneous, so draw a rise as a vertical step. Usage between
    // two samples happened gradually; let the line slope across it.
    if (points.length > 0 && pool - poolBefore > 1e-9) {
      points.push({ t, value: poolBefore });
    }
    points.push({ t, value: pool });
    if (gain >= MIN_LABELLED_JUMP) jumps.push({ t, gain });
    // Keep unknowns unknown: an account appearing mid-span is not a reset.
    previous = values;
  }
  return { points, jumps };
}

function sumWeighted(accounts: readonly PoolAccount[], values: readonly (number | null)[]): number {
  return accounts.reduce((sum, account, index) => sum + (values[index] ?? 0) * account.weight, 0);
}

/* ------------------------------------------------------------ burn rate */

/**
 * Cumulative percent consumed at each sample: the running sum of decreases.
 * Rises (resets) consume nothing, so the series is non-decreasing.
 */
function cumulativeConsumption(points: readonly PoolPoint[]): number[] {
  const out: number[] = [];
  let total = 0;
  points.forEach((point, index) => {
    if (index > 0) {
      const drop = points[index - 1].remaining - point.remaining;
      if (drop > 0) total += drop;
    }
    out.push(total);
  });
  return out;
}

function interpolate(points: readonly PoolPoint[], cumulative: readonly number[], t: number) {
  const index = lastIndexAtOrBefore(points, t);
  if (index < 0) return cumulative[0] ?? 0;
  if (index >= points.length - 1) return cumulative[cumulative.length - 1] ?? 0;
  const a = points[index];
  const b = points[index + 1];
  const span = b.t - a.t;
  if (span <= 0) return cumulative[index + 1];
  return cumulative[index] + ((t - a.t) / span) * (cumulative[index + 1] - cumulative[index]);
}

/**
 * An account's burn in percent per hour over the `windowHours` before `atMs`.
 *
 * Divides by the time actually covered by samples, so a recorder that started
 * an hour ago still yields a rate for a six-hour window. Returns null when the
 * samples cover too little of the window to mean anything.
 */
export function accountBurnRate(
  account: PoolAccount,
  atMs: number,
  windowHours: number
): number | null {
  const points = account.points.filter((point) => point.t <= atMs);
  if (points.length < 2) return null;
  const windowMs = windowHours * HOUR_MS;
  const fromMs = Math.max(atMs - windowMs, points[0].t);
  const toMs = Math.min(atMs, points[points.length - 1].t);
  const covered = toMs - fromMs;
  if (covered < Math.min(windowMs * 0.25, HOUR_MS * 0.5) || covered <= 0) return null;
  const cumulative = cumulativeConsumption(points);
  const used = interpolate(points, cumulative, toMs) - interpolate(points, cumulative, fromMs);
  return Math.max(0, used) / (covered / HOUR_MS);
}

/** Weighted pool burn in pool-percent per hour; accounts without a rate count as idle. */
export function poolBurnRate(
  accounts: readonly PoolAccount[],
  atMs: number,
  windowHours: number
): number | null {
  let any = false;
  let total = 0;
  for (const account of accounts) {
    const rate = accountBurnRate(account, atMs, windowHours);
    if (rate === null) continue;
    any = true;
    total += rate * account.weight;
  }
  return any ? total : null;
}

/** Recorded pool drain rate at every recorded instant in the span. */
export function buildRecordedDrain(
  accounts: readonly PoolAccount[],
  fromMs: number,
  toMs: number,
  windowHours: number
): ChartPoint[] {
  const times = new Set<number>();
  accounts.forEach((account) =>
    account.points.forEach((point) => {
      if (point.t >= fromMs && point.t <= toMs) times.add(point.t);
    })
  );
  return [...times]
    .sort((a, b) => a - b)
    .map((t) => ({ t, value: poolBurnRate(accounts, t, windowHours) }))
    .filter((point): point is ChartPoint => point.value !== null);
}

/* ------------------------------------------------------------ projection */

export const FUTURE_USAGE_MODES = ['same', 'week', 'half', 'double', 'none'] as const;
export type FutureUsageMode = (typeof FUTURE_USAGE_MODES)[number];

export const BURN_WINDOWS = [1, 3, 6] as const;
export type BurnWindowHours = (typeof BURN_WINDOWS)[number];

/** Per-account rate the projection drains at, in percent per hour. */
export function projectedRate(
  account: PoolAccount,
  nowMs: number,
  windowHours: number,
  mode: FutureUsageMode
): number {
  if (mode === 'none') return 0;
  const base =
    mode === 'week'
      ? accountBurnRate(account, nowMs, 24 * 7)
      : accountBurnRate(account, nowMs, windowHours);
  const rate = base ?? 0;
  if (mode === 'half') return rate / 2;
  if (mode === 'double') return rate * 2;
  return rate;
}

/** A piecewise-linear account projection; equal consecutive times mark a step. */
interface AccountProjection {
  account: PoolAccount;
  rate: number;
  points: ChartPoint[];
  /** First instant the account runs dry, if it does before the horizon. */
  emptyAtMs: number | null;
  resets: { t: number; gain: number }[];
}

/** Where an account stands now: the latest sample, rolled across a passed reset. */
function currentState(account: PoolAccount, nowMs: number) {
  const index = lastIndexAtOrBefore(account.points, nowMs);
  if (index < 0) return null;
  const point = account.points[index];
  const value = recordedValueAt(account, nowMs) ?? point.remaining;
  return { value, nextReset: nextResetAfter(point, nowMs), periodHours: point.periodHours };
}

function projectAccount(
  account: PoolAccount,
  nowMs: number,
  horizonMs: number,
  rate: number
): AccountProjection | null {
  const state = currentState(account, nowMs);
  if (!state) return null;
  const periodMs = (state.periodHours ?? 0) * HOUR_MS;
  const points: ChartPoint[] = [{ t: nowMs, value: state.value }];
  const resets: { t: number; gain: number }[] = [];
  let emptyAtMs: number | null = state.value <= 0 ? nowMs : null;
  let t = nowMs;
  let value = state.value;
  let reset = state.nextReset;
  const perMs = rate / HOUR_MS;

  // Bounded: one iteration per reset inside the horizon.
  for (let guard = 0; guard < 1000 && t < horizonMs; guard += 1) {
    const segmentEnd = reset !== null && reset < horizonMs ? reset : horizonMs;
    if (perMs > 0 && value > 0) {
      const zeroAt = t + value / perMs;
      if (zeroAt < segmentEnd) {
        points.push({ t: zeroAt, value: 0 });
        if (emptyAtMs === null) emptyAtMs = zeroAt;
        value = 0;
      } else {
        value = Math.max(0, value - perMs * (segmentEnd - t));
      }
    }
    points.push({ t: segmentEnd, value });
    t = segmentEnd;
    if (segmentEnd === horizonMs) break;

    // Window reset: refill to 100.
    resets.push({ t: segmentEnd, gain: (100 - value) * account.weight });
    value = 100;
    points.push({ t: segmentEnd, value });
    reset = periodMs > 0 ? segmentEnd + periodMs : null;
  }
  return { account, rate, points, emptyAtMs, resets };
}

/** Value of a projection just before (`side` = -1) or at/after (`side` = 1) `t`. */
function projectionValueAt(points: readonly ChartPoint[], t: number, side: -1 | 1): number {
  if (points.length === 0) return 0;
  if (t <= points[0].t) return points[0].value;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (t > a.t && t < b.t) return a.value + ((t - a.t) / (b.t - a.t)) * (b.value - a.value);
    if (t === b.t) {
      if (side === -1) return b.value;
      // At a step, the right-hand value is the last point sharing this time.
      let j = i + 1;
      while (j + 1 < points.length && points[j + 1].t === t) j += 1;
      return points[j].value;
    }
  }
  return points[points.length - 1].value;
}

export interface PoolProjection {
  points: ChartPoint[];
  jumps: ChartJump[];
  /** Pool drain rate (pool-percent per hour) as a step function over time. */
  drain: ChartPoint[];
  poolEmptyAtMs: number | null;
  firstEmpty: { accountId: string; label: string; atMs: number } | null;
  nextReset: { t: number; gain: number } | null;
  burnRate: number;
}

/** Resets of several accounts landing within this window are labelled as one. */
const RESET_GROUP_MS = 60 * 1000;

export function projectPool(
  accounts: readonly PoolAccount[],
  nowMs: number,
  horizonMs: number,
  windowHours: number,
  mode: FutureUsageMode
): PoolProjection {
  const projections = accounts
    .map((account) =>
      projectAccount(account, nowMs, horizonMs, projectedRate(account, nowMs, windowHours, mode))
    )
    .filter((projection): projection is AccountProjection => projection !== null);

  const empty: PoolProjection = {
    points: [],
    jumps: [],
    drain: [],
    poolEmptyAtMs: null,
    firstEmpty: null,
    nextReset: null,
    burnRate: 0,
  };
  if (projections.length === 0 || !(horizonMs > nowMs)) return empty;

  const times = [...new Set(projections.flatMap((p) => p.points.map((point) => point.t)))].sort(
    (a, b) => a - b
  );

  const points: ChartPoint[] = [];
  const drain: ChartPoint[] = [];
  let poolEmptyAtMs: number | null = null;
  for (const t of times) {
    let left = 0;
    let right = 0;
    let rate = 0;
    for (const projection of projections) {
      const weight = projection.account.weight;
      left += projectionValueAt(projection.points, t, -1) * weight;
      const after = projectionValueAt(projection.points, t, 1);
      right += after * weight;
      if (after > 0) rate += projection.rate * weight;
    }
    if (points.length > 0 && Math.abs(left - right) > 1e-9) points.push({ t, value: left });
    points.push({ t, value: right });
    // Drain is a step function: an account's rate stops when it runs dry and
    // resumes at its reset, so hold the previous rate until this instant.
    const previousRate = drain[drain.length - 1];
    if (previousRate && Math.abs(previousRate.value - rate) > 1e-9) {
      drain.push({ t, value: previousRate.value });
    }
    drain.push({ t, value: rate });
    if (poolEmptyAtMs === null && left <= 1e-6) poolEmptyAtMs = t;
    else if (poolEmptyAtMs === null && right <= 1e-6) poolEmptyAtMs = t;
  }

  const allResets = projections
    .flatMap((projection) => projection.resets)
    .sort((a, b) => a.t - b.t);
  const jumps: ChartJump[] = [];
  for (const reset of allResets) {
    const last = jumps[jumps.length - 1];
    if (last && reset.t - last.t <= RESET_GROUP_MS) last.gain += reset.gain;
    else jumps.push({ ...reset });
  }

  const firstEmpty = projections
    .filter((projection) => projection.emptyAtMs !== null)
    .sort((a, b) => (a.emptyAtMs as number) - (b.emptyAtMs as number))[0];

  return {
    points,
    jumps: jumps.filter((jump) => jump.gain >= 0.5),
    drain,
    poolEmptyAtMs,
    firstEmpty: firstEmpty
      ? {
          accountId: firstEmpty.account.id,
          label: firstEmpty.account.label,
          atMs: firstEmpty.emptyAtMs as number,
        }
      : null,
    nextReset: jumps.find((jump) => jump.gain >= 0.5) ?? null,
    burnRate: projections.reduce(
      (sum, projection) => sum + projection.rate * projection.account.weight,
      0
    ),
  };
}

/* ------------------------------------------------------------ summary */

export interface PoolSummary {
  /** Weighted remaining percent now. */
  remaining: number;
  /** Weighted capacity: 100 per account times its weight. */
  capacity: number;
}

export function summarizePool(accounts: readonly PoolAccount[], nowMs: number): PoolSummary {
  let remaining = 0;
  let capacity = 0;
  for (const account of accounts) {
    const state = currentState(account, nowMs);
    if (!state) continue;
    remaining += state.value * account.weight;
    capacity += 100 * account.weight;
  }
  return { remaining, capacity };
}

/* ------------------------------------------------------------ span */

export const POOL_SPAN_DAYS = 14;
/** Days of history shown left of today in the default view. */
export const POOL_SPAN_LEAD_DAYS = 3;

/** Visible span: 14 local days starting three days before today, stepped by weeks. */
export function poolSpan(nowMs: number, offsetWeeks: number): { startMs: number; endMs: number } {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - POOL_SPAN_LEAD_DAYS + offsetWeeks * 7);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + POOL_SPAN_DAYS);
  return { startMs: start.getTime(), endMs: end.getTime() };
}
