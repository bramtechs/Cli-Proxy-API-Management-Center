/**
 * Quota recorder: samples every subscription credential's quota on a schedule
 * and serves the history to the panel's pool charts.
 *
 * It reuses the panel's own provider data layers (the same requests the quota
 * cards make, through the Management API's api-call proxy), so a provider
 * supported by the cards is recorded the same way.
 *
 * Environment:
 *   CPA_URL            Management API base, e.g. http://cli-proxy-api:8317
 *   CPA_KEY            Management key (MANAGEMENT_PASSWORD on the server)
 *   DATA_DIR           Where daily JSONL files live (default ./data)
 *   PORT               HTTP port (default 8318)
 *   INTERVAL_MINUTES   Poll interval (default 10)
 *   RETENTION_DAYS     Days of history to keep (default 120)
 */

import './shim';
import { createHash, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { TFunction } from 'i18next';
import { apiClient } from '@/services/api/client';
import { authFilesApi } from '@/services/api/authFiles';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import {
  isPoolProvider,
  sampleFromQuota,
  type PoolSample,
  type PoolSnapshot,
} from '@/features/quota/pool/poolModel';
import type { QuotaProviderType } from '@/features/quota/providers/types';
import type { AuthFileItem } from '@/types';
import { RECORDER_CONFIGS } from './configs';

const env = (name: string, fallback?: string): string => {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required`);
};

const CPA_URL = env('CPA_URL').replace(/\/+$/, '');
const CPA_KEY = env('CPA_KEY');
const DATA_DIR = env('DATA_DIR', './data');
const PORT = Number(env('PORT', '8318'));
const INTERVAL_MS = Math.max(1, Number(env('INTERVAL_MINUTES', '10'))) * 60_000;
const RETENTION_DAYS = Math.max(1, Number(env('RETENTION_DAYS', '120')));

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A credential with no chartable window is retried this rarely. */
const NO_WINDOW_RETRY_MS = 6 * 60 * MINUTE;
const MAX_BACKOFF_MS = 2 * 60 * MINUTE;
/** Manual polls from the panel are ignored this soon after the previous poll. */
const MIN_MANUAL_POLL_GAP_MS = 2 * MINUTE;

apiClient.setConfig({ apiBase: CPA_URL, managementKey: CPA_KEY });

// The provider modules only use `t` to build error messages.
const t = ((key: string) => key) as unknown as TFunction;

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

/* ------------------------------------------------------------ storage */

const dayFile = (ms: number) => join(DATA_DIR, `${new Date(ms).toISOString().slice(0, 10)}.jsonl`);

async function appendSnapshot(snapshot: PoolSnapshot) {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(dayFile(snapshot.t), `${JSON.stringify(snapshot)}\n`);
}

async function readSnapshots(fromMs: number, toMs: number): Promise<PoolSnapshot[]> {
  const out: PoolSnapshot[] = [];
  const first = Date.UTC(
    new Date(fromMs).getUTCFullYear(),
    new Date(fromMs).getUTCMonth(),
    new Date(fromMs).getUTCDate()
  );
  for (let day = first; day <= toMs; day += DAY) {
    let text: string;
    try {
      text = await readFile(dayFile(day), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const snapshot = JSON.parse(line) as PoolSnapshot;
        if (snapshot.t >= fromMs && snapshot.t <= toMs) out.push(snapshot);
      } catch {
        // A torn last line from a crash mid-write; skip it.
      }
    }
  }
  return out;
}

async function pruneOldFiles() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * DAY).toISOString().slice(0, 10);
  let names: string[];
  try {
    names = await readdir(DATA_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < cutoff) {
      await unlink(join(DATA_DIR, name)).catch(() => undefined);
    }
  }
}

/* ------------------------------------------------------------ polling */

interface CredentialState {
  nextAttemptAt: number;
  backoffMs: number;
  noWindowCount: number;
  lastError: string | null;
  lastSampleAt: number | null;
}

const credentialState = new Map<string, CredentialState>();
let lastPollAt: number | null = null;
let polling: Promise<void> | null = null;

const stateFor = (id: string): CredentialState => {
  let state = credentialState.get(id);
  if (!state) {
    state = {
      nextAttemptAt: 0,
      backoffMs: 0,
      noWindowCount: 0,
      lastError: null,
      lastSampleAt: null,
    };
    credentialState.set(id, state);
  }
  return state;
};

const statusOf = (error: unknown): number | undefined => {
  const value = (error as { status?: unknown; statusCode?: unknown } | null) ?? null;
  const status = value?.status ?? value?.statusCode;
  return typeof status === 'number' ? status : undefined;
};

const labelOf = (file: AuthFileItem) => (file.email?.trim() ? file.email.trim() : file.name);

async function sampleCredential(
  file: AuthFileItem,
  provider: QuotaProviderType
): Promise<PoolSample | null> {
  const config = RECORDER_CONFIGS[provider];
  const data = await config.fetchQuota(file, t);
  const quota = config.buildSuccessState(data);
  return sampleFromQuota({ id: getQuotaCacheKey(file), provider, label: labelOf(file) }, quota);
}

async function pollOnce() {
  const startedAt = Date.now();
  const list = await authFilesApi.list();
  const entries = classifyQuotaFiles(list?.files ?? []).filter(
    (entry) => isPoolProvider(entry.type) && !entry.file.disabled
  );

  const samples: PoolSample[] = [];
  const due = entries.filter(
    (entry) => stateFor(getQuotaCacheKey(entry.file)).nextAttemptAt <= startedAt
  );

  // A few at a time: fast enough for a dozen credentials, gentle on upstream limits.
  const queue = [...due];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const state = stateFor(getQuotaCacheKey(entry.file));
      try {
        const sample = await sampleCredential(entry.file, entry.type);
        state.lastError = null;
        state.backoffMs = 0;
        if (sample) {
          samples.push(sample);
          state.noWindowCount = 0;
          state.lastSampleAt = startedAt;
          state.nextAttemptAt = 0;
        } else {
          state.noWindowCount += 1;
          state.nextAttemptAt = state.noWindowCount >= 3 ? startedAt + NO_WINDOW_RETRY_MS : 0;
        }
      } catch (error) {
        const status = statusOf(error);
        state.lastError =
          `${status ?? ''} ${error instanceof Error ? error.message : String(error)}`.trim();
        // Rate limits and auth failures back off; other errors retry next poll.
        if (status === 429 || status === 401 || status === 403) {
          state.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(INTERVAL_MS, state.backoffMs * 2));
          state.nextAttemptAt = startedAt + state.backoffMs;
        }
        log('quota fetch failed', entry.type, entry.file.name, state.lastError);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  lastPollAt = startedAt;
  if (samples.length > 0) await appendSnapshot({ t: startedAt, samples });
  log(`polled ${due.length}/${entries.length} credentials, recorded ${samples.length}`);
}

function poll(): Promise<void> {
  if (!polling) {
    polling = pollOnce()
      .catch((error) => log('poll failed', error instanceof Error ? error.message : error))
      .finally(() => {
        polling = null;
      });
  }
  return polling;
}

/* ------------------------------------------------------------ auth */

const sha = (value: string) => createHash('sha256').update(value).digest();
const RECORDER_KEY_HASH = sha(CPA_KEY);
const verifiedKeys = new Map<string, number>();
const VERIFIED_TTL_MS = 10 * MINUTE;
/**
 * The server bans an IP for 30 minutes after five failed management logins,
 * and this container's IP is the one it would ban. Never forward more than
 * three unverified keys per window.
 */
const MAX_FORWARDED_FAILURES = 3;
const FAILURE_WINDOW_MS = 30 * MINUTE;
let forwardedFailures: number[] = [];

async function authorize(request: Request): Promise<Response | null> {
  const header = request.headers.get('authorization') ?? '';
  const key = header.replace(/^Bearer\s+/i, '').trim();
  if (!key) return json({ error: 'missing management key' }, 401, request);

  const hash = sha(key);
  if (timingSafeEqual(hash, RECORDER_KEY_HASH)) return null;
  const cacheKey = hash.toString('hex');
  const verifiedAt = verifiedKeys.get(cacheKey);
  if (verifiedAt && Date.now() - verifiedAt < VERIFIED_TTL_MS) return null;

  const now = Date.now();
  forwardedFailures = forwardedFailures.filter((at) => now - at < FAILURE_WINDOW_MS);
  if (forwardedFailures.length >= MAX_FORWARDED_FAILURES) {
    return json({ error: 'too many failed attempts, try again later' }, 429, request);
  }

  try {
    const response = await fetch(`${CPA_URL}/v8/management/config`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (response.ok) {
      verifiedKeys.set(cacheKey, now);
      return null;
    }
    if (response.status === 401 || response.status === 403) forwardedFailures.push(now);
    return json({ error: 'invalid management key' }, 401, request);
  } catch {
    return json({ error: 'management API unreachable' }, 502, request);
  }
}

/* ------------------------------------------------------------ http */

function corsHeaders(request: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': request.headers.get('origin') || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    // Chrome's private network access preflight (panel on a tailnet IP, etc.).
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

const statusBody = () => ({
  ok: true,
  intervalMs: INTERVAL_MS,
  lastPollAt,
  polling: polling !== null,
});

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (url.pathname === '/health') return json(statusBody(), 200, request);

    const denied = await authorize(request);
    if (denied) return denied;

    if (request.method === 'GET' && url.pathname === '/history') {
      const now = Date.now();
      const from = Number(url.searchParams.get('from')) || now - 14 * DAY;
      const to = Number(url.searchParams.get('to')) || now;
      if (to - from > 62 * DAY) return json({ error: 'range too large' }, 400, request);
      const snapshots = await readSnapshots(from, to);
      return json({ ...statusBody(), snapshots }, 200, request);
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      const credentials = Object.fromEntries(credentialState);
      return json({ ...statusBody(), credentials }, 200, request);
    }

    if (request.method === 'POST' && url.pathname === '/poll') {
      const recent = lastPollAt !== null && Date.now() - lastPollAt < MIN_MANUAL_POLL_GAP_MS;
      if (!recent) await poll();
      return json({ ...statusBody(), skipped: recent }, 200, request);
    }

    return json({ error: 'not found' }, 404, request);
  },
});

log(`quota recorder listening on :${PORT}, polling ${CPA_URL} every ${INTERVAL_MS / MINUTE} min`);

void pruneOldFiles();
void poll();
setInterval(() => void poll(), INTERVAL_MS);
setInterval(() => void pruneOldFiles(), DAY);
