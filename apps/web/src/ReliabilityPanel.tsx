import type { ReliabilityReport } from "./types";
import { reliabilityTiles, sparklineHeights, type ReliabilityTile } from "./reliability-view-model";

interface Props {
  /** null while loading or when the server runs without the reliability endpoints — the panel stays hidden. */
  report: ReliabilityReport | null;
}

// #173: per-Agent reliability aggregates from GET /api/agents/:id/reliability (#172), refreshed by the
// existing dashboard poll in App (no timers here). Tiles reuse the Overview summary-strip styling; each
// tile says whether it is a telemetry or an evaluation metric so the two families stay distinct.
// ponytail: no time-range/configHash filter UI yet — the API takes them when the panel needs controls.
export default function ReliabilityPanel({ report }: Props) {
  if (!report) return null;
  return (
    <section className="runs-view reliability-panel" aria-labelledby="reliability-heading">
      <div className="playground-topbar">
        <div>
          <span className="eyebrow">GlassBox</span>
          <h2 id="reliability-heading">Reliability</h2>
        </div>
        <span className="trace-muted">
          {report.runs} {report.runs === 1 ? "Run" : "Runs"} · daily buckets
        </span>
      </div>
      {report.runs === 0 ? (
        <p className="runs-empty">No Runs observed for this Agent yet, so there is nothing to aggregate. Metrics appear after its first Run.</p>
      ) : (
        <dl className="summary-strip reliability-strip">
          {reliabilityTiles(report).map((tile) => (
            <Tile key={tile.key} tile={tile} />
          ))}
        </dl>
      )}
    </section>
  );
}

function Tile({ tile }: { tile: ReliabilityTile }) {
  const heights = sparklineHeights(tile.series);
  return (
    <div title={tile.kind === "evaluation" ? "Evaluation metric: computed from stored evaluator verdicts." : "Telemetry metric: computed from observed Run summaries."}>
      <dt>{tile.label}</dt>
      <dd>{tile.value}</dd>
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
