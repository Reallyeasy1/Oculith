import type { ReliabilityDeltas, ReliabilitySeriesPoint } from "./types";

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
  /** #369 overlay: the candidate configuration's bucket, when an overlay is rendered. */
  bPoint?: ReliabilitySeriesPoint | null;
}

/** #369 range presets. "all" keeps the unwindowed fetch; the rest bound `from`, which also keeps the
 * hourly axis at ≤ 720 buckets — the #351 review's silent gap-fill overflow cannot happen in a preset. */
export type RangePreset = "all" | "24h" | "7d" | "30d";
export const RANGE_PRESETS: RangePreset[] = ["all", "24h", "7d", "30d"];
const PRESET_MS: Record<Exclude<RangePreset, "all">, number> = { "24h": 24 * HOUR_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS };

export function presetWindow(preset: RangePreset, now = Date.now()): { from?: string } {
  if (preset === "all") return {};
  return { from: new Date(now - PRESET_MS[preset]).toISOString() };
}

/** #369 point → Runs drill: the half-open [from, to) window a chart bucket covers, as Runs-table bounds.
 * `to` is the last millisecond inside the bucket so a lexicographic `startedAt <= to` check stays exact. */
export function bucketDrillWindow(bucketKey: string, bucket: "hour" | "day"): { from: string; to: string; label: string } | null {
  const start = Date.parse(bucketKey);
  if (!Number.isFinite(start)) return null;
  const step = bucket === "hour" ? HOUR_MS : DAY_MS;
  return { from: new Date(start).toISOString(), to: new Date(start + step - 1).toISOString(), label: bucketLabel(bucketKey, bucket) };
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

/** #369 overlay: one dense axis spanning both configurations' buckets; `point` = baseline A, `bPoint` = candidate B. */
export function synthesizeAxisPair(a: readonly ReliabilitySeriesPoint[], b: readonly ReliabilitySeriesPoint[], bucket: "hour" | "day"): AxisBucket[] {
  const aByKey = new Map(a.map((point) => [point.bucket, point]));
  const bByKey = new Map(b.map((point) => [point.bucket, point]));
  const keys = [...new Set([...a, ...b].map((point) => point.bucket))].sort();
  if (keys.length === 0) return [];
  const step = bucket === "hour" ? HOUR_MS : DAY_MS;
  const start = Date.parse(keys[0]);
  const end = Date.parse(keys[keys.length - 1]);
  const at = (key: string): AxisBucket => ({ bucket: key, label: bucketLabel(key, bucket), point: aByKey.get(key) ?? null, bPoint: bByKey.get(key) ?? null });
  if (!Number.isFinite(start) || !Number.isFinite(end) || (end - start) / step > MAX_SYNTH_BUCKETS) {
    return keys.map(at); // same ponytail as synthesizeAxis: observed points only, never an endless loop
  }
  const axis: AxisBucket[] = [];
  for (let t = start; t <= end; t += step) axis.push(at(new Date(t).toISOString()));
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
  // #390 item 4: the day series carries no hourly breakdown, so we can only tell Hour view WON'T
  // help when a single Run sits in the day — one Run can't span two hourly buckets, so don't send
  // them to Hour only to hit "Charts appear once Runs span two time buckets." A ≥2-Run day might
  // spread across hours or pile into one; that's not determinable here, so the hint stays.
  if (runs < 2) return `All ${runs} ${runs === 1 ? "Run falls" : "Runs fall"} in a single daily bucket — charts appear once Runs span two time buckets.`;
  return `All ${runs} Runs fall in a single daily bucket — hourly buckets show the shape of one day`;
}

/** #369 overlay delta chips: raw B − A per chart, same signed rendering as the comparison table
 * ("+4.5 pp", "−500 ms") — a null delta renders "—" because one side observed nothing. */
export type ChartKey = "completion" | "failure" | "latency" | "cost" | "volume" | "judge";

const signedDelta = (value: number | null, render: (absolute: number) => string): string =>
  value === null ? "—" : (value > 0 ? "+" : value < 0 ? "−" : "") + render(Math.abs(value));
const deltaPp = (value: number | null): string => signedDelta(value, (absolute) => `${Math.round(absolute * 1000) / 10} pp`);
const deltaMs = (value: number | null): string => signedDelta(value, (absolute) => `${Math.round(absolute)} ms`);
const deltaUsd = (value: number | null): string => signedDelta(value, (absolute) => "$" + (absolute > 0 && absolute < 0.01 ? absolute.toFixed(4) : absolute.toFixed(2)));

export function chartDeltaChips(chartKey: ChartKey, deltas: ReliabilityDeltas): string[] {
  switch (chartKey) {
    case "completion": return [`Δ execution ${deltaPp(deltas.executionCompletionRate)}`, `Δ task ${deltaPp(deltas.taskCompletionRate)}`];
    case "failure": return [`Δ tool failure ${deltaPp(deltas.toolFailureRate)}`, `Δ denial ${deltaPp(deltas.denialRate)}`];
    case "latency": return [`Δ p50 ${deltaMs(deltas.latency.p50)}`, `Δ p95 ${deltaMs(deltas.latency.p95)}`];
    case "cost": return [`Δ avg ${deltaUsd(deltas.cost.avg)}`];
    case "volume": return [`Δ Runs ${signedDelta(deltas.runs, (absolute) => String(Math.round(absolute)))}`];
    case "judge": return []; // ReliabilityDeltas carries no judge-score deltas (#385)
  }
}

/** #385 y-domain per chart: "rate" is fixed 0–1 (so a flat 50% never reads as 100%), "score" is fixed
 * 0–5 (judge scores are 1–5 — an honest full-scale axis), "observed" pads the data via niceMax. */
export type ChartDomain = "rate" | "score" | "observed";

export function domainMax(domain: ChartDomain, values: readonly (number | null)[]): number {
  return domain === "rate" ? 1 : domain === "score" ? 5 : niceMax(values);
}

/** Judge-score labels: one decimal, "4.2". */
export const formatScore = (value: number): string => value.toFixed(1);

/** Volume axis / tick labels: whole counts stay integers, but a .5 midpoint stays honest.
 * niceMax can hand the mid tick a fractional value (max 5 → 2.5); rounding it to "3" put the
 * label off the gridline it names (#390 item 1), so show the true value with one decimal. */
export const formatCount = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));

/** Reliability header granularity noun tracking the Day|Hour toggle (#390 item 3). */
export const bucketNoun = (bucket: "hour" | "day"): string => (bucket === "day" ? "daily buckets" : "hourly buckets");

export interface ReadoutLine {
  value: (point: ReliabilitySeriesPoint) => number | null;
  format: (value: number) => string;
}

/** #369 overlay readout: both configurations at the cursor — "Aug 29 · A: 62% · 13 Runs · B: 50% · 9 Runs". */
export function overlayHoverReadout(axisBucket: AxisBucket, lines: readonly ReadoutLine[]): string {
  const side = (point: ReliabilitySeriesPoint | null): string => {
    if (point === null) return "no Runs observed";
    const values = lines.map((line) => {
      const value = line.value(point);
      return value === null ? "—" : line.format(value);
    });
    return [...values, `${point.runs} ${point.runs === 1 ? "Run" : "Runs"}`].join(" · ");
  };
  return `${axisBucket.label} · A: ${side(axisBucket.point)} · B: ${side(axisBucket.bPoint ?? null)}`;
}

/** #369 volume bars: pointer fraction → slot index (bars occupy slots, unlike line points at fenceposts). */
export function slotIndex(fraction: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor(Math.min(1, Math.max(0, fraction)) * count)));
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
