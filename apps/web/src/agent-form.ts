export interface AgentForm {
  name: string;
  description: string;
  instructions: string;
  workspace: string;
  template: string;
}

// Form → API body. "" means "default" for workspace/template, and the server's zod regexes reject "",
// so both are omitted when empty. Templates only apply on create; an update never re-applies one.
export function agentPayload(form: AgentForm, options: { template: boolean }) {
  const { workspace, template, ...rest } = form;
  return { ...rest, ...(workspace ? { workspace } : {}), ...(options.template && template ? { template } : {}) };
}
