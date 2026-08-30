import type { ReliabilitySeriesPoint } from "./types";

// Pure chart math for MetricsDashboard (#342). Server buckets are SPARSE UTC ISO keys
// (metrics.ts bucketStart: "2026-08-29T00:00:00.000Z" / "2026-08-29T14:00:00.000Z");
// `null` means nothing observed — the line breaks, it never draws 0.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Gap-fill cap; beyond it a corrupt/huge window falls back to observed points only. */
const MAX_SYNTH_BUCKETS = 2000;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Compact axis label. UTC on purpose: buckets are UTC days/hours, and a UTC day has no single local date. */
export function bucketLabel(bucketKey: string, bucket: "hour" | "day"): string {
  const date = new Date(bucketKey);
  if (bucket === "day") return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return `${date.getUTCDate()} · ${String(date.getUTCHours()).padStart(2, "0")}:00`;
}

export interface AxisBucket {
  bucket: string;
  label: string;
  /** null = synthesized gap bucket: no Runs observed there. */
  point: ReliabilitySeriesPoint | null;
}

/** Dense time axis from the sparse series: every hour/day between first and last bucket, gaps as null points. */
export function synthesizeAxis(series: readonly ReliabilitySeriesPoint[], bucket: "hour" | "day"): AxisBucket[] {
  if (series.length === 0) return [];
  const sorted = [...series].sort((a, b) => a.bucket.localeCompare(b.bucket));
  const byKey = new Map(sorted.map((point) => [point.bucket, point]));
  const step = bucket === "hour" ? HOUR_MS : DAY_MS;
  const start = Date.parse(sorted[0].bucket);
  const end = Date.parse(sorted[sorted.length - 1].bucket);
  if (!Number.isFinite(start) || !Number.isFinite(end) || (end - start) / step > MAX_SYNTH_BUCKETS) {
    // ponytail: unparseable keys or an absurd window — skip gap fill rather than loop forever.
    return sorted.map((point) => ({ bucket: point.bucket, label: bucketLabel(point.bucket, bucket), point }));
  }
  const axis: AxisBucket[] = [];
  for (let t = start; t <= end; t += step) {
    const key = new Date(t).toISOString();
    axis.push({ bucket: key, label: bucketLabel(key, bucket), point: byKey.get(key) ?? null });
  }
  return axis;
}

/**
 * SVG path in a 0–100 viewBox (preserveAspectRatio="none"; strokes use non-scaling-stroke).
 * Breaks at null values — separate `M` segments, no interpolation across gaps. An isolated point
 * becomes a zero-length `M x y L x y` segment so stroke-linecap:round renders it as a dot.
 */
export function linePath(values: readonly (number | null)[], max: number): string {
  const n = values.length;
  const x = (index: number): number => round2(n === 1 ? 50 : (index / (n - 1)) * 100);
  const y = (value: number): number => round2(max <= 0 ? 100 : 100 - (value / max) * 100);
  const segments: string[][] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) { segments.push(current); current = []; }
      return;
    }
    current.push(`${x(index)} ${y(value)}`);
  });
  if (current.length > 0) segments.push(current);
  return segments
    .map((segment) => {
      const points = segment.length === 1 ? [segment[0], segment[0]] : segment;
      return "M" + points[0] + points.slice(1).map((point) => " L" + point).join("");
    })
    .join(" ");
}

const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/**
 * y-domain max for unbounded metrics (latency/volume): observed max padded ~5% then rounded up to a
 * nice number. Rates never use this — their domain is fixed 0–1 so a flat 50% never looks like 100%.
 */
export function niceMax(values: readonly (number | null)[]): number {
  const observed = Math.max(0, ...values.filter((value): value is number => value !== null));
  if (observed <= 0) return 1;
  const target = observed * 1.05;
  const exponent = Math.pow(10, Math.floor(Math.log10(target)));
  for (const step of NICE_STEPS) if (step * exponent >= target) return step * exponent;
  return 10 * exponent;
}

export interface Tick { y: number; label: string }

/** Three horizontal ticks (max, mid, 0), y in viewBox space top-down; caller supplies the label formatter. */
export function yTicks(max: number, format: (value: number) => string): Tick[] {
  return [1, 0.5, 0].map((fraction) => ({ y: round2(100 - fraction * 100), label: format(fraction * max) }));
}

/** Pointer fraction-of-width → nearest bucket index, clamped into [0, count). */
export function nearestBucketIndex(fraction: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * (count - 1));
}

/** The single-bucket empty-state ladder (#342): <2 buckets renders text instead of charts. */
export function emptyStateMessage(series: readonly ReliabilitySeriesPoint[], bucket: "hour" | "day"): string | null {
  if (series.length >= 2) return null;
  if (bucket === "hour") return "Charts appear once Runs span two time buckets.";
  const runs = series.reduce((sum, point) => sum + point.runs, 0);
  return `All ${runs} Runs fall in a single daily bucket — hourly buckets show the shape of one day`;
}

export interface ReadoutLine {
  value: (point: ReliabilitySeriesPoint) => number | null;
  format: (value: number) => string;
}

/** Hover readout: "Aug 29 · 62% · 13 Runs"; a synthesized gap bucket reads "no Runs observed". */
export function hoverReadout(axisBucket: AxisBucket, lines: readonly ReadoutLine[]): string {
  const point = axisBucket.point;
  if (point === null) return `${axisBucket.label} · no Runs observed`;
  const values = lines.map((line) => {
    const value = line.value(point);
    return value === null ? "—" : line.format(value);
  });
  const runs = `${point.runs} ${point.runs === 1 ? "Run" : "Runs"}`;
  return [axisBucket.label, ...values, runs].join(" · ");
}
