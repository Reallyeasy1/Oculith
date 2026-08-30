import { useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ReliabilitySeriesPoint } from "./types";
import { formatDuration } from "./runs-view-model";
import { formatPercent } from "./reliability-view-model";
import {
  emptyStateMessage,
  hoverReadout,
  linePath,
  nearestBucketIndex,
  niceMax,
  synthesizeAxis,
  yTicks,
  type AxisBucket,
} from "./charts-view-model";

// #342 charts slice: three time-series cards over the reliability series. All chart math lives in
// charts-view-model.ts (the tested part); this file is only SVG assembly. Plain inline SVG, no deps,
// per .claude/rules/web.md. The Day|Hour toggle and the fetch live in ReliabilityPanel — this
// component just renders what it is given.

interface ChartLine {
  label: string;
  /** CSS variable reference, applied via the `stroke` attribute and the legend chip. */
  color: string;
  value: (point: ReliabilitySeriesPoint) => number | null;
}

interface ChartSpec {
  title: string;
  /** "rate" = fixed 0–1 domain rendered as 0–100%; "observed" = 0..niceMax of the data. */
  domain: "rate" | "observed";
  format: (value: number) => string;
  lines: ChartLine[];
}

const CHARTS: ChartSpec[] = [
  {
    title: "Completion",
    domain: "rate",
    format: formatPercent,
    lines: [
      { label: "Execution", color: "var(--purple)", value: (p) => p.executionCompletionRate },
      { label: "Task", color: "var(--green-ink)", value: (p) => p.taskCompletionRate.rate },
    ],
  },
  {
    title: "Failure",
    domain: "rate",
    format: formatPercent,
    lines: [
      { label: "Tool failure", color: "var(--red)", value: (p) => p.toolFailureRate },
      { label: "Denial", color: "var(--blue)", value: (p) => p.denialRate },
    ],
  },
  {
    title: "Latency",
    domain: "observed",
    format: (ms) => formatDuration(ms),
    lines: [
      { label: "p50", color: "var(--purple)", value: (p) => p.latency.p50 },
      { label: "p95", color: "var(--blue)", value: (p) => p.latency.p95 },
    ],
  },
];

export default function MetricsDashboard({ series, bucket }: { series: ReliabilitySeriesPoint[]; bucket: "hour" | "day" }) {
  const empty = emptyStateMessage(series, bucket);
  if (empty) return <p className="charts-empty">{empty}</p>;
  const axis = synthesizeAxis(series, bucket);
  return (
    <div className="charts-grid">
      {CHARTS.map((spec) => (
        <ChartCard key={spec.title} spec={spec} axis={axis} bucket={bucket} />
      ))}
    </div>
  );
}

function ChartCard({ spec, axis, bucket }: { spec: ChartSpec; axis: AxisBucket[]; bucket: "hour" | "day" }) {
  // null = no pointer/keyboard cursor: the readout falls back to the latest bucket.
  const [cursor, setCursor] = useState<number | null>(null);
  const index = Math.min(cursor ?? axis.length - 1, axis.length - 1);
  const lines = spec.lines.map((line) => ({
    ...line,
    values: axis.map((axisBucket) => (axisBucket.point ? line.value(axisBucket.point) : null)),
  }));
  const max = spec.domain === "rate" ? 1 : niceMax(lines.flatMap((line) => line.values));
  const ticks = yTicks(max, spec.format);
  const cursorX = axis.length === 1 ? 50 : (index / (axis.length - 1)) * 100;
  const label = `${spec.title} chart: ${spec.lines.map((line) => line.label).join(" and ")} across ${axis.length} ${bucket === "day" ? "daily" : "hourly"} buckets`;

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0) setCursor(nearestBucketIndex((event.clientX - rect.left) / rect.width, axis.length));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setCursor(event.key === "ArrowLeft" ? Math.max(0, index - 1) : Math.min(axis.length - 1, index + 1));
  };

  return (
    <section className="chart-card" aria-label={label}>
      <header className="chart-head">
        <h3>{spec.title}</h3>
        <span className="chart-legend">
          {spec.lines.map((line) => (
            <span key={line.label} className="chart-chip">
              <span className="chart-chip-swatch" style={{ background: line.color }} aria-hidden="true" />
              {line.label}
            </span>
          ))}
        </span>
      </header>
      <p className="chart-readout" aria-live="polite">{hoverReadout(axis[index], spec.lines.map((line) => ({ value: line.value, format: spec.format })))}</p>
      <div className="chart-body">
        <div className="chart-yaxis" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick.y}>{tick.label}</span>
          ))}
        </div>
        <div
          className="chart-plot"
          role="img"
          tabIndex={0}
          aria-label={label + ". Arrow keys step through the buckets."}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setCursor(null)}
          onKeyDown={onKeyDown}
        >
          <svg className="chart-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {ticks.map((tick) => (
              <line key={tick.y} className="chart-grid" x1="0" x2="100" y1={tick.y} y2={tick.y} vectorEffect="non-scaling-stroke" />
            ))}
            <line className="chart-cursor" x1={cursorX} x2={cursorX} y1="0" y2="100" vectorEffect="non-scaling-stroke" />
            {lines.map((line) => (
              <path
                key={line.label}
                d={linePath(line.values, max)}
                fill="none"
                stroke={line.color}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
        </div>
      </div>
      <div className="chart-xaxis" aria-hidden="true">
        <span>{axis[0].label}</span>
        <span>{axis[axis.length - 1].label}</span>
      </div>
    </section>
  );
}
