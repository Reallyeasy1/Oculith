import type { RunListItem } from "./types";
import { summarizeRuns } from "./runs-view-model";

interface Props {
  runs: RunListItem[];
}

// All-runs overview across Agents (#70): the summary strip. The Runs table and trace detail stay in App below it.
export default function Overview({ runs }: Props) {
  const s = summarizeRuns(runs);
  const stats: [string, number][] = [["Total", s.total], ["Ok", s.ok], ["Needs attention", s.attention], ["Running", s.running]];
  return (
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
  );
}
