import { useId } from 'react';

import { cn } from '../../lib/cn.ts';

export interface LinePoint {
  label: string;
  value: number;
}

/**
 * Small dependency-free SVG line/area chart (self-contained: no chart library, CSP-safe).
 * The data is also exposed as a visually hidden table for screen readers.
 */
export function LineChart({
  points,
  title,
  height = 160,
  className,
}: {
  points: LinePoint[];
  title: string;
  height?: number;
  className?: string;
}) {
  const gradient = useId();
  const width = 600;
  const pad = { top: 12, right: 8, bottom: 20, left: 32 };
  const max = Math.max(1, ...points.map((point) => point.value));
  const x = (index: number) =>
    pad.left + (index * (width - pad.left - pad.right)) / Math.max(1, points.length - 1);
  const y = (value: number) => pad.top + (1 - value / max) * (height - pad.top - pad.bottom);
  const line = points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`,
    )
    .join(' ');
  const area =
    points.length > 0
      ? `${line} L${x(points.length - 1).toFixed(1)},${String(height - pad.bottom)} L${String(pad.left)},${String(height - pad.bottom)} Z`
      : '';
  // Deduplicated: with max = 1 the middle tick rounds to 1 too (duplicate React keys).
  const ticks = [...new Set([0, Math.round(max / 2), max])];

  return (
    <figure className={cn('w-full', className)}>
      <svg
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        className="h-auto w-full text-primary"
        role="img"
        aria-label={title}
      >
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <g key={tick} className="text-muted-foreground">
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="currentColor"
              strokeOpacity="0.15"
            />
            <text
              x={pad.left - 6}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize="10"
              fill="currentColor"
            >
              {tick}
            </text>
          </g>
        ))}
        {area !== '' && <path d={area} fill={`url(#${gradient})`} />}
        {line !== '' && (
          <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        )}
        {points.length > 1 && (
          <g className="text-muted-foreground" fontSize="10" fill="currentColor">
            <text x={pad.left} y={height - 4}>
              {points[0]?.label}
            </text>
            <text x={width - pad.right} y={height - 4} textAnchor="end">
              {points.at(-1)?.label}
            </text>
          </g>
        )}
      </svg>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {points.map((point) => (
            <tr key={point.label}>
              <th scope="row">{point.label}</th>
              <td>{point.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
