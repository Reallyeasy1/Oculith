import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import MetricsDashboard, { type ChartOverlay } from "./MetricsDashboard";
import type { ReliabilityCompareReport, ReliabilityOverviewReport, ReliabilityReport, ReliabilitySeriesPoint, RunListItem } from "./types";
import { reliabilityTiles, sparklineHeights, type ReliabilityDrill, type ReliabilityTile } from "./reliability-view-model";
import { configOptions, provenanceRunIds } from "./config-comparison-view-model";
import { bucketNoun, presetWindow, RANGE_PRESETS, type RangePreset } from "./charts-view-model";

interface Props {
  /** null while loading or when the server runs without the reliability endpoints — the panel stays hidden.
   *  #369: on the cross-agent Overview mount this is the agent-optional GET /api/reliability report. */
  report: ReliabilityReport | ReliabilityOverviewReport | null;
  /** #342: scopes the charts refetches to one Agent; absent, they hit the all-runs endpoint (#369). */
  agentId?: string;
  /** #369: feeds the per-config overlay's hash pickers (agent view only — same source as ConfigComparison). */
  runs?: RunListItem[];
  /** #173 drill-back: a tile's number opens the Runs table pre-filtered by the tile's provenance. */
  onDrill?: (drill: ReliabilityDrill) => void;
}

// #173: per-Agent reliability aggregates from GET /api/agents/:id/reliability (#172), refreshed by the
// existing dashboard poll in App (no timers here). Tiles reuse the Overview summary-strip styling; each
// tile says whether it is a telemetry or an evaluation metric so the two families stay distinct.
// #342: "Charts" toggle expands MetricsDashboard below the tile strip. #369 phase 2: range presets
// (24h/7d/30d), the all-runs Overview mount, a per-config overlay from /api/reliability/compare, and a
// chart-bucket → Runs-table drill. Every windowed fetch is cached on the report's object identity — the
// poll swaps the report prop, which invalidates the cache, so still no timers here.
export default function ReliabilityPanel({ report, agentId, runs, onDrill }: Props) {
  const [showCharts, setShowCharts] = useState(false);
  const [bucket, setBucket] = useState<"hour" | "day">("day");
  const [preset, setPreset] = useState<RangePreset>("all");
  // Cache keyed on the report object identity: `for === report` means fresh for this poll cycle.
  const [windowed, setWindowed] = useState<{ for: object; bucket: string; preset: RangePreset; series: ReliabilitySeriesPoint[] } | null>(null);
  const [windowError, setWindowError] = useState<string | null>(null);
  const [windowLoading, setWindowLoading] = useState(false);
  // #369 overlay: two configHashes compared over the same window, rendered as paired series.
  const [overlayOn, setOverlayOn] = useState(false);
  const [aHash, setAHash] = useState("");
  const [bHash, setBHash] = useState("");
  const [compared, setCompared] = useState<{ for: object; bucket: string; preset: RangePreset; a: string; b: string; report: ReliabilityCompareReport } | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  const options = useMemo(() => configOptions(runs ?? []), [runs]);
  const overlayAvailable = Boolean(agentId) && options.length >= 2;
  const overlayActive = overlayOn && overlayAvailable && Boolean(aHash) && Boolean(bHash) && aHash !== bHash;
  // Day + All + no overlay renders the series the panel already receives; anything else fetches.
  const needsWindowFetch = showCharts && !overlayActive && (bucket === "hour" || preset !== "all");

  // #342 review: drop every cached series on agent switch so the previous agent's charts never
  // flash under the new agent while its report is in flight.
  useEffect(() => {
    setWindowed(null); setWindowError(null);
    setCompared(null); setCompareError(null);
    setOverlayOn(false); setAHash(""); setBHash("");
  }, [agentId]);

  // Keep the overlay pickers valid as the observed configurations change (same defaults as ConfigComparison).
  useEffect(() => {
    if (options.length < 2) return;
    setAHash((current) => (options.some((option) => option.configHash === current) ? current : options.at(-1)!.configHash));
    setBHash((current) => (options.some((option) => option.configHash === current) ? current : options[0]!.configHash));
  }, [options]);

  useEffect(() => {
    if (!needsWindowFetch || !report) return;
    if (windowed && windowed.for === report && windowed.bucket === bucket && windowed.preset === preset) return;
    let stale = false;
    setWindowLoading(true);
    setWindowError(null);
    const opts = { bucket, ...presetWindow(preset) };
    (agentId ? api.reliability(agentId, opts) : api.reliabilityAll(opts))
      .then((result) => {
        if (stale) return;
        setWindowed({ for: report, bucket, preset, series: result.series });
      })
      .catch((error: unknown) => {
        if (!stale) setWindowError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!stale) setWindowLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [needsWindowFetch, bucket, preset, agentId, report, windowed]);

  useEffect(() => {
    if (!showCharts || !overlayActive || !report || !agentId) return;
    if (compared && compared.for === report && compared.bucket === bucket && compared.preset === preset && compared.a === aHash && compared.b === bHash) return;
    let stale = false;
    setCompareLoading(true);
    setCompareError(null);
    api
      .compareReliability(agentId, aHash, bHash, { bucket, ...presetWindow(preset) })
      .then((result) => {
        if (stale) return;
        setCompared({ for: report, bucket, preset, a: aHash, b: bHash, report: result });
      })
      .catch((error: unknown) => {
        if (!stale) setCompareError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!stale) setCompareLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [showCharts, overlayActive, bucket, preset, agentId, aHash, bHash, report, compared]);

  if (!report) return null;
  const chartsAvailable = report.runs > 0;
  const compareReport = overlayActive && compared && compared.a === aHash && compared.b === bHash && compared.bucket === bucket && compared.preset === preset ? compared.report : null;
  const overlay: ChartOverlay | null = compareReport
    ? { aLabel: aHash.slice(0, 8), bLabel: bHash.slice(0, 8), b: compareReport.b.series, deltas: compareReport.deltas }
    : null;
  const baseSeries = bucket === "day" && preset === "all"
    ? report.series
    : windowed && windowed.bucket === bucket && windowed.preset === preset ? windowed.series : null;
  // #369 point → Runs drill: an overlay drill also carries the pair's exact runIds when the API
  // inlined them (≤ the provenance cap per side); past the cap it degrades to window-only filtering,
  // which can include Runs of uncompared configurations — the table's status line claims only the window.
  const drillBucket = onDrill
    ? (window: { from: string; to: string; label: string }) => {
        const runIds = compareReport ? provenanceRunIds(compareReport.a, compareReport.b) : undefined;
        onDrill({ quick: "all", taskOutcome: "all", window, ...(runIds ? { runIds } : {}) });
      }
    : undefined;
  return (
    <section className="runs-view reliability-panel" aria-labelledby="reliability-heading">
      <div className="playground-topbar">
        <div>
          <span className="eyebrow">Oculith</span>
          <h2 id="reliability-heading">Reliability</h2>
        </div>
        <div className="reliability-topbar-actions">
          <span className="trace-muted">
            {report.runs} {report.runs === 1 ? "Run" : "Runs"} · {bucketNoun(bucket)}
          </span>
          {chartsAvailable && (
            <button
              type="button"
              className="button button-ghost"
              aria-pressed={showCharts}
              onClick={() => setShowCharts((open) => !open)}
            >
              Charts
            </button>
          )}
        </div>
      </div>
      {report.runs === 0 ? (
        <p className="runs-empty">{agentId
          ? "No Runs observed for this Agent yet, so there is nothing to aggregate. Metrics appear after its first Run."
          : "No Runs observed yet, so there is nothing to aggregate. Metrics appear after the first Run."}</p>
      ) : (
        <>
          {/* #401: the tiles always aggregate every observed Run (the parent report is never windowed).
              The chart range presets below scope the charts only, so mark the strip's scope to stop an
              all-time tile reading as a contradiction of a 24h/7d/30d chart directly beneath it. */}
          <p className="eyebrow reliability-scope" title="These tiles aggregate every observed Run. The time-range presets below scope the charts only.">All-time</p>
          <dl className="summary-strip reliability-strip">
            {reliabilityTiles(report).map((tile) => (
              <Tile key={tile.key} tile={tile} {...(onDrill ? { onDrill } : {})} />
            ))}
          </dl>
        </>
      )}
      {chartsAvailable && showCharts && (
        <div className="reliability-charts">
          <div className="reliability-chart-controls">
            <div className="runs-filters reliability-bucket-filters" role="group" aria-label="Chart time bucket">
              {(["day", "hour"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className="button button-ghost"
                  aria-pressed={bucket === option}
                  onClick={() => setBucket(option)}
                >
                  {option === "day" ? "Day" : "Hour"}
                </button>
              ))}
            </div>
            <div className="runs-filters reliability-bucket-filters" role="group" aria-label="Chart time range">
              {RANGE_PRESETS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="button button-ghost"
                  aria-pressed={preset === option}
                  onClick={() => setPreset(option)}
                >
                  {option === "all" ? "All" : option}
                </button>
              ))}
            </div>
            {overlayAvailable && (
              <div className="reliability-overlay-controls">
                <button
                  type="button"
                  className="button button-ghost"
                  aria-pressed={overlayOn}
                  onClick={() => setOverlayOn((on) => !on)}
                >
                  Compare configs
                </button>
                {overlayOn && (
                  <>
                    <label>A <select aria-label="Baseline configuration" value={aHash} onChange={(event) => setAHash(event.target.value)}>
                      {options.map((option) => <option key={option.configHash} value={option.configHash}>{option.configHash.slice(0, 8)} · {option.runs} {option.runs === 1 ? "Run" : "Runs"}</option>)}
                    </select></label>
                    <label>B <select aria-label="Candidate configuration" value={bHash} onChange={(event) => setBHash(event.target.value)}>
                      {options.map((option) => <option key={option.configHash} value={option.configHash}>{option.configHash.slice(0, 8)} · {option.runs} {option.runs === 1 ? "Run" : "Runs"}</option>)}
                    </select></label>
                    <span className="trace-muted">A solid · B dashed · Δ = B − A</span>
                  </>
                )}
              </div>
            )}
          </div>
          {overlayOn && overlayAvailable && aHash === bHash && <p className="config-comparison-note" role="status">Choose two different configurations.</p>}
          {(windowLoading || compareLoading) && !baseSeries && !overlay && <p className="trace-muted">Loading buckets…</p>}
          {windowError && <div className="error-banner" role="alert">{windowError}</div>}
          {compareError && <div className="error-banner" role="alert">{compareError}</div>}
          {overlay && compareReport ? (
            <MetricsDashboard series={compareReport.a.series} bucket={bucket} overlay={overlay} {...(drillBucket ? { onDrillBucket: drillBucket } : {})} />
          ) : !overlayActive && baseSeries ? (
            <MetricsDashboard series={baseSeries} bucket={bucket} {...(drillBucket ? { onDrillBucket: drillBucket } : {})} />
          ) : null}
        </div>
      )}
    </section>
  );
}

function Tile({ tile, onDrill }: { tile: ReliabilityTile; onDrill?: (drill: ReliabilityDrill) => void }) {
  const heights = sparklineHeights(tile.series, tile.sparklineMax);
  const drill = tile.drill;
  // #371: the sub-line clamps to one row in CSS; the full text survives in its own title.
  const detailText = [tile.detail, tile.kind].filter(Boolean).join(" · ");
  return (
    <div title={tile.kind === "evaluation" ? "Evaluation metric: computed from stored evaluator verdicts." : "Telemetry metric: computed from observed Run summaries."}>
      <dt>{tile.label}</dt>
      <dd>
        {drill && onDrill ? (
          <button
            type="button"
            className="reliability-drill"
            aria-label={"Show Runs: " + tile.label}
            title="Open the Runs table pre-filtered to this metric's Runs"
            onClick={() => onDrill(drill)}
          >
            {tile.value}
          </button>
        ) : tile.value}
      </dd>
      <span className="reliability-detail" title={detailText}>{detailText}</span>
      {heights.length > 1 && (
        <span className="sparkline" aria-hidden="true">
          {heights.map((height, index) => (
            <span
              key={index}
              className={"sparkline-bar" + (height === null ? " empty" : "")}
              style={height === null ? undefined : { height: Math.max(8, height) + "%" }}
            />
          ))}
        </span>
      )}
    </div>
  );
}
