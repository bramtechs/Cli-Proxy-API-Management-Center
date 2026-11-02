/**
 * Quota recorder client.
 *
 * The recorder is a sidecar next to the proxy (see `recorder/`) that samples
 * every credential's quota on a schedule. It is a separate origin, so this does
 * not go through `apiClient`; it authenticates with the same management key,
 * which the recorder verifies against the Management API.
 */

import axios from 'axios';
import type { PoolSnapshot } from '@/features/quota/pool/poolModel';
import { normalizeApiBase } from '@/utils/connection';

/** Port the recorder listens on next to the proxy. */
export const DEFAULT_RECORDER_PORT = 8318;

const RECORDER_TIMEOUT_MS = 20_000;

export interface RecorderHistory {
  intervalMs: number;
  lastPollAt: number | null;
  snapshots: PoolSnapshot[];
}

/** Default recorder URL: the proxy's host on the recorder port. */
export function defaultRecorderUrl(apiBase: string): string {
  const base = normalizeApiBase(apiBase);
  if (!base) return '';
  try {
    const url = new URL(base);
    return `${url.protocol}//${url.hostname}:${DEFAULT_RECORDER_PORT}`;
  } catch {
    return '';
  }
}

export const normalizeRecorderUrl = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
};

const isSnapshot = (value: unknown): value is PoolSnapshot =>
  Boolean(value) &&
  typeof (value as PoolSnapshot).t === 'number' &&
  Array.isArray((value as PoolSnapshot).samples);

export const quotaRecorderApi = {
  async history(
    recorderUrl: string,
    managementKey: string,
    fromMs: number,
    toMs: number
  ): Promise<RecorderHistory> {
    const response = await axios.get<Partial<RecorderHistory>>(`${recorderUrl}/history`, {
      params: { from: Math.floor(fromMs), to: Math.ceil(toMs) },
      headers: { Authorization: `Bearer ${managementKey}` },
      timeout: RECORDER_TIMEOUT_MS,
    });
    const body = response.data ?? {};
    return {
      intervalMs: typeof body.intervalMs === 'number' ? body.intervalMs : 0,
      lastPollAt: typeof body.lastPollAt === 'number' ? body.lastPollAt : null,
      snapshots: Array.isArray(body.snapshots) ? body.snapshots.filter(isSnapshot) : [],
    };
  },

  /** Ask for an immediate poll; the recorder ignores it right after a scheduled one. */
  async poll(recorderUrl: string, managementKey: string): Promise<void> {
    await axios.post(`${recorderUrl}/poll`, null, {
      headers: { Authorization: `Bearer ${managementKey}` },
      timeout: RECORDER_TIMEOUT_MS * 3,
    });
  },
};
