// #192: view-model for the "New evaluator" form. Mirrors the server's createEvaluatorBody so the
// user sees an actionable message instead of a zod 400; the server remains the authority.

export interface EvaluatorForm {
  name: string;
  rubric: string;
  minScore: string;
  maxScore: string;
  passThreshold: string;
  setsTaskOutcome: boolean;
}

export const emptyEvaluatorForm: EvaluatorForm = {
  name: "",
  rubric: "",
  minScore: "1",
  maxScore: "5",
  passThreshold: "4",
  setsTaskOutcome: false,
};

const int = (value: string): number | null => {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) ? parsed : null;
};

/** First problem with the form, or null when it can be submitted. */
export function evaluatorFormError(form: EvaluatorForm): string | null {
  if (!form.name.trim()) return "Name is required.";
  if (!/[a-z0-9]/i.test(form.name)) return "Name needs at least one letter or digit.";
  if (!form.rubric.trim()) return "Rubric is required.";
  if (form.rubric.trim().length > 4_000) return "Rubric is limited to 4000 characters.";
  const minScore = int(form.minScore);
  const maxScore = int(form.maxScore);
  const passThreshold = int(form.passThreshold);
  if (minScore === null || maxScore === null || passThreshold === null) return "Scores must be whole numbers.";
  if (minScore >= maxScore) return "Min score must be less than max score.";
  if (passThreshold < minScore || passThreshold > maxScore) return "Pass threshold must be between min and max score.";
  return null;
}

/** Form → POST /api/evaluators body. Call only after evaluatorFormError returns null. */
export function evaluatorPayload(form: EvaluatorForm) {
  return {
    name: form.name.trim(),
    rubric: form.rubric.trim(),
    minScore: Number(form.minScore.trim()),
    maxScore: Number(form.maxScore.trim()),
    passThreshold: Number(form.passThreshold.trim()),
    ...(form.setsTaskOutcome ? { setsTaskOutcome: true } : {}),
  };
}
