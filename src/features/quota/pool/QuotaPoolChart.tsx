import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChartJump, ChartPoint } from './poolModel';
import { clipSeries, seriesValueAt } from './poolFormat';
import styles from './QuotaPool.module.scss';

export interface QuotaPoolChartProps {
  color: string;
  recorded: ChartPoint[];
  recordedJumps: ChartJump[];
  projected: ChartPoint[];
  projectedJumps: ChartJump[];
  spanStartMs: number;
  spanEndMs: number;
  nowMs: number;
  yMax: number;
  emptyAtMs: number | null;
  formatValue: (value: number) => string;
  /** Tooltip suffix after the value, e.g. "left" or "drain". */
  tooltipValueKey: 'tooltip_left' | 'tooltip_drain';
  formatTime: (ms: number) => string;
  formatDay: (ms: number) => string;
  ariaLabel: string;
}

const HEIGHT = 300;
const PAD = { top: 30, right: 12, bottom: 30, left: 48 };
const DEFAULT_WIDTH = 960;
/** Jump labels closer than this to the previous one are dropped. */
const LABEL_MIN_GAP_PX = 34;

export function QuotaPoolChart(props: QuotaPoolChartProps) {
  const {
    color,
    recorded,
    recordedJumps,
    projected,
    projectedJumps,
    spanStartMs,
    spanEndMs,
    nowMs,
    yMax,
    emptyAtMs,
    formatValue,
    tooltipValueKey,
    formatTime,
    formatDay,
    ariaLabel,
  } = props;
  const { t } = useTranslation();
  const gradientId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const span = spanEndMs - spanStartMs;
  const x = (ms: number) => PAD.left + ((ms - spanStartMs) / span) * plotW;
  const y = (value: number) =>
    PAD.top + plotH - (Math.min(Math.max(value, 0), yMax) / yMax) * plotH;

  const nowInSpan = nowMs >= spanStartMs && nowMs <= spanEndMs;
  const recordedVisible = useMemo(
    () => clipSeries(recorded, spanStartMs, Math.min(nowMs, spanEndMs)),
    [recorded, spanStartMs, spanEndMs, nowMs]
  );
  const projectedVisible = useMemo(
    () => clipSeries(projected, Math.max(nowMs, spanStartMs), spanEndMs),
    [projected, spanStartMs, spanEndMs, nowMs]
  );

  const linePath = (points: readonly ChartPoint[]) =>
    points
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(point.value).toFixed(1)}`
      )
      .join('');
  const areaPath = (points: readonly ChartPoint[]) => {
    if (points.length < 2) return '';
    const base = y(0).toFixed(1);
    return `${linePath(points)}L${x(points[points.length - 1].t).toFixed(1)},${base}L${x(points[0].t).toFixed(1)},${base}Z`;
  };

  // Local midnights inside the span; DST-safe because it steps calendar days.
  const days = useMemo(() => {
    const out: number[] = [];
    const cursor = new Date(spanStartMs);
    cursor.setHours(0, 0, 0, 0);
    while (cursor.getTime() < spanEndMs) {
      out.push(cursor.getTime());
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }, [spanStartMs, spanEndMs]);

  const jumpLabels = useMemo(() => {
    const visible = (jumps: ChartJump[], series: readonly ChartPoint[], from: number, to: number) =>
      jumps
        .filter((jump) => jump.t >= from && jump.t <= to)
        .map((jump) => ({ ...jump, value: seriesValueAt(series, jump.t) ?? 0 }));
    const all = [
      ...visible(recordedJumps, recordedVisible, spanStartMs, Math.min(nowMs, spanEndMs)),
      ...visible(projectedJumps, projectedVisible, Math.max(nowMs, spanStartMs), spanEndMs),
    ].sort((a, b) => a.t - b.t);
    const kept: typeof all = [];
    let lastX = -Infinity;
    all.forEach((jump) => {
      const px = PAD.left + ((jump.t - spanStartMs) / span) * plotW;
      if (px - lastX < LABEL_MIN_GAP_PX) return;
      kept.push(jump);
      lastX = px;
    });
    return kept;
  }, [
    recordedJumps,
    projectedJumps,
    recordedVisible,
    projectedVisible,
    spanStartMs,
    spanEndMs,
    nowMs,
    span,
    plotW,
  ]);

  const emptyVisible = emptyAtMs !== null && emptyAtMs >= spanStartMs && emptyAtMs <= spanEndMs;

  const hover = useMemo(() => {
    if (hoverMs === null) return null;
    const isProjected = hoverMs > nowMs;
    const value = seriesValueAt(isProjected ? projectedVisible : recordedVisible, hoverMs);
    if (value === null) return null;
    return { t: hoverMs, value, isProjected };
  }, [hoverMs, nowMs, projectedVisible, recordedVisible]);

  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    setHoverMs(spanStartMs + Math.min(1, Math.max(0, fraction)) * span);
  };

  const gridValues = [0, yMax / 2, yMax];
  const tooltipLeft = hover ? Math.min(Math.max(x(hover.t), PAD.left + 90), width - 120) : 0;

  return (
    <div ref={wrapRef} className={styles.chartWrap} style={{ ['--pool-color' as string]: color }}>
      <svg
        className={styles.chartSvg}
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={ariaLabel}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.32} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>

        {days.map((day) => (
          <g key={day}>
            {day > spanStartMs && (
              <line
                className={styles.gridLine}
                x1={x(day)}
                x2={x(day)}
                y1={PAD.top}
                y2={PAD.top + plotH}
              />
            )}
            <text
              className={styles.axisText}
              x={x(day + 12 * 3_600_000)}
              y={HEIGHT - 8}
              textAnchor="middle"
            >
              {formatDay(day)}
            </text>
          </g>
        ))}

        {gridValues.map((value) => (
          <g key={value}>
            <line
              className={styles.gridLine}
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={y(value)}
              y2={y(value)}
            />
            <text className={styles.axisText} x={PAD.left - 8} y={y(value) + 4} textAnchor="end">
              {formatValue(value)}
            </text>
          </g>
        ))}

        {recordedVisible.length > 1 && (
          <path d={areaPath(recordedVisible)} fill={`url(#${gradientId})`} />
        )}
        {projectedVisible.length > 1 && (
          <path d={areaPath(projectedVisible)} fill={`url(#${gradientId})`} opacity={0.45} />
        )}
        {recordedVisible.length > 1 && (
          <path className={styles.recordedLine} d={linePath(recordedVisible)} />
        )}
        {projectedVisible.length > 1 && (
          <path className={styles.projectedLine} d={linePath(projectedVisible)} />
        )}

        {nowInSpan && (
          <g>
            <line
              className={styles.nowLine}
              x1={x(nowMs)}
              x2={x(nowMs)}
              y1={PAD.top - 6}
              y2={PAD.top + plotH + 6}
            />
            <text className={styles.nowText} x={x(nowMs)} y={PAD.top - 12} textAnchor="middle">
              {t('quota_management.pool.now')}
            </text>
            {projectedVisible.length > 0 && (
              <circle
                className={styles.nowDot}
                cx={x(nowMs)}
                cy={y(projectedVisible[0].value)}
                r={4}
              />
            )}
          </g>
        )}

        {jumpLabels.map((jump) => (
          <text
            key={`${jump.t}-${jump.gain}`}
            className={styles.jumpText}
            x={x(jump.t)}
            y={Math.max(PAD.top - 2, y(jump.value) - 8)}
            textAnchor="middle"
          >
            +{formatValue(jump.gain)}
          </text>
        ))}

        {emptyVisible && (
          <g>
            <circle className={styles.emptyDot} cx={x(emptyAtMs as number)} cy={y(0)} r={6} />
            <text
              className={styles.emptyText}
              x={x(emptyAtMs as number)}
              y={y(0) - 14}
              textAnchor="middle"
            >
              {t('quota_management.pool.empty_at', { time: formatTime(emptyAtMs as number) })}
            </text>
          </g>
        )}

        {hover && (
          <g pointerEvents="none">
            <line
              className={styles.hoverLine}
              x1={x(hover.t)}
              x2={x(hover.t)}
              y1={PAD.top}
              y2={PAD.top + plotH}
            />
            <circle className={styles.hoverDot} cx={x(hover.t)} cy={y(hover.value)} r={4} />
          </g>
        )}

        <rect
          x={PAD.left}
          y={PAD.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverMs(null)}
        />
      </svg>

      {hover && (
        <div className={styles.tooltip} style={{ left: tooltipLeft }} role="status">
          {formatTime(hover.t)} ·{' '}
          {t(`quota_management.pool.${tooltipValueKey}`, { value: formatValue(hover.value) })} ·{' '}
          {hover.isProjected
            ? t('quota_management.pool.projected')
            : t('quota_management.pool.recorded')}
        </div>
      )}
    </div>
  );
}
