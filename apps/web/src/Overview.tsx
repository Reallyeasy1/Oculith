import { useState } from "react";
import type { Agent, EvalRun, RegressionCase, RunListItem } from "./types";
import { summarizeRuns } from "./runs-view-model";

interface Props {
  runs: RunListItem[];
  cases: RegressionCase[];
  evalRuns: EvalRun[];
  selectedAgent: Agent | null;
  onRunCase: (regressionCase: RegressionCase) => Promise<void>;
  onDeleteCase: (regressionCase: RegressionCase) => Promise<void>;
}

// All-runs overview across Agents (#70): the summary strip. The Runs table and trace detail stay in App below it.
export default function Overview({ runs, cases, evalRuns, selectedAgent, onRunCase, onDeleteCase }: Props) {
  const s = summarizeRuns(runs);
  const stats: [string, number][] = [["Total", s.total], ["Ok", s.ok], ["Needs attention", s.attention], ["Running", s.running]];
  const [pendingCaseId, setPendingCaseId] = useState<string | null>(null);
  const act = async (regressionCase: RegressionCase, action: "run" | "delete") => {
    setPendingCaseId(regressionCase.id);
    try {
      await (action === "run" ? onRunCase(regressionCase) : onDeleteCase(regressionCase));
    } finally {
      setPendingCaseId(null);
    }
  };
  return (
    <>
      <header className="agent-header overview" aria-labelledby="overview-heading">
        <div>
          <span className="eyebrow">GlassBox</span>
          <h1 id="overview-heading">All runs</h1>
          <dl className="summary-strip">
            {stats.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <ul className="summary-agents" aria-label="Runs per Agent">
            {s.agents.map((agent) => (
              <li key={agent.agentId}>
                <strong>{agent.name}</strong> · {agent.count} · {agent.attention} need attention
              </li>
            ))}
          </ul>
        </div>
      </header>
      <section className="runs-view regression-cases" aria-labelledby="regression-cases-heading">
        <div className="playground-topbar">
          <div>
            <span className="eyebrow">Regression</span>
            <h2 id="regression-cases-heading">Regression cases</h2>
          </div>
          <span className="trace-muted">Target: {selectedAgent?.name ?? "select an Agent"}</span>
        </div>
        <div className="runs-table-wrap">
          <table className="runs-table">
            <thead><tr><th scope="col">Name</th><th scope="col">Template</th><th scope="col">Baseline hash</th><th scope="col">Assertions</th><th scope="col">Created</th><th scope="col">Latest evaluation</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {cases.map((regressionCase) => {
                const evaluation = latestEvaluation(evalRuns, regressionCase.id);
                const completed = evaluation?.results.find((result) => result.caseId === regressionCase.id);
                const passCount = completed?.results.filter((result) => result.pass).length;
                return <tr key={regressionCase.id}>
                  <td>{regressionCase.name}</td>
                  <td><code>{regressionCase.workspaceTemplate}</code></td>
                  <td><code title={regressionCase.baselineConfigHash}>{regressionCase.baselineConfigHash.slice(0, 8)}</code></td>
                  <td>{regressionCase.assertions.length}</td>
                  <td>{new Date(regressionCase.createdAt).toLocaleString()}</td>
                  <td>{evaluation ? <span><code title={evaluation.id}>{evaluation.id.slice(0, 8)}</code> · {evaluation.status === "running" ? "running" : completed?.error ? "failed" : `${passCount ?? 0}/${completed?.results.length ?? 0} passed`}</span> : "—"}</td>
                  <td className="case-actions">
                    <button type="button" className="button button-primary" onClick={() => void act(regressionCase, "run")} disabled={!selectedAgent || pendingCaseId === regressionCase.id} title={selectedAgent ? undefined : "Select an Agent from the sidebar first."}>{pendingCaseId === regressionCase.id ? "Working…" : "Run against " + (selectedAgent?.name ?? "this Agent")}</button>
                    <button type="button" className="button button-ghost" onClick={() => void act(regressionCase, "delete")} disabled={pendingCaseId === regressionCase.id}>Delete</button>
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
          {cases.length === 0 && <p className="runs-empty">Save a successful template-backed trace to create the first regression case.</p>}
        </div>
      </section>
    </>
  );
}

function latestEvaluation(evalRuns: EvalRun[], caseId: string): EvalRun | undefined {
  return evalRuns
    .filter((evalRun) => evalRun.caseIds.includes(caseId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
