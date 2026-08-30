import { useEffect, useState } from "react";
import { api } from "./api";
import MetricsDashboard from "./MetricsDashboard";
import type { ReliabilityReport, ReliabilitySeriesPoint } from "./types";
import { reliabilityTiles, sparklineHeights, type ReliabilityDrill, type ReliabilityTile } from "./reliability-view-model";

interface Props {
  /** null while loading or when the server runs without the reliability endpoints — the panel stays hidden. */
  report: ReliabilityReport | null;
  /** #342: enables the Charts drill-in (needed for the hourly refetch). Absent on the cross-agent
   *  Overview mount — that panel stays chartless until the "Later" all-runs dashboard lands. */
  agentId?: string;
  /** #173 drill-back: a tile's number opens the Runs table pre-filtered by the tile's provenance. */
  onDrill?: (drill: ReliabilityDrill) => void;
}

// #173: per-Agent reliability aggregates from GET /api/agents/:id/reliability (#172), refreshed by the
// existing dashboard poll in App (no timers here). Tiles reuse the Overview summary-strip styling; each
// tile says whether it is a telemetry or an evaluation metric so the two families stay distinct.
// #342: "Charts" toggle expands MetricsDashboard below the tile strip. Day renders the series the panel
// already receives; Hour fetches once per report identity — the poll swaps the report prop, which
// invalidates the cache, so no timers here either.
export default function ReliabilityPanel({ report, agentId, onDrill }: Props) {
  const [showCharts, setShowCharts] = useState(false);
  const [bucket, setBucket] = useState<"hour" | "day">("day");
  // Cache keyed on the report object identity: `for === report` means fresh for this poll cycle.
  const [hourly, setHourly] = useState<{ for: ReliabilityReport; series: ReliabilitySeriesPoint[] } | null>(null);
  const [hourError, setHourError] = useState<string | null>(null);
  const [hourLoading, setHourLoading] = useState(false);

  // #342 review: drop the cached hourly series on agent switch so the previous
  // agent's charts never flash under the new agent while its report is in flight.
  useEffect(() => { setHourly(null); setHourError(null); }, [agentId]);

  useEffect(() => {
    if (!showCharts || bucket !== "hour" || !agentId || !report || hourly?.for === report) return;
    let stale = false;
    setHourLoading(true);
    setHourError(null);
    api
      .reliability(agentId, { bucket: "hour" })
      .then((hour) => {
        if (stale) return;
        setHourly({ for: report, series: hour.series });
      })
      .catch((error: unknown) => {
        if (!stale) setHourError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!stale) setHourLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [showCharts, bucket, agentId, report, hourly]);

  if (!report) return null;
  const chartsAvailable = Boolean(agentId) && report.runs > 0;
  return (
    <section className="runs-view reliability-panel" aria-labelledby="reliability-heading">
      <div className="playground-topbar">
        <div>
          <span className="eyebrow">GlassBox</span>
          <h2 id="reliability-heading">Reliability</h2>
        </div>
        <div className="reliability-topbar-actions">
          <span className="trace-muted">
            {report.runs} {report.runs === 1 ? "Run" : "Runs"} · daily buckets
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
        <p className="runs-empty">No Runs observed for this Agent yet, so there is nothing to aggregate. Metrics appear after its first Run.</p>
      ) : (
        <dl className="summary-strip reliability-strip">
          {reliabilityTiles(report).map((tile) => (
            <Tile key={tile.key} tile={tile} {...(onDrill ? { onDrill } : {})} />
          ))}
        </dl>
      )}
      {chartsAvailable && showCharts && (
        <div className="reliability-charts">
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
          {bucket === "hour" && hourLoading && !hourly && <p className="trace-muted">Loading hourly buckets…</p>}
          {bucket === "hour" && hourError && <div className="error-banner" role="alert">{hourError}</div>}
          {bucket === "day" ? (
            <MetricsDashboard series={report.series} bucket="day" />
          ) : hourly ? (
            <MetricsDashboard series={hourly.series} bucket="hour" />
          ) : null}
        </div>
      )}
    </section>
  );
}

function Tile({ tile, onDrill }: { tile: ReliabilityTile; onDrill?: (drill: ReliabilityDrill) => void }) {
  const heights = sparklineHeights(tile.series, tile.sparklineMax);
  const drill = tile.drill;
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
      <span className="reliability-detail">{[tile.detail, tile.kind].filter(Boolean).join(" · ")}</span>
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
