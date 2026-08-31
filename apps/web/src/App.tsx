import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, getAuthToken, setAuthToken } from "./api";
import { connectLive } from "./live";
import { agentPayload, budgetFormError } from "./agent-form";
import { preferredPreviewCommand, queuedSentNote, showLastErrorHint } from "./agent-view-model";
import { budgetBanner } from "./budget-view-model";
import type { Agent, AgentBudgetReport, AgentRun, AgentRunBaseline, EvalRun, Message, PreviewServability, RegressionCase, ReliabilityOverviewReport, ReliabilityReport, RunListItem, SystemInfo, TraceView, Workspace, WorkspacePreview, WorkspaceTemplate } from "./types";
import RunsView from "./RunsView";
import ReliabilityPanel from "./ReliabilityPanel";
import type { ReliabilityDrill } from "./reliability-view-model";
import TraceDetail from "./TraceDetail";
import Markdown from "./MarkdownView";
import Overview from "./Overview";
import CompareView from "./CompareView";
import EvaluatorsPanel from "./EvaluatorsPanel";
import ConfigComparison from "./ConfigComparison";
import WorkspacePanel from "./WorkspacePanel";
import type { EvalComparisonPair } from "./config-comparison-view-model";
import { refreshIntervalMs } from "./trace-view-model";
import { formatCount, LONG_SESSION_HINT, sessionHealth, workspaceOptionLabel } from "./runs-view-model";
import { runtimeCardModel } from "./system-view-model";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
  workspace: "",
  template: "",
  verifyCommand: "",
  maxTokensPerDay: "",
  maxEstimatedUsdPerDay: "",
};

// #341: humanize the raw Codex --sandbox token in the composer footer (raw value stays in the title).
const sandboxLabels: Record<string, string> = {
  "read-only": "sandbox: read-only",
  "workspace-write": "sandbox: workspace write",
  "danger-full-access": "sandbox: full access",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

// #325: the GlassBox mark — a wireframe (glass) box with one captured event inside it.
function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M12 3 20 7.5 12 12 4 7.5 12 3Z" />
        <path d="M4 7.5v9L12 21v-9" />
        <path d="M20 7.5v9L12 21" />
        <circle cx="12" cy="15.4" r="1.7" fill="currentColor" stroke="none" />
      </svg>
    </div>
  );
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [systemFailed, setSystemFailed] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [runBaseline, setRunBaseline] = useState<AgentRunBaseline | null>(null);
  // #369: in the overview this holds the agent-optional all-runs report instead.
  const [reliability, setReliability] = useState<ReliabilityReport | ReliabilityOverviewReport | null>(null);
  // #255: live budget status behind the banner; null when no Agent is selected or the endpoint is absent.
  const [budget, setBudget] = useState<AgentBudgetReport | null>(null);
  // #173 drill-back: a fresh object per tile click so RunsView re-applies the filters on repeat clicks.
  const [runsDrill, setRunsDrill] = useState<ReliabilityDrill | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // #96: the selected Agent's workspace preview; container runtime only, in-process server state.
  const [preview, setPreview] = useState<WorkspacePreview | null>(null);
  // #335: what the selected workspace can serve (local vite / built dist); null while unknown.
  const [previewServable, setPreviewServable] = useState<PreviewServability | null>(null);
  /** The agent whose preview state is currently loaded — gates the clear-on-switch below. */
  const previewAgentRef = useRef<string | null>(null);
  const [templates, setTemplates] = useState<WorkspaceTemplate[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceView | null>(null);
  const [focusEventId, setFocusEventId] = useState<string | null>(null);
  const [regressionCases, setRegressionCases] = useState<RegressionCase[]>([]);
  const [evalRuns, setEvalRuns] = useState<EvalRun[]>([]);
  const [evalComparisonSelection, setEvalComparisonSelection] = useState<EvalComparisonPair | null>(null);
  // "agent" = the selected Agent's Runs under its Playground; "overview" = All runs across Agents (#70).
  const [view, setView] = useState<"overview" | "agent">("agent");
  // Opening a trace collapses the Playground to a bar so the trace header sits in the first viewport;
  // "Expand" re-opens it for this trace, "Close trace" restores it.
  const [playgroundExpanded, setPlaygroundExpanded] = useState(false);
  const playgroundCollapsed = selectedRunId !== null && !playgroundExpanded;
  // #368: the ?run= deep link once bootstrap has validated it against the server. State, not a
  // ref, so arming it re-runs the close-on-switch effect below even when bootstrap's
  // setSelectedId/setView change nothing (the linked run may belong to the default Agent).
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const deepLinkConsumedRef = useRef(false);
  // Switching Agents or views closes the open trace: the bar must never show one Agent above
  // another's trace. Exception (#368): the run of this effect after bootstrap arms a validated
  // deep link APPLIES it instead of closing — the old requestAnimationFrame application raced
  // this very effect and lost the run when the rAF landed first. Consumed exactly once, so a
  // later Agent or view switch closes the trace like any other and never resurrects the link.
  useEffect(() => {
    if (deepLink && !deepLinkConsumedRef.current) {
      deepLinkConsumedRef.current = true;
      setSelectedRunId(deepLink);
      setPlaygroundExpanded(false);
      return;
    }
    setSelectedRunId(null);
  }, [selectedId, view, deepLink]);
  // A drill belongs to the Agent whose panel was clicked; drop it when the scope changes so a remounted
  // RunsView opens on its default filter, not a stale drill.
  useEffect(() => { setRunsDrill(null); }, [selectedId, view]);
  useEffect(() => {
    if (view !== "overview" || !evalComparisonSelection) return;
    requestAnimationFrame(() => document.getElementById("eval-comparison")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [view, evalComparisonSelection]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  // undefined means this Agent's history has not loaded yet; null is a loaded, empty history.
  const lastMessageIdRef = useRef<string | null | undefined>(undefined);
  const selectedIdRef = useRef<string | null>(null);
  const selectedRunIdRef = useRef<string | null>(null);
  // Preserve the requested run through the first render, when the URL-sync effect clears
  // an as-yet unopened trace. Bootstrap validates it before arming `deepLink` above.
  const pendingDeepLinkRef = useRef(new URLSearchParams(window.location.search).get("run"));
  const viewRef = useRef(view);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const pollingEvalRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;
  selectedRunIdRef.current = selectedRunId;
  viewRef.current = view;

  // The one way any chat affordance opens a trace — same path as a runs-table row click,
  // so the ?run= URL sync and collapse behaviour stay identical (#264).
  const openTrace = useCallback((runId: string) => {
    setSelectedRunId(runId);
    setPlaygroundExpanded(false);
  }, []);

  // Escape/Close hands focus back to the Run's row; if a quick filter hides that row, the Runs heading keeps the keyboard user anchored (#103).
  const closeTrace = useCallback(() => {
    const runId = selectedRunIdRef.current;
    setSelectedRunId(null);
    requestAnimationFrame(() => (document.querySelector<HTMLElement>(`[data-run-id="${runId}"]`) ?? document.getElementById("runs-heading"))?.focus());
  }, []);

  // Sidebar Runtime pane (#200): neutral placeholder until the first /api/system response.
  const runtimeCard = runtimeCardModel(system, systemFailed);

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const selectedWorkspaceName = selected?.workspaceName ?? selected?.workspacePath.split(/[\\/]/).at(-1) ?? "";
  const selectedStatus = selected?.status;
  // #254: messages waiting behind the active Run, refreshed with the agents list.
  const pendingMessages = selected?.pendingMessages ?? [];
  const selectedWorkspace = workspaces.find((workspace) => workspace.name === selectedWorkspaceName);
  const sharingAgents = selectedWorkspace?.agents
    .filter((id) => id !== selected?.id)
    .map((id) => agents.find((agent) => agent.id === id)?.name ?? id) ?? [];

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string, establishBaseline = false) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      if (establishBaseline) lastMessageIdRef.current = result.messages.at(-1)?.id ?? null;
      setMessages(result.messages);
    }
  }, []);

  // Scoped to whatever is on screen: the selected Agent's Runs, or every Agent's in the overview (#70).
  // Reads refs so the poll loop and the overview interval always fetch for the current view.
  const refreshRuns = useCallback(async () => {
    const overview = viewRef.current === "overview";
    const agentId = selectedIdRef.current;
    const scope = overview ? "overview" : agentId;
    if (!scope) { setRuns([]); setRunBaseline(null); setReliability(null); setBudget(null); return; }
    try {
      const [result, baselineResult, reliabilityResult, budgetResult] = await Promise.all([
        api.listRuns(overview ? { limit: 200 } : { agentId: agentId!, limit: 100 }),
        overview ? Promise.resolve(null) : api.runBaseline(agentId!).catch(() => null),
        // #173: same fail-soft contract as the baseline — a server without the reliability endpoints just hides
        // the panel. #369: the overview fetches the agent-optional all-runs report instead of skipping.
        overview ? api.reliabilityAll().catch(() => null) : api.reliability(agentId!).catch(() => null),
        // #255: fail-soft too — no budget endpoint, no banner.
        overview ? Promise.resolve(null) : api.agentBudget(agentId!).catch(() => null),
      ]);
      const stillCurrent = (viewRef.current === "overview" ? "overview" : selectedIdRef.current) === scope;
      if (mountedRef.current && stillCurrent) { setRuns(result.runs); setRunBaseline(baselineResult?.baseline ?? null); setReliability(reliabilityResult); setBudget(budgetResult); }
    } catch {
      // ponytail: runs table goes stale, baseline keeps working (invariant 12)
    }
  }, []);

  const refreshRegressionCases = useCallback(async () => {
    const result = await api.listRegressionCases();
    if (mountedRef.current) setRegressionCases(result.cases);
  }, []);

  const refreshEvalRuns = useCallback(async () => {
    const result = await api.listEvalRuns();
    if (mountedRef.current) setEvalRuns(result.evalRuns);
  }, []);

  useEffect(() => { setRuns([]); setReliability(null); void refreshRuns(); }, [refreshRuns, view, selectedId]); // clear the previous scope so the strip/table/reliability panel never show another scope for a round trip

  // No-op unless `runId` is the trace currently open, so the poll loop can call it on every tick
  // (poll-tick refreshes fail soft — invariant 12; only the initial open surfaces an error).
  const refreshTrace = useCallback(async (runId: string) => {
    if (selectedRunIdRef.current !== runId) return;
    const view = await api.trace(runId);
    if (mountedRef.current && selectedRunIdRef.current === runId) setTrace(view);
  }, []);

  useEffect(() => {
    setTrace(null);
    if (!selectedRunId) return;
    void refreshTrace(selectedRunId).catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [refreshTrace, selectedRunId]);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), refreshRuns(), refreshRegressionCases(), refreshEvalRuns(), api.system().then((info) => { setSystem(info); setSystemFailed(false); }, (reason) => { setSystemFailed(true); throw reason; }), api.listWorkspaces().then((result) => setWorkspaces(result.workspaces)), api.listWorkspaceTemplates().then((result) => setTemplates(result.templates))]);
    const runId = pendingDeepLinkRef.current;
    if (!runId) return;
    try {
      const { run } = await api.run(runId);
      if (!mountedRef.current) return;
      // #368: one batched update — the close-on-switch effect fires once for this commit
      // (deepLink always changes) and opens the trace itself instead of being raced.
      setSelectedId(run.agentId);
      setView("agent");
      setDeepLink(runId);
    } catch {
      // A shared or stale link should fall back to the ordinary landing state without an error banner.
    }
  }, [refreshAgents, refreshEvalRuns, refreshRegressionCases, refreshRuns]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedRunId) url.searchParams.set("run", selectedRunId);
    else url.searchParams.delete("run");
    window.history.replaceState(null, "", url);
  }, [selectedRunId]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setShowSettings(false);
    lastMessageIdRef.current = undefined;
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId, true), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  // #335: gated on the probed engine state, not the Codex provider. The server probes per
  // request, but this page fetches /api/system once at boot — an engine started after page
  // load shows up on reload.
  const previewSupported = system?.previewAvailable === true;

  useEffect(() => {
    // Clear only on an agent switch: a busy→ready refetch (below) must not blank a running
    // preview's header for the fetch round-trip.
    if (previewAgentRef.current !== selectedId) {
      previewAgentRef.current = selectedId;
      setPreview(null);
      setPreviewServable(null);
    }
    if (!selectedId || !previewSupported) return;
    void api
      .preview(selectedId)
      .then((result) => {
        if (selectedIdRef.current !== selectedId) return;
        setPreview(result.preview);
        setPreviewServable(result.servable);
      })
      .catch(() => undefined); // no banner: the header simply shows no preview
    // #335: selectedStatus is a dep so a Run finishing (busy → ready) re-checks servability —
    // the build the Run just produced is what makes Preview worth offering.
  }, [selectedId, previewSupported, selectedStatus]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
        workspace: selected.workspaceName ?? selected.workspacePath.split(/[\\/]/).at(-1) ?? "",
        template: selected.workspaceTemplate ?? "",
        verifyCommand: selected.verifyCommand ?? "",
        maxTokensPerDay: selected.budget?.maxTokensPerDay?.toString() ?? "",
        maxEstimatedUsdPerDay: selected.budget?.maxEstimatedUsdPerDay?.toString() ?? "",
      });
    }
  }, [selected]);

  useEffect(() => {
    const lastMessageId = messages.at(-1)?.id ?? null;
    const previous = lastMessageIdRef.current;
    lastMessageIdRef.current = lastMessageId;
    if (previous !== undefined && lastMessageId !== null && lastMessageId !== previous) {
      messageEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [messages]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    // #255: refuse the submit rather than let budgetPayload coerce a typo into "no limit".
    const budgetError = budgetFormError(form);
    if (budgetError) { setError(budgetError); return; }
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(agentPayload(form, { template: true }));
      await Promise.all([refreshAgents(), api.listWorkspaces().then((result) => setWorkspaces(result.workspaces))]);
      setSelectedId(agent.id);
      setView("agent");
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    // #255: a typo in a budget field must not silently clear the stored cap on save.
    const budgetError = budgetFormError(form);
    if (budgetError) { setError(budgetError); return; }
    const currentWorkspace = selected.workspaceName ?? selected.workspacePath.split(/[\\/]/).at(-1) ?? "";
    if (form.workspace !== currentWorkspace && !window.confirm("Switch workspace? This clears the Agent's existing Codex conversation thread.")) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, agentPayload(form, { template: false }));
      await Promise.all([refreshAgents(), api.listWorkspaces().then((result) => setWorkspaces(result.workspaces))]);
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const togglePreview = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (preview) {
        await api.stopPreview(selected.id);
        setPreview(null);
      } else {
        // #370/#375: static is the only command; the helper gates on a built dist/index.html.
        const agentId = selected.id;
        const command = preferredPreviewCommand(previewServable);
        if (!command) return;
        setPreview((await api.startPreview(agentId, command)).preview);
        // A container can die right after start (--rm erases it); re-check shortly so a dead
        // preview never keeps a "running" header. The server closes it honestly on observation.
        window.setTimeout(() => {
          void api
            .preview(agentId)
            .then((result) => {
              if (selectedIdRef.current !== agentId) return;
              setPreview(result.preview);
              setPreviewServable(result.servable);
              if (!result.preview) {
                setError("The preview stopped right after starting — the workspace could not serve inside the runtime container.");
              }
            })
            .catch(() => undefined);
        }, 2000);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const [result] = await Promise.all([api.run(runId), refreshRuns(), refreshTrace(runId).catch(() => undefined)]);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents(), refreshRuns(), refreshTrace(runId).catch(() => undefined)]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const pollEvalRun = async (evalRunId: string) => {
    if (pollingEvalRunIds.current.has(evalRunId)) return;
    pollingEvalRunIds.current.add(evalRunId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const { evalRun } = await api.evalRun(evalRunId);
        if (!mountedRef.current) return;
        setEvalRuns((current) => [evalRun, ...current.filter((item) => item.id !== evalRun.id)]);
        // #217: no per-tick refreshRuns — the dashboard timer (#98) already covers the Runs table
        // while an evaluation runs; only the terminal transition below refreshes it explicitly.
        if (evalRun.status !== "running") {
          await Promise.all([refreshEvalRuns(), refreshRuns()]);
          return;
        }
      }
    } finally {
      pollingEvalRunIds.current.delete(evalRunId);
    }
  };

  const startEvaluation = async (regressionCase: RegressionCase) => {
    if (!selected) return;
    setError(null);
    try {
      const request = { agentId: selected.id, caseIds: [regressionCase.id] };
      let result;
      try {
        result = await api.startEvalRun(request);
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.status !== 409 || !reason.message.includes("template changed")) throw reason;
        const force = window.confirm(
          "This workspace template changed after the regression case was recorded. Run against the current template anyway? The evaluation will be marked as a template-hash mismatch.",
        );
        if (!force) return;
        result = await api.startEvalRun({ ...request, force: true });
      }
      const { evalRun } = result;
      setEvalRuns((current) => [evalRun, ...current.filter((item) => item.id !== evalRun.id)]);
      await refreshRuns();
      void pollEvalRun(evalRun.id).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const deleteRegressionCase = async (regressionCase: RegressionCase) => {
    if (!window.confirm("Delete regression case “" + regressionCase.name + "”?")) return;
    setError(null);
    try {
      await api.deleteRegressionCase(regressionCase.id);
      await Promise.all([refreshRegressionCases(), refreshEvalRuns()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  // The one dashboard refresh routine, shared by the fallback timer (#98) and the SSE nudge (#40).
  // It covers both All runs and the selected Agent so Runs started outside this browser appear
  // without a reload. Trace and poll failures stay soft. Reads refs, so a stale closure is harmless.
  const refreshVisibleRuns = async () => {
    await refreshRuns();
    const openRunId = selectedRunIdRef.current;
    if (openRunId) await refreshTrace(openRunId).catch(() => undefined);
    // the overview's case rows show the latest evaluation; keep them live after a reload mid-evaluation
    if (viewRef.current === "overview") await refreshEvalRuns().catch(() => undefined);
    const agentId = selectedIdRef.current;
    if (viewRef.current !== "agent" || !agentId) return;
    try {
      const result = await api.runs(agentId);
      if (selectedIdRef.current !== agentId) return;
      const latest = result.runs[0] ?? null;
      setActiveRun(latest);
      if (latest && ["queued", "running"].includes(latest.status)) {
        void pollRun(latest.id, agentId).catch(() => undefined);
      }
    } catch {
      // ponytail: keep the last good Agent/run state when a refresh tick fails (invariant 12)
    }
  };

  useEffect(() => {
    if (view === "agent" && !selectedId) return;
    const intervalMs = refreshIntervalMs(trace?.summary.status);
    const id = window.setInterval(() => void refreshVisibleRuns(), intervalMs);
    return () => window.clearInterval(id);
  }, [selectedId, trace?.summary.status, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // #40: live updates — an SSE notification triggers the same refresh path the timer runs, just
  // sooner. The polling intervals above stay untouched as the safety net, so a failed or
  // unsupported stream silently degrades to pre-#40 behaviour.
  useEffect(() => {
    if (authRequired !== false) return;
    let pending: number | null = null;
    const dispose = connectLive(getAuthToken, () => {
      // coalesce a burst of observation events from one Run into a single refetch round
      if (pending !== null) return;
      pending = window.setTimeout(() => {
        pending = null;
        void refreshVisibleRuns();
      }, 250);
    });
    return () => {
      if (pending !== null) window.clearTimeout(pending);
      dispose();
    };
  }, [authRequired]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shared by the composer and Re-run (#256): POST the prompt, reflect the new Run locally, poll it.
  // #254: a busy Agent answers with a queued receipt instead of a Run — refresh so the queue rows
  // and chip render the queued state, and skip the immediate-run path entirely.
  const applyDispatch = async (result: Awaited<ReturnType<typeof api.sendMessage>>) => {
    if ("queued" in result) {
      await refreshAgents();
      return;
    }
    const agentId = result.run.agentId;
    if (selectedIdRef.current === agentId) {
      setMessages((current) => [...current, result.message]);
      setActiveRun(result.run);
    }
    setAgents((current) =>
      current.map((agent) =>
        agent.id === agentId ? { ...agent, status: "busy" } : agent,
      ),
    );
    await pollRun(result.run.id, agentId);
  };

  const dispatchPrompt = async (agentId: string, content: string) =>
    applyDispatch(await api.sendMessage(agentId, content));

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      await dispatchPrompt(selected.id, content);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  // #256/#404: re-run exactly as if retyped — server-side, because served run payloads are
  // redacted (#388) and re-sending the client copy would execute the [REDACTED:...] literal.
  // A busy Agent queues it like any composer send (#254); applyDispatch renders the queued state.
  const rerunPrompt = async (runId: string) => {
    setError(null);
    try {
      await applyDispatch(await api.rerun(runId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  // #254: remove a message still waiting in the queue; the server 404s if it already started.
  const cancelPendingMessage = async (messageId: string) => {
    if (!selected) return;
    setError(null);
    try {
      await api.cancelPendingMessage(selected.id, messageId);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshAgents().catch(() => undefined);
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <BrandMark />
          <span className="eyebrow">GlassBox · Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <BrandMark />
          <span className="eyebrow">GlassBox · Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <div>
            <strong>GlassBox</strong>
            <span>Observability for Agent Runs</span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <nav className="agent-list overview-nav" aria-label="Overview">
          <button
            className={"agent-card " + (view === "overview" ? "selected" : "")}
            aria-current={view === "overview" ? "page" : undefined}
            aria-label="All runs"
            title="All runs"
            onClick={() => setView("overview")}
          >
            <div className="agent-avatar">◎</div>
            <div className="agent-card-copy">
              <strong>All runs</strong>
              <span>GlassBox · every Agent</span>
            </div>
          </button>
        </nav>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (view === "agent" && agent.id === selectedId ? "selected" : "")}
              aria-current={view === "agent" && agent.id === selectedId ? "page" : undefined}
              aria-label={agent.name}
              title={agent.name}
              key={agent.id}
              onClick={() => { setSelectedId(agent.id); setView("agent"); }}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              {(agent.pendingMessages?.length ?? 0) > 0 && (
                <span className="queue-chip" title="Messages queued behind the active run">
                  {agent.pendingMessages!.length} queued
                </span>
              )}
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{runtimeCard.runtimeLabel}</strong>
          <span>
            {runtimeCard.modelLabel}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {system === null ? (
          <p className="runtime-connecting" role="status">Connecting to runtime…</p>
        ) : !system.modelConfigured || !system.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system.modelConfigured
                  ? "Set MODEL_PROVIDER and its credentials in .env (ARK_API_KEY + ARK_MODEL, or OPENAI_API_KEY) before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>×</button>
          </div>
        )}

        {view === "overview" ? (
          <><Overview runs={runs} cases={regressionCases} evalRuns={evalRuns} selectedAgent={selected} onRunCase={startEvaluation} onDeleteCase={deleteRegressionCase} onDrill={(drill) => setRunsDrill({ ...drill })} /><ReliabilityPanel report={reliability} onDrill={(drill) => setRunsDrill({ ...drill })} /><CompareView evalRuns={evalRuns} selection={evalComparisonSelection} onOpenEvidence={(runId, eventId) => { setFocusEventId(eventId ?? null); openTrace(runId); }} /><EvaluatorsPanel /></>
        ) : selected ? playgroundCollapsed ? (
          <div className="playground-bar">
            <div className="header-title-row">
              <h1>{selected.name}</h1>
              <StatusPill status={selected.status} />
            </div>
            <div className="header-actions">
              {selected.status === "busy" && (
                <button className="button button-ghost" onClick={toggleAgent} disabled={busy}>Stop</button>
              )}
              <button className="button button-ghost" onClick={() => setPlaygroundExpanded(true)}>
                Expand Playground
              </button>
            </div>
          </div>
        ) : (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
                {/* #341: full path + Copy live in the Files panel below — header keeps the short name only. */}
                <p title={selected.workspacePath}>
                  Workspace <strong>{selected.workspaceName ?? selected.workspacePath.split(/[\\/]/).at(-1)}</strong>
                </p>
                {previewSupported && preview && (
                  <p>
                    Preview running on{" "}
                    <a href={preview.url} target="_blank" rel="noreferrer">
                      {preview.url}
                    </a>{" "}
                    <button type="button" className="button button-ghost" onClick={togglePreview} disabled={busy}>
                      Stop preview
                    </button>
                  </p>
                )}
              </div>
              <div className="header-actions">
                {selectedRunId && playgroundExpanded && (
                  <button className="button button-ghost" onClick={() => setPlaygroundExpanded(false)}>
                    Collapse Playground
                  </button>
                )}
                {previewSupported && !preview && preferredPreviewCommand(previewServable) !== null && (
                  <button
                    className="button button-ghost"
                    onClick={togglePreview}
                    disabled={busy || selected.status === "busy"}
                  >
                    Preview
                  </button>
                )}
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger delete-agent"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" aria-label="Close settings" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  Workspace
                  <input
                    list="workspace-names-settings"
                    aria-describedby="workspace-help-settings"
                    value={form.workspace}
                    onChange={(event) => setForm({ ...form, workspace: event.target.value })}
                    pattern="[a-z0-9][a-z0-9._\-]{0,63}"
                    required
                  />
                </label>
                <datalist id="workspace-names-settings">
                  {workspaces.map((workspace) => <option key={workspace.name} value={workspace.name} label={workspaceOptionLabel(workspace)} />)}
                </datalist>
                <p className="form-help" id="workspace-help-settings">
                  {/* `managed` on the workspace goes false as soon as a second Agent attaches; the Agent's own
                      workspaceManaged is what makes this label stable (#155). */}
                  Current workspace: <strong>{selected?.workspaceManaged ?? selectedWorkspace?.managed ? "managed" : selectedWorkspaceName}</strong>
                  {(selected?.workspaceManaged ?? selectedWorkspace?.managed) && <> (<code>{selectedWorkspaceName}</code>)</>}
                  {sharingAgents.length > 0 ? ` · Shared with ${sharingAgents.join(", ")}.` : " · No other Agents share it."}
                  {" "}Switching resets this Agent&apos;s Codex conversation thread.
                </p>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <label>
                  Verify command
                  <input
                    value={form.verifyCommand}
                    onChange={(event) => setForm({ ...form, verifyCommand: event.target.value })}
                    placeholder="npm test"
                    maxLength={500}
                    aria-describedby="verify-command-help"
                  />
                </label>
                <p className="form-help" id="verify-command-help">
                  Runs in the workspace after every completed Run; its exit code becomes the Run&apos;s
                  outcome. Leave empty to keep the derived phrase heuristic.
                </p>
                <div className="form-grid">
                  <label>
                    Daily token budget
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={form.maxTokensPerDay}
                      onChange={(event) => setForm({ ...form, maxTokensPerDay: event.target.value })}
                      placeholder="no limit"
                      aria-describedby="budget-help"
                    />
                  </label>
                  <label>
                    Daily cost budget (USD)
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={form.maxEstimatedUsdPerDay}
                      onChange={(event) => setForm({ ...form, maxEstimatedUsdPerDay: event.target.value })}
                      placeholder="no limit"
                      aria-describedby="budget-help"
                    />
                  </label>
                </div>
                <p className="form-help" id="budget-help">
                  {/* #255 honesty constraint: usage is only known at turn end, so the gate is pre-run. */}
                  Refuses new runs once observed usage in the last 24 h reaches a limit. Checked before
                  each run only — a run that already started can overshoot. Leave both empty for no budget.
                </p>
                <div className="panel-footer">
                  {/* The Workspace field above already shows the workspace identity. */}
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            {/* #65: read-only browser over the same workspace the header names; counts come from the
                workspaces list this view already fetches. */}
            <WorkspacePanel
              agentId={selected.id}
              workspacePath={selected.workspacePath}
              fileCount={selectedWorkspace?.fileCount}
              lastModified={selectedWorkspace?.lastModified}
              busy={selected.status === "busy"}
              history={selected.workspaceHistory}
              onChanged={() => {
                // #66: an edit changed the Agent record (history, maybe the thread) and the counts.
                void Promise.all([refreshAgents(), api.listWorkspaces().then((result) => setWorkspaces(result.workspaces))]);
              }}
            />

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                  {selected.codexThreadId && (() => {
                    // #257: derived from the Runs list this view already polls — advisory only, no auto-reset.
                    const health = sessionHealth(runs, selected.codexThreadId);
                    return (
                      <span
                        className={"session-health" + (health.advisory ? " session-health-warn" : "")}
                        title={health.advisory ? LONG_SESSION_HINT : undefined}
                      >
                        {health.turns} {health.turns === 1 ? "turn" : "turns"} · {formatCount(health.inputTokens)} tokens in
                      </span>
                    );
                  })()}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : messages.length === 0 ? (
                  // #371: a terminal activeRun with an empty history left a 700px void here.
                  <p className="welcome runs-empty">No conversation yet — describe a task below.</p>
                ) : (
                  messages.map((message) => {
                    // #395: a dequeued message's createdAt is when its Run started, not when the user hit Enter.
                    const sentNote = queuedSentNote(message);
                    return (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                        {sentNote && <span>{sentNote}</span>}
                        {message.role === "assistant" && (
                          <button type="button" className="evidence-link message-trace" onClick={() => openTrace(message.runId)}>
                            trace
                          </button>
                        )}
                      </div>
                      <div className="message-body">
                        {message.role === "assistant" ? <Markdown source={message.content} /> : message.content}
                      </div>
                    </article>
                    );
                  })
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      {(activeRun.status === "running" && activeRun.currentActivity?.label) ||
                        "Codex is reading, editing, or running commands…"}
                    </div>
                  </article>
                )}
                {/* #254: work waiting behind the active Run, cancelable until it starts. */}
                {pendingMessages.map((pendingMessage, index) => (
                  <article className="message message-user message-queued" key={pendingMessage.id}>
                    <div className="message-meta">
                      <strong>You</strong>
                      <span>queued, {index + 1} ahead</span>
                      <button
                        type="button"
                        className="evidence-link queued-cancel"
                        onClick={() => void cancelPendingMessage(pendingMessage.id)}
                      >
                        Cancel
                      </button>
                    </div>
                    <div className="message-body">{pendingMessage.content}</div>
                  </article>
                ))}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                    <button type="button" className="evidence-link run-error-trace" onClick={() => openTrace(activeRun.id)}>
                      View trace
                    </button>
                    <button type="button" className="evidence-link run-error-rerun" onClick={() => void rerunPrompt(activeRun.id)}>
                      Re-run prompt
                    </button>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              {/* #266: a failed Run leaves the Agent ready; lastError is the persisted (redacted) evidence,
                  cleared by the server on the next completed Run. Hidden while the richer run-error card or
                  a live Run is on screen — this covers reload/agent-switch, where activeRun is unknown. */}
              {showLastErrorHint(selected.lastError, activeRun?.status ?? null) && (
                <p className="last-run-hint" role="status">
                  Last run failed: {selected.lastError} — send a new message to retry.
                </p>
              )}

              {/* #255: the pre-run gate is refusing new Runs for this Agent; sourced from the polled
                  budget endpoint so it clears by itself once older usage leaves the rolling window. */}
              {budgetBanner(budget) && (
                <p className="budget-banner" role="status">
                  {budgetBanner(budget)}
                </p>
              )}

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : selected.status === "busy" || (activeRun != null && ["queued", "running"].includes(activeRun.status))
                        ? "Agent is busy — Enter queues your message…"
                        : "Describe what you want the Agent to do…"
                  }
                  disabled={selected.status === "stopped"}
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline ·{" "}
                    <span title={system?.codexSandboxMode}>
                      {system ? sandboxLabels[system.codexSandboxMode] ?? system.codexSandboxMode : "checking sandbox"}
                    </span>
                    {pendingMessages.length > 0 && (
                      <> · queued, {pendingMessages.length} ahead</>
                    )}
                  </span>
                  <button
                    className="send-button"
                    disabled={!prompt.trim() || selected.status === "stopped"}
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            {/* #371: the one spot #325's GlassBox rebrand missed. */}
            <BrandMark />
            <span className="eyebrow">GlassBox</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}

        {view === "agent" && selected && <ReliabilityPanel report={reliability} agentId={selected.id} runs={runs} onDrill={(drill) => setRunsDrill({ ...drill })} />}
        {view === "agent" && selected && <ConfigComparison key={selected.id} agent={selected} runs={runs} evalRuns={evalRuns} onDrill={(drill) => setRunsDrill({ ...drill })} onOpenEvalComparison={(pair) => { setEvalComparisonSelection(pair); setView("overview"); }} />}
        {selectedRunId && (
          <TraceDetail
            key={selectedRunId}
            runId={selectedRunId}
            run={runs.find((run) => run.runId === selectedRunId)}
            view={trace}
            templateBacked={Boolean(agents.find((agent) => agent.id === runs.find((run) => run.runId === selectedRunId)?.agentId)?.workspaceTemplate)}
            focusEventId={focusEventId}
            onFocusHandled={() => setFocusEventId(null)}
            onCaseSaved={refreshRegressionCases}
            onRerun={(runId) => void rerunPrompt(runId)}
            onClose={closeTrace}
            workspaces={workspaces}
          />
        )}
        {/* runs are server-scoped already; the filter only keeps another Agent's rows out of the DOM across a switch */}
        <RunsView
          key={view}
          runs={view === "agent" && selectedId ? runs.filter((run) => run.agentId === selectedId) : runs}
          selectedRunId={selectedRunId}
          onOpenTrace={openTrace}
          showAgent={view === "overview"}
          title={view === "agent" && selected ? "Runs · " + selected.name : "Runs"}
          emptyText={view === "agent" && selected ? "No Runs for this Agent yet." : "No Runs observed yet."}
          baseline={view === "agent" ? runBaseline : null}
          drill={runsDrill}
          workspaces={workspaces}
        />
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New Agent</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" aria-label="Close create Agent dialog" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Workspace
              <input
                list="workspace-names-create"
                aria-describedby="workspace-help-create"
                placeholder="Leave blank for a managed workspace"
                value={form.workspace}
                onChange={(event) => setForm({ ...form, workspace: event.target.value })}
                pattern="[a-z0-9][a-z0-9._\-]{0,63}"
              />
            </label>
            <datalist id="workspace-names-create">
              {workspaces.map((workspace) => <option key={workspace.name} value={workspace.name} label={workspaceOptionLabel(workspace)} />)}
            </datalist>
            <p className="form-help" id="workspace-help-create">Choose an existing workspace to share it, enter a new name, or leave blank for a managed workspace.</p>
            <label>
              Start from
              <select value={form.template} onChange={(event) => setForm({ ...form, template: event.target.value })}>
                <option value="">Empty workspace</option>
                {templates.filter((template) => template.name !== "empty" && !("error" in template)).map((template) => <option key={template.name} value={template.name}>{template.name}</option>)}
              </select>
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
