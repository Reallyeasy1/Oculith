import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { EvalComparison, EvalResult, EvalRun } from "./types";
import type { EvalComparisonPair } from "./config-comparison-view-model";

interface Props {
  evalRuns: EvalRun[];
  onOpenEvidence: (runId: string, eventId?: string) => void;
  selection?: EvalComparisonPair | null;
}

export default function CompareView({ evalRuns, onOpenEvidence, selection }: Props) {
  const [baselineId, setBaselineId] = useState("");
  const [candidateId, setCandidateId] = useState("");
  const [comparison, setComparison] = useState<EvalComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const compatible = useMemo(
    () => evalRuns.filter((item) => item.status !== "running").sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [evalRuns],
  );
  const load = async (baseline: string, candidate: string) => {
    if (!baseline || !candidate || baseline === candidate) return;
    setLoading(true); setError(null);
    try { setComparison(await api.compareEvalRuns(baseline, candidate)); }
    catch (reason) { setComparison(null); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };
  const compare = () => load(baselineId, candidateId);
  useEffect(() => {
    if (!selection) return;
    setBaselineId(selection.baselineId); setCandidateId(selection.candidateId);
    void load(selection.baselineId, selection.candidateId);
  // The ids are the stable selection identity; `load` intentionally has no captured component state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.baselineId, selection?.candidateId]);
  // Counted from the per-assertion rows the table renders, so the banner and the rows can never disagree.
  const rows = comparison?.cases.flatMap((item) => item.assertions.map((assertion, index) => ({ item, assertion, index }))) ?? [];
  const regressions = rows.filter(({ assertion }) => assertion.regression).length;
  // A whole-case candidate error repeats the same message in every missing cell — hoist it to one line
  // under the banner and dash the cells instead. Cells with differing messages keep their own text.
  const hoistedByCase = new Map<string, string>();
  for (const item of comparison?.cases ?? []) {
    const messages = item.assertions.filter((assertion) => !assertion.candidate && assertion.message).map((assertion) => assertion.message as string);
    if (messages.length > 1 && new Set(messages).size === 1 && messages[0]) hoistedByCase.set(item.caseId, messages[0]);
  }
  const hoistedMessages = [...new Set(hoistedByCase.values())];
  // #338: under two finished evaluations the panel explains itself (as ConfigComparison does) instead of vanishing.
  if (compatible.length < 2) {
    return <section id="eval-comparison" className="runs-view comparison-view" aria-labelledby="comparison-heading">
      <div className="playground-topbar"><div><span className="eyebrow">Regression</span><h2 id="comparison-heading">Compare evaluations</h2></div></div>
      <p className="runs-empty">Need at least two evaluation runs to compare. Run the evaluation suite again after a configuration change to unlock a baseline/candidate comparison.</p>
    </section>;
  }
  return <section id="eval-comparison" className="runs-view comparison-view" aria-labelledby="comparison-heading">
    <div className="playground-topbar"><div><span className="eyebrow">Regression</span><h2 id="comparison-heading">Compare evaluations</h2></div></div>
    <div className="comparison-controls">
      <label>Baseline <select value={baselineId} onChange={(event) => { setBaselineId(event.target.value); setComparison(null); }}><option value="">Choose evaluation</option>{compatible.map((item) => <option key={item.id} value={item.id}>{item.id.slice(0, 8)} · {item.status} · {new Date(item.createdAt).toLocaleString()}</option>)}</select></label>
      <label>Candidate <select value={candidateId} onChange={(event) => { setCandidateId(event.target.value); setComparison(null); }}><option value="">Choose evaluation</option>{compatible.map((item) => <option key={item.id} value={item.id}>{item.id.slice(0, 8)} · {item.status} · {new Date(item.createdAt).toLocaleString()}</option>)}</select></label>
      <button type="button" className="button button-primary" onClick={() => void compare()} disabled={loading || !baselineId || !candidateId || baselineId === candidateId}>{loading ? "Comparing…" : "Compare"}</button>
    </div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {comparison && <>
      <div className={"comparison-banner " + (regressions > 0 ? "has-regression" : "no-regression")} role="status"><strong>{regressions > 0 ? "REGRESSION" : "No regression"}</strong>{regressions > 0 ? " · " + regressions + " assertion" + (regressions === 1 ? "" : "s") + " regressed" : " · all compared assertions held"}</div>
      {comparison.templateMismatch && <div className="config-banner" role="status"><strong>Template changed between evaluations</strong> · the two EvalRuns hashed a workspace template differently, so assertion deltas may reflect the template edit rather than the Agent configuration.</div>}
      {hoistedMessages.map((message) => <div key={message} className="config-banner" role="status">Candidate evaluation errored: {message}</div>)}
      {rows.length === 0 ? <p className="runs-empty">No shared assertions to compare.</p> : (
        <div className="runs-table-wrap"><table className="runs-table"><thead><tr><th scope="col">Case</th><th scope="col">Assertion</th><th scope="col">Baseline</th><th scope="col">Candidate</th><th scope="col">Δ</th></tr></thead><tbody>{rows.map(({ item, assertion, index }) => <tr key={item.caseId + index} className={assertion.regression ? "comparison-regression" : undefined}><td>{item.caseId.slice(0, 8)}</td><td>{assertion.type}</td><td><ResultCell result={assertion.baseline} runId={item.traceLinks.baseline} onOpenEvidence={onOpenEvidence} /></td><td>{!assertion.candidate && assertion.message && !hoistedByCase.has(item.caseId) ? <span className="trace-muted">{assertion.message}</span> : <ResultCell result={assertion.candidate} runId={item.traceLinks.candidate} onOpenEvidence={onOpenEvidence} />}</td><td className={assertion.delta === undefined ? undefined : "delta-regressed"}>{assertion.delta === undefined ? <span className="dash">—</span> : assertion.delta > 0 ? "+" + assertion.delta : assertion.delta}</td></tr>)}</tbody></table></div>
      )}
    </>}
  </section>;
}

function ResultCell({ result, runId, onOpenEvidence }: { result?: EvalResult; runId?: string; onOpenEvidence: (runId: string, eventId?: string) => void }) {
  if (!result) return <span className="dash">—</span>;
  const eventId = result.evidenceEventIds[0];
  // #350: verdicts get the trace Evaluation panel's pass/fail palette — amber stays for warnings.
  const content = <><span className={"badge " + (result.pass ? "badge-pass" : "badge-fail")}>{result.pass ? "PASS" : "FAIL"}</span> {result.observed === null ? <span className="dash">—</span> : String(result.observed)}</>;
  return runId ? <button type="button" className="evidence-link" onClick={() => onOpenEvidence(runId, eventId)}>{content}</button> : content;
}
