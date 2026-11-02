import { describe, expect, test } from 'bun:test';
import {
  clipSeries,
  formatDuration,
  formatPercent,
  niceCeiling,
  seriesValueAt,
} from '../src/features/quota/pool/poolFormat';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('pool formatting', () => {
  test('durations read like the summary row', () => {
    expect(formatDuration(12 * MINUTE)).toBe('12m');
    expect(formatDuration(15 * HOUR + 49 * MINUTE)).toBe('15h 49m');
    expect(formatDuration(2 * 24 * HOUR + 18 * HOUR)).toBe('2d 18h');
  });

  test('percentages round to whole numbers once large', () => {
    expect(formatPercent(554.6)).toBe('555%');
    expect(formatPercent(3.74)).toBe('3.7%');
  });

  test('axis ceilings land on round numbers', () => {
    expect(niceCeiling(7.3)).toBe(10);
    expect(niceCeiling(1.9)).toBe(2);
    expect(niceCeiling(230)).toBe(250);
  });
});

describe('series geometry', () => {
  const series = [
    { t: 0, value: 100 },
    { t: 10, value: 50 },
    { t: 10, value: 150 },
    { t: 20, value: 100 },
  ];

  test('clipping interpolates the edges and keeps steps', () => {
    expect(clipSeries(series, 5, 15)).toEqual([
      { t: 5, value: 75 },
      { t: 10, value: 50 },
      { t: 10, value: 150 },
      { t: 15, value: 125 },
    ]);
  });

  test('value at a step is the value after it', () => {
    expect(seriesValueAt(series, 10)).toBe(150);
    expect(seriesValueAt(series, 5)).toBe(75);
    expect(seriesValueAt(series, 25)).toBeNull();
  });
});
