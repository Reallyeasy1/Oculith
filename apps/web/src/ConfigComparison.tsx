import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { comparisonRows, comparisonWindow, configDiffRows, configOptions, findCompatibleEvalPair, provenanceRunIds, type EvalComparisonPair } from "./config-comparison-view-model";
import type { Agent, EvalRun, ReliabilityBlock, ReliabilityCompareReport, RunListItem } from "./types";
import type { ReliabilityDrill } from "./reliability-view-model";

interface Props {
  agent: Agent;
  runs: RunListItem[];
  evalRuns: EvalRun[];
  onDrill: (drill: ReliabilityDrill) => void;
  onOpenEvalComparison: (pair: EvalComparisonPair) => void;
}

export default function ConfigComparison({ agent, runs, evalRuns, onDrill, onOpenEvalComparison }: Props) {
  const options = useMemo(() => configOptions(runs), [runs]);
  const [aHash, setAHash] = useState("");
  const [bHash, setBHash] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [report, setReport] = useState<ReliabilityCompareReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (options.length < 2) { setAHash(""); setBHash(""); setReport(null); return; }
    setAHash((current) => options.some((option) => option.configHash === current) ? current : options.at(-1)!.configHash);
    setBHash((current) => options.some((option) => option.configHash === current) ? current : options[0]!.configHash);
  }, [options]);

  const selectedA = options.find((option) => option.configHash === aHash);
  const selectedB = options.find((option) => option.configHash === bHash);
  const evalPair = findCompatibleEvalPair(evalRuns, agent.id, aHash, bHash);
  const compare = async () => {
    if (!aHash || !bHash || aHash === bHash || (from && to && from > to)) return;
    setLoading(true); setError(null);
    try { setReport(await api.compareReliability(agent.id, aHash, bHash, comparisonWindow(from, to))); }
    catch (reason) { setReport(null); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };
  const drill = (blocks: ReliabilityBlock[]) => {
    const runIds = provenanceRunIds(...blocks);
    onDrill({ quick: "all", taskOutcome: "all", ...(runIds ? { runIds } : {}) });
  };

  return (
    <section className="runs-view config-comparison" aria-labelledby="config-comparison-heading">
      <div className="playground-topbar">
        <div><span className="eyebrow">Quality drift</span><h2 id="config-comparison-heading">Compare configurations</h2></div>
        <span className="trace-muted">Raw historical deltas · no score or classification</span>
      </div>
      {options.length < 2 ? (
        <p className="runs-empty">At least two observed configurations are required. Edit this Agent’s behavior configuration and complete another Run to compare it with history.</p>
      ) : (
        <>
          <div className="comparison-controls config-comparison-controls">
            <label>Baseline configuration <select aria-label="Baseline configuration" value={aHash} onChange={(event) => { setAHash(event.target.value); setReport(null); }}>
              {options.map((option) => <option key={option.configHash} value={option.configHash}>{option.configHash.slice(0, 8)} · {option.runs} {option.runs === 1 ? "Run" : "Runs"}</option>)}
            </select></label>
            <label>Candidate configuration <select aria-label="Candidate configuration" value={bHash} onChange={(event) => { setBHash(event.target.value); setReport(null); }}>
              {options.map((option) => <option key={option.configHash} value={option.configHash}>{option.configHash.slice(0, 8)} · {option.runs} {option.runs === 1 ? "Run" : "Runs"}</option>)}
            </select></label>
            <label>From <input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setReport(null); }} /></label>
            <label>To <input type="date" value={to} min={from || undefined} onChange={(event) => { setTo(event.target.value); setReport(null); }} /></label>
            <button type="button" className="button button-primary" onClick={() => void compare()} disabled={loading || !aHash || !bHash || aHash === bHash || Boolean(from && to && from > to)}>{loading ? "Comparing…" : "Compare quality"}</button>
          </div>
          {aHash === bHash && <p className="config-comparison-note" role="status">Choose two different configurations.</p>}
          {from && to && from > to && <p className="error-banner" role="alert">The start date must not be after the end date.</p>}
          {error && <div className="error-banner" role="alert">{error}</div>}
          {report && selectedA && selectedB && (
            <>
              <div className="config-comparison-copy">
                <strong>Quality drift</strong> is the raw difference from candidate B minus baseline A. Telemetry and evaluation remain separate.
                {evalPair ? <button type="button" className="button button-ghost" onClick={() => onOpenEvalComparison(evalPair)}>Open deterministic EvalRun comparison</button> : <span className="trace-muted">No compatible deterministic EvalRun pair exists for these configurations.</span>}
              </div>
              <h3 className="config-comparison-subheading">Behavior configuration diff</h3>
              <div className="runs-table-wrap"><table className="runs-table config-diff-table"><thead><tr><th scope="col">Setting</th><th scope="col">A · {aHash.slice(0, 8)}</th><th scope="col">B · {bHash.slice(0, 8)}</th></tr></thead><tbody>
                {configDiffRows(selectedA.snapshot, selectedB.snapshot).map((row) => <tr key={row.label} className={row.changed ? "config-changed" : undefined}><th scope="row">{row.label}{row.changed && <span className="badge">changed</span>}</th><td><code>{row.a}</code></td><td><code>{row.b}</code></td></tr>)}
              </tbody></table></div>
              <h3 className="config-comparison-subheading">Historical metrics</h3>
              <div className="runs-table-wrap"><table className="runs-table config-metrics-table"><thead><tr><th scope="col">Metric</th><th scope="col">Family</th><th scope="col">A · {aHash.slice(0, 8)}</th><th scope="col">B · {bHash.slice(0, 8)}</th><th scope="col">Δ B − A</th></tr></thead><tbody>
                {comparisonRows(report).map((row) => <tr key={row.key}><th scope="row">{row.label}</th><td><span className="badge">{row.kind}</span></td><td><MetricButton label={`Show baseline Runs behind ${row.label}`} value={row.a} detail={row.aDetail} onClick={() => drill([report.a])} /></td><td><MetricButton label={`Show candidate Runs behind ${row.label}`} value={row.b} detail={row.bDetail} onClick={() => drill([report.b])} /></td><td><MetricButton label={`Show all Runs behind the ${row.label} delta`} value={row.delta} onClick={() => drill([report.a, report.b])} /></td></tr>)}
              </tbody></table></div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function MetricButton({ label, value, detail, onClick }: { label: string; value: string; detail?: string; onClick: () => void }) {
  return <button type="button" className="comparison-metric" aria-label={label} onClick={onClick}><strong>{value}</strong>{detail && <small>{detail}</small>}</button>;
}
