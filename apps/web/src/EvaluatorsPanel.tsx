import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";
import type { EvaluatorDefinition } from "./types";
import { emptyEvaluatorForm, evaluatorFormError, evaluatorPayload, type EvaluatorForm } from "./evaluator-form";

// #192: the evaluator catalogue with a "New evaluator" create form. Self-contained: it fetches on
// mount and after a create, so App.tsx only mounts it. Versions are immutable server-side — saving
// a changed rubric under an existing name shows up here as a new version of the same id.
export default function EvaluatorsPanel() {
  const [evaluators, setEvaluators] = useState<EvaluatorDefinition[]>([]);
  const [form, setForm] = useState<EvaluatorForm>(emptyEvaluatorForm);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [listError, setListError] = useState("");

  const refresh = () => api.listEvaluators()
    .then((data) => { setEvaluators(data.evaluators); setListError(""); })
    .catch((reason) => setListError(reason instanceof Error ? reason.message : String(reason)));
  useEffect(() => { void refresh(); }, []);

  const set = (patch: Partial<EvaluatorForm>) => setForm((current) => ({ ...current, ...patch }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = evaluatorFormError(form);
    if (invalid) { setError(invalid); return; }
    setSaving(true);
    try {
      await api.createEvaluator(evaluatorPayload(form));
      setForm(emptyEvaluatorForm);
      setOpen(false);
      setError("");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the evaluator.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="runs-view evaluators-view" aria-labelledby="evaluators-heading">
      <div className="playground-topbar">
        <div>
          <span className="eyebrow">Evaluate</span>
          <h2 id="evaluators-heading">Evaluators</h2>
        </div>
        {/* Demoted while the form is open so it never outranks the form's own "Create evaluator" submit. */}
        <button type="button" className={open ? "button" : "button button-primary"} onClick={() => { setOpen((value) => !value); setError(""); }}>
          {open ? "Close" : "New evaluator"}
        </button>
      </div>
      {open && (
        <form onSubmit={(event) => void submit(event)} className="evaluator-form">
          <label>
            Name
            <input value={form.name} onChange={(event) => set({ name: event.target.value })} maxLength={80} placeholder="e.g. Politeness Judge" />
          </label>
          <label>
            Rubric
            <textarea value={form.rubric} onChange={(event) => set({ rubric: event.target.value })} rows={4} maxLength={4000} placeholder="What should the judge score, using only cited trace evidence?" />
          </label>
          <div className="evaluator-scores">
            <label>
              Min score
              <input inputMode="numeric" value={form.minScore} onChange={(event) => set({ minScore: event.target.value })} />
            </label>
            <label>
              Max score
              <input inputMode="numeric" value={form.maxScore} onChange={(event) => set({ maxScore: event.target.value })} />
            </label>
            <label>
              Pass threshold
              <input inputMode="numeric" value={form.passThreshold} onChange={(event) => set({ passThreshold: event.target.value })} />
            </label>
          </div>
          <label className="evaluator-outcome">
            <input type="checkbox" checked={form.setsTaskOutcome} onChange={(event) => set({ setsTaskOutcome: event.target.checked })} />
            Verdicts set the Run's task outcome
          </label>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <div>
            <button type="submit" className="button button-primary" disabled={saving}>{saving ? "Saving…" : "Create evaluator"}</button>
          </div>
        </form>
      )}
      {listError && <p className="trace-export-error" role="alert">Evaluators could not be loaded: {listError}</p>}
      <div className="runs-table-wrap">
        <table className="runs-table">
          <thead>
            <tr><th scope="col">Name</th><th scope="col">Id</th><th scope="col">Version</th><th scope="col">Type</th><th scope="col">Range</th><th scope="col">Pass ≥</th><th scope="col">Rubric</th></tr>
          </thead>
          <tbody>
            {evaluators.map((item) => (
              <tr key={item.id + "@" + item.version}>
                <td>{item.name}</td>
                <td>{item.id}</td>
                <td>v{item.version}</td>
                <td>{item.type}</td>
                <td>{item.minScore}–{item.maxScore}</td>
                <td>{item.passThreshold}</td>
                <td className="trace-muted">{item.rubric.length > 120 ? item.rubric.slice(0, 120) + "…" : item.rubric}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {evaluators.length === 0 && !listError && <p className="runs-empty">No evaluators yet.</p>}
      </div>
    </section>
  );
}
