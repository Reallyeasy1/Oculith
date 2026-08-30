import { useState } from "react";
import type { Agent, EvalRun, RegressionCase, RunListItem } from "./types";
import { templateHashDetails } from "./eval-view-model";
import { summarizeRuns } from "./runs-view-model";
import type { ReliabilityDrill } from "./reliability-view-model";

interface Props {
  runs: RunListItem[];
  cases: RegressionCase[];
  evalRuns: EvalRun[];
  selectedAgent: Agent | null;
  onRunCase: (regressionCase: RegressionCase) => Promise<void>;
  onDeleteCase: (regressionCase: RegressionCase) => Promise<void>;
  /** Optional: stat tiles with an exact Runs-table filter drill into it (same plumbing as ReliabilityPanel). */
  onDrill?: (drill: ReliabilityDrill) => void;
}

// All-runs overview across Agents (#70): the summary strip. The Runs table and trace detail stay in App below it.
export default function Overview({ runs, cases, evalRuns, selectedAgent, onRunCase, onDeleteCase, onDrill }: Props) {
  const s = summarizeRuns(runs);
  // Drills only where a Runs quick filter states the tile's provenance exactly; Ok/Recovered have none.
  const stats: { label: string; value: number; drill?: ReliabilityDrill }[] = [
    { label: "Total", value: s.total, drill: { quick: "all", taskOutcome: "all" } },
    { label: "Ok", value: s.ok },
    { label: "Needs attention", value: s.attention, drill: { quick: "attention", taskOutcome: "all" } },
    { label: "Recovered", value: s.recovered },
    { label: "Running", value: s.running, drill: { quick: "running", taskOutcome: "all" } },
  ];
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
            {stats.map(({ label, value, drill }) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {drill && onDrill ? (
                    <button
                      type="button"
                      className="reliability-drill"
                      aria-label={"Show Runs: " + label}
                      title="Open the Runs table pre-filtered to these Runs"
                      onClick={() => onDrill(drill)}
                    >
                      {value}
                    </button>
                  ) : value}
                </dd>
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
                const templateHashes = evaluation ? templateHashDetails(evaluation) : [];
                return <tr key={regressionCase.id}>
                  <td>{regressionCase.name}</td>
                  <td><code>{regressionCase.workspaceTemplate}</code></td>
                  <td><code title={regressionCase.baselineConfigHash}>{regressionCase.baselineConfigHash.slice(0, 8)}</code></td>
                  <td>{regressionCase.assertions.length}</td>
                  <td>{new Date(regressionCase.createdAt).toLocaleString()}</td>
                  <td>{evaluation ? <span>
                    <code title={evaluation.id}>{evaluation.id.slice(0, 8)}</code> · {evaluation.status === "running" ? "running" : !completed || completed.error ? "failed" : `${passCount ?? 0}/${completed.results.length} passed`}
                    {evaluation.templateHashMismatch && <> · <span className="badge badge-warn" title="The template changed after this case was recorded; this evaluation was forced against the current content.">template hash mismatch · forced</span></>}
                    {templateHashes.length > 0 && <> · <span className="trace-muted" title={templateHashes.map((item) => `${item.name}: ${item.hash}`).join("\n")}>templates: {templateHashes.map((item) => `${item.name} ${item.shortHash}`).join(", ")}</span></>}
                  </span> : <span className="dash">—</span>}</td>
                  <td className="case-actions">
                    <button type="button" className="button button-primary" onClick={() => void act(regressionCase, "run")} disabled={!selectedAgent || pendingCaseId === regressionCase.id} title={selectedAgent ? "Run against " + selectedAgent.name : "Select an Agent from the sidebar first."} aria-label={"Run against " + (selectedAgent?.name ?? "this Agent")}>{pendingCaseId === regressionCase.id ? "Working…" : "Run"}</button>
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
