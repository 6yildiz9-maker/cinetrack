import React from 'react';

export interface ColumnChartPoint {
  label: string;
  value: number;
  hint?: string;
}

interface ColumnChartProps {
  points: ColumnChartPoint[];
  ariaLabel: string;
  tone?: 'accent' | 'gold';
  height?: number;
  formatValue?: (value: number) => string;
}

export const ColumnChart: React.FC<ColumnChartProps> = ({
  points,
  ariaLabel,
  tone = 'accent',
  height = 88,
  formatValue,
}) => {
  if (points.length === 0) return null;

  const format = formatValue || ((value: number) => String(value));
  const maxValue = Math.max(1, ...points.map((p) => p.value));
  const slot = 100 / points.length;
  const barWidth = slot * 0.6;

  return (
    <div
      className={`ct-chart ct-chart-${tone}`}
      role="img"
      aria-label={`${ariaLabel}. ${points.map((p) => `${p.label}: ${format(p.value)}`).join(', ')}`}
    >
      <svg
        className="ct-chart-svg"
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        style={{ height }}
        aria-hidden="true"
      >
        {points.map((point, index) => {
          const barHeight = point.value > 0 ? Math.max(2, (point.value / maxValue) * height) : 0;
          const centerX = index * slot + (slot - barWidth) / 2;
          const tooltip = point.hint || `${point.label}: ${format(point.value)}`;
          return (
            <g key={`${point.label}-${index}`}>
              <title>{tooltip}</title>
              <rect
                className="ct-chart-bar"
                x={centerX.toFixed(3)}
                y={(height - barHeight).toFixed(2)}
                width={barWidth.toFixed(3)}
                height={barHeight.toFixed(2)}
              />
            </g>
          );
        })}
      </svg>
      <div
        className="ct-chart-labels"
        aria-hidden="true"
        style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}
      >
        {points.map((point, index) => (
          <span key={`${point.label}-label-${index}`} title={point.hint || point.label}>
            {point.label}
          </span>
        ))}
      </div>
    </div>
  );
};
