import type { AgentBudget } from "./types";

export interface AgentForm {
  name: string;
  description: string;
  instructions: string;
  workspace: string;
  template: string;
  /** Always sent (even empty): "" tells the server to clear the stored command. */
  verifyCommand: string;
  /** #255: daily budget inputs as raw field text; blank means no limit. */
  maxTokensPerDay: string;
  maxEstimatedUsdPerDay: string;
}

const validTokens = (value: string) => Number.isInteger(Number(value)) && Number(value) > 0;
const validUsd = (value: string) => Number.isFinite(Number(value)) && Number(value) > 0;

/** Non-blank input that doesn't parse to a usable limit: surfaced as an error before submit, so a
 * typo can never silently clear a stored cap (budgetPayload would map it to "no limit"). */
export function budgetFormError(form: Pick<AgentForm, "maxTokensPerDay" | "maxEstimatedUsdPerDay">): string | null {
  if (form.maxTokensPerDay.trim() && !validTokens(form.maxTokensPerDay)) return "Daily token budget must be a whole number above zero";
  if (form.maxEstimatedUsdPerDay.trim() && !validUsd(form.maxEstimatedUsdPerDay)) return "Daily cost budget must be a number above zero";
  return null;
}

/** Blank inputs mean "no limit"; both blank sends null, which clears the stored budget. */
export function budgetPayload(form: Pick<AgentForm, "maxTokensPerDay" | "maxEstimatedUsdPerDay">): AgentBudget | null {
  const budget: AgentBudget = {
    ...(form.maxTokensPerDay.trim() && validTokens(form.maxTokensPerDay) ? { maxTokensPerDay: Number(form.maxTokensPerDay) } : {}),
    ...(form.maxEstimatedUsdPerDay.trim() && validUsd(form.maxEstimatedUsdPerDay) ? { maxEstimatedUsdPerDay: Number(form.maxEstimatedUsdPerDay) } : {}),
  };
  return Object.keys(budget).length > 0 ? budget : null;
}

// Form → API body. "" means "default" for workspace/template, and the server's zod regexes reject "",
// so both are omitted when empty. Templates only apply on create; an update never re-applies one.
export function agentPayload(form: AgentForm, options: { template: boolean }) {
  const { workspace, template, maxTokensPerDay, maxEstimatedUsdPerDay, ...rest } = form;
  return {
    ...rest,
    budget: budgetPayload({ maxTokensPerDay, maxEstimatedUsdPerDay }),
    ...(workspace ? { workspace } : {}),
    ...(options.template && template ? { template } : {}),
  };
}
