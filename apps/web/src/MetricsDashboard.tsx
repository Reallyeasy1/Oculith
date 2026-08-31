import { useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { ReliabilityDeltas, ReliabilitySeriesPoint } from "./types";
import { formatCost, formatDuration } from "./runs-view-model";
import { formatPercent } from "./reliability-view-model";
import {
  bucketDrillWindow,
  chartDeltaChips,
  domainMax,
  emptyStateMessage,
  formatCount,
  formatScore,
  hoverReadout,
  linePath,
  nearestBucketIndex,
  overlayHoverReadout,
  slotIndex,
  synthesizeAxis,
  synthesizeAxisPair,
  yTicks,
  type AxisBucket,
  type ChartDomain,
  type ChartKey,
} from "./charts-view-model";

// #342 charts slice (+ #369 phase 2: cost, volume bars, per-config overlay, bucket drill): time-series
// cards over the reliability series. All chart math lives in charts-view-model.ts (the tested part);
// this file is only SVG assembly. Plain inline SVG, no deps, per .claude/rules/web.md. The Day|Hour
// toggle, range presets and every fetch live in ReliabilityPanel — this component renders what it is given.

interface ChartLine {
  label: string;
  /** CSS variable reference, applied via the `stroke` attribute and the legend chip. */
  color: string;
  value: (point: ReliabilitySeriesPoint) => number | null;
}

interface ChartSpec {
  key: ChartKey;
  title: string;
  /** "line" = fencepost points joined by paths; "bar" = one slot per bucket (#369 volume chart). */
  kind: "line" | "bar";
  /** "rate" = fixed 0–1 domain rendered as 0–100%; "score" = fixed 0–5 (judge scores); "observed" = 0..niceMax of the data. */
  domain: ChartDomain;
  format: (value: number) => string;
  /** #385: evaluation charts wear the tiles' provenance marker so they never read as telemetry. */
  provenance?: "evaluation";
  lines: ChartLine[];
}

const CHARTS: ChartSpec[] = [
  {
    key: "completion",
    title: "Completion",
    kind: "line",
    domain: "rate",
    format: formatPercent,
    lines: [
      { label: "Execution", color: "var(--purple)", value: (p) => p.executionCompletionRate },
      { label: "Task", color: "var(--green-ink)", value: (p) => p.taskCompletionRate.rate },
    ],
  },
  {
    key: "failure",
    title: "Failure",
    kind: "line",
    domain: "rate",
    format: formatPercent,
    lines: [
      { label: "Tool failure", color: "var(--red)", value: (p) => p.toolFailureRate },
      { label: "Denial", color: "var(--blue)", value: (p) => p.denialRate },
    ],
  },
  {
    key: "latency",
    title: "Latency",
    kind: "line",
    domain: "observed",
    format: (ms) => formatDuration(ms),
    lines: [
      { label: "p50", color: "var(--purple)", value: (p) => p.latency.p50 },
      { label: "p95", color: "var(--blue)", value: (p) => p.latency.p95 },
    ],
  },
  {
    key: "judge",
    title: "Judge scores",
    kind: "line",
    domain: "score",
    format: formatScore,
    provenance: "evaluation",
    lines: [
      // ponytail: `?? []` guards a pre-#384 server that doesn't send judgeScores yet — the card just stays empty.
      { label: "Task Completion", color: "var(--purple)", value: (p) => (p.judgeScores ?? []).find((s) => s.evaluatorId === "task_completion")?.meanScore ?? null },
      { label: "Recovery Quality", color: "var(--blue)", value: (p) => (p.judgeScores ?? []).find((s) => s.evaluatorId === "recovery_quality")?.meanScore ?? null },
    ],
  },
  {
    key: "cost",
    title: "Cost",
    kind: "line",
    domain: "observed",
    format: (usd) => formatCost(usd),
    lines: [{ label: "Avg / Run", color: "var(--green-ink)", value: (p) => p.cost.avg }],
  },
  {
    key: "volume",
    title: "Volume",
    kind: "bar",
    domain: "observed",
    format: formatCount,
    lines: [{ label: "Runs", color: "var(--blue)", value: (p) => p.runs }],
  },
];

/** #369: the candidate configuration's series rendered dashed over the baseline, with B − A chips. */
export interface ChartOverlay {
  aLabel: string;
  bLabel: string;
  b: ReliabilitySeriesPoint[];
  deltas: ReliabilityDeltas;
}

interface Props {
  series: ReliabilitySeriesPoint[];
  bucket: "hour" | "day";
  overlay?: ChartOverlay;
  /** #369 point → Runs drill: called with the clicked bucket's time window; absent = not clickable. */
  onDrillBucket?: (window: { from: string; to: string; label: string }) => void;
}

export default function MetricsDashboard({ series, bucket, overlay, onDrillBucket }: Props) {
  if (!overlay) {
    const empty = emptyStateMessage(series, bucket);
    if (empty) return <p className="charts-empty">{empty}</p>;
  }
  const axis = overlay ? synthesizeAxisPair(series, overlay.b, bucket) : synthesizeAxis(series, bucket);
  if (axis.length < 2) return <p className="charts-empty">Charts appear once Runs span two time buckets.</p>;
  return (
    <div className="charts-grid">
      {CHARTS.map((spec) => (
        <ChartCard key={spec.title} spec={spec} axis={axis} bucket={bucket} {...(overlay ? { overlay } : {})} {...(onDrillBucket ? { onDrillBucket } : {})} />
      ))}
    </div>
  );
}

function ChartCard({ spec, axis, bucket, overlay, onDrillBucket }: { spec: ChartSpec; axis: AxisBucket[]; bucket: "hour" | "day"; overlay?: ChartOverlay; onDrillBucket?: Props["onDrillBucket"] }) {
  // null = no pointer/keyboard cursor: the readout falls back to the latest bucket.
  const [cursor, setCursor] = useState<number | null>(null);
  const index = Math.min(cursor ?? axis.length - 1, axis.length - 1);
  const values = (line: ChartLine, side: "a" | "b"): (number | null)[] =>
    axis.map((axisBucket) => {
      const point = side === "a" ? axisBucket.point : axisBucket.bPoint ?? null;
      return point ? line.value(point) : null;
    });
  const lines = spec.lines.map((line) => ({ ...line, values: values(line, "a"), bValues: overlay ? values(line, "b") : [] }));
  const max = domainMax(spec.domain, lines.flatMap((line) => [...line.values, ...line.bValues]));
  const ticks = yTicks(max, spec.format);
  const slot = 100 / axis.length;
  const cursorX = spec.kind === "bar" ? (index + 0.5) * slot : axis.length === 1 ? 50 : (index / (axis.length - 1)) * 100;
  const label = `${spec.title} chart: ${spec.lines.map((line) => line.label).join(" and ")} across ${axis.length} ${bucket === "day" ? "daily" : "hourly"} buckets`
    + (overlay ? `, baseline ${overlay.aLabel} solid and candidate ${overlay.bLabel} dashed` : "");

  const indexAt = (fraction: number): number => (spec.kind === "bar" ? slotIndex(fraction, axis.length) : nearestBucketIndex(fraction, axis.length));
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0) setCursor(indexAt((event.clientX - rect.left) / rect.width));
  };
  const drill = (bucketIndex: number) => {
    const window = bucketDrillWindow(axis[bucketIndex].bucket, bucket);
    if (window && onDrillBucket) onDrillBucket(window);
  };
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onDrillBucket) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0) drill(indexAt((event.clientX - rect.left) / rect.width));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key === "Enter" || event.key === " ") && onDrillBucket) {
      event.preventDefault();
      drill(index);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setCursor(event.key === "ArrowLeft" ? Math.max(0, index - 1) : Math.min(axis.length - 1, index + 1));
  };

  const readoutLines = spec.lines.map((line) => ({ value: line.value, format: spec.format }));
  return (
    <section className="chart-card" aria-label={label}>
      <header className="chart-head">
        <h3 title={spec.provenance === "evaluation" ? "Evaluation metric: computed from stored evaluator verdicts." : undefined}>
          {spec.title}
          {spec.provenance === "evaluation" && <> <span className="eyebrow">evaluation</span></>}
        </h3>
        <span className="chart-legend">
          {spec.lines.map((line) => (
            <span key={line.label} className="chart-chip">
              <span className="chart-chip-swatch" style={{ background: line.color }} aria-hidden="true" />
              {line.label}
            </span>
          ))}
        </span>
      </header>
      {overlay && chartDeltaChips(spec.key, overlay.deltas).length > 0 && (
        <p className="chart-deltas" title={`Candidate ${overlay.bLabel} minus baseline ${overlay.aLabel}; "—" means one side observed nothing.`}>
          {chartDeltaChips(spec.key, overlay.deltas).map((chip) => (
            <span key={chip} className="badge">{chip}</span>
          ))}
        </p>
      )}
      <p className="chart-readout" aria-live="polite">
        {overlay ? overlayHoverReadout(axis[index], readoutLines) : hoverReadout(axis[index], readoutLines)}
      </p>
      <div className="chart-body">
        <div className="chart-yaxis" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick.y}>{tick.label}</span>
          ))}
        </div>
        <div
          className={"chart-plot" + (onDrillBucket ? " chart-plot-drillable" : "")}
          role="img"
          tabIndex={0}
          aria-label={label + ". Arrow keys step through the buckets." + (onDrillBucket ? " Enter opens the Runs table filtered to the focused bucket." : "")}
          title={onDrillBucket ? "Click a bucket to open its Runs" : undefined}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setCursor(null)}
          onClick={onClick}
          onKeyDown={onKeyDown}
        >
          <svg className="chart-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {ticks.map((tick) => (
              <line key={tick.y} className="chart-grid" x1="0" x2="100" y1={tick.y} y2={tick.y} vectorEffect="non-scaling-stroke" />
            ))}
            <line className="chart-cursor" x1={cursorX} x2={cursorX} y1="0" y2="100" vectorEffect="non-scaling-stroke" />
            {spec.kind === "bar"
              ? lines.map((line) => (
                  <g key={line.label}>
                    {bars(line.values, max, slot, overlay ? "a" : "solo").map((bar) => (
                      <rect key={"a" + bar.index} className="chart-bar" x={bar.x} y={bar.y} width={bar.width} height={bar.height} fill={line.color} />
                    ))}
                    {overlay && bars(line.bValues, max, slot, "b").map((bar) => (
                      <rect key={"b" + bar.index} className="chart-bar chart-bar-b" x={bar.x} y={bar.y} width={bar.width} height={bar.height} fill={line.color} />
                    ))}
                  </g>
                ))
              : lines.map((line) => (
                  <g key={line.label}>
                    <path
                      d={linePath(line.values, max)}
                      fill="none"
                      stroke={line.color}
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                    {overlay && (
                      <path
                        d={linePath(line.bValues, max)}
                        fill="none"
                        stroke={line.color}
                        strokeWidth={1.5}
                        strokeDasharray="5 4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                  </g>
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

interface Bar { index: number; x: number; y: number; width: number; height: number }

/** Slot geometry in the 0–100 viewBox: solo bars fill 60% of the slot; an overlay pairs A and B side by side. */
function bars(values: readonly (number | null)[], max: number, slot: number, side: "solo" | "a" | "b"): Bar[] {
  const geometry = side === "solo" ? { inset: 0.2, width: 0.6 } : side === "a" ? { inset: 0.12, width: 0.35 } : { inset: 0.53, width: 0.35 };
  const result: Bar[] = [];
  values.forEach((value, index) => {
    if (value === null) return;
    const height = max <= 0 ? 0 : (value / max) * 100;
    result.push({ index, x: (index + geometry.inset) * slot, y: 100 - height, width: slot * geometry.width, height });
  });
  return result;
}
