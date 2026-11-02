/**
 * Formatting and geometry helpers for the pool charts. React-free.
 */

import type { ChartPoint } from './poolModel';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact duration: "12m", "15h 49m", "2d 18h". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MINUTE)) * MINUTE;
  if (total < HOUR) return `${Math.round(total / MINUTE)}m`;
  if (total < DAY) {
    const hours = Math.floor(total / HOUR);
    const minutes = Math.round((total % HOUR) / MINUTE);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(total / DAY);
  const hours = Math.round((total % DAY) / HOUR);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

/** Pool percentages: whole numbers once large, one decimal when small. */
export function formatPercent(value: number): string {
  const rounded = Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}%`;
}

export function formatRate(value: number): string {
  return `${Math.round(value * 10) / 10}%/h`;
}

/**
 * Clip a piecewise-linear series to [fromMs, toMs], interpolating the edges.
 * Steps (two points sharing a time) survive clipping intact.
 */
export function clipSeries(
  points: readonly ChartPoint[],
  fromMs: number,
  toMs: number
): ChartPoint[] {
  if (points.length === 0 || !(toMs > fromMs)) return [];
  const out: ChartPoint[] = [];
  const valueBetween = (a: ChartPoint, b: ChartPoint, t: number) =>
    b.t === a.t ? b.value : a.value + ((t - a.t) / (b.t - a.t)) * (b.value - a.value);

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const prev = points[i - 1];
    if (point.t < fromMs) continue;
    if (prev && prev.t < fromMs && point.t > fromMs) {
      out.push({ t: fromMs, value: valueBetween(prev, point, fromMs) });
    }
    if (point.t > toMs) {
      if (prev && prev.t <= toMs && prev.t < point.t) {
        out.push({ t: toMs, value: valueBetween(prev, point, toMs) });
      }
      break;
    }
    out.push(point);
  }
  return out;
}

/** Value of a series at `t` (right-hand value at a step), or null outside it. */
export function seriesValueAt(points: readonly ChartPoint[], t: number): number | null {
  if (points.length === 0 || t < points[0].t || t > points[points.length - 1].t) return null;
  let value: number | null = null;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (point.t === t) value = point.value;
    else if (point.t > t) {
      if (value !== null) return value;
      const prev = points[i - 1];
      return prev.value + ((t - prev.t) / (point.t - prev.t)) * (point.value - prev.value);
    }
  }
  return value ?? points[points.length - 1].value;
}

/** A round axis maximum at or above `value`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}
