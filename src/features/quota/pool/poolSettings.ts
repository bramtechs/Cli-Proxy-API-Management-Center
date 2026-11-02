/**
 * Pool chart preferences, persisted in localStorage (they describe the user's
 * accounts and habits, so they outlive the session unlike the page tab/sort).
 */

import {
  BURN_WINDOWS,
  FUTURE_USAGE_MODES,
  type BurnWindowHours,
  type FutureUsageMode,
  type PoolWeights,
} from './poolModel';

export type PoolMetric = 'remaining' | 'drain';

export interface PoolSettings {
  metric: PoolMetric;
  burnWindow: BurnWindowHours;
  future: FutureUsageMode;
  /** Credential ids left out of every pool. */
  excluded: string[];
  /** Plan weights keyed by `weightKey(provider, plan)`. */
  weights: PoolWeights;
  /** Overrides the recorder URL derived from the API base; empty = derived. */
  recorderUrl: string;
}

export const DEFAULT_POOL_SETTINGS: PoolSettings = {
  metric: 'remaining',
  burnWindow: 3,
  future: 'same',
  excluded: [],
  weights: {},
  recorderUrl: '',
};

const STORAGE_KEY = 'quotaPage.poolSettings';

export function parsePoolSettings(raw: unknown): PoolSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_POOL_SETTINGS };
  const value = raw as Partial<Record<keyof PoolSettings, unknown>>;
  const weights: PoolWeights = {};
  if (value.weights && typeof value.weights === 'object') {
    Object.entries(value.weights as Record<string, unknown>).forEach(([key, weight]) => {
      if (typeof weight === 'number' && Number.isFinite(weight) && weight > 0)
        weights[key] = weight;
    });
  }
  return {
    metric: value.metric === 'drain' ? 'drain' : 'remaining',
    burnWindow: BURN_WINDOWS.includes(value.burnWindow as BurnWindowHours)
      ? (value.burnWindow as BurnWindowHours)
      : DEFAULT_POOL_SETTINGS.burnWindow,
    future: FUTURE_USAGE_MODES.includes(value.future as FutureUsageMode)
      ? (value.future as FutureUsageMode)
      : DEFAULT_POOL_SETTINGS.future,
    excluded: Array.isArray(value.excluded)
      ? value.excluded.filter((id): id is string => typeof id === 'string')
      : [],
    weights,
    recorderUrl: typeof value.recorderUrl === 'string' ? value.recorderUrl : '',
  };
}

export function readPoolSettings(): PoolSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_POOL_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return parsePoolSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_POOL_SETTINGS };
  }
}

export function writePoolSettings(settings: PoolSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or disabled: preferences just won't persist.
  }
}

const SHOW_EMAILS_KEY = 'quotaPage.showEmails';

export function readShowEmails(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SHOW_EMAILS_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeShowEmails(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SHOW_EMAILS_KEY, value ? '1' : '0');
  } catch {
    // ignore
  }
}
