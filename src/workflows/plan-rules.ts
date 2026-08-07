import type { WorkflowDataContract, WorkflowNodeKind } from "./types.ts";

export const WORKFLOW_PORT_NAME_PATTERN = "^[a-z][a-z0-9._-]{0,63}$";
export const WORKFLOW_PORT_NAME = new RegExp(WORKFLOW_PORT_NAME_PATTERN);

export const DEEP_RESEARCH_BASE_AGENT_BY_KIND: Partial<Record<WorkflowNodeKind, string>> = {
	verification: "research-verifier",
	outline: "research-architect",
	"section-writer": "research-section-writer",
	writer: "research-writer",
	editor: "research-editor",
	reviewer: "research-reviewer",
};

export function workflowProfileForKind(kind: WorkflowNodeKind): WorkflowDataContract["profile"] {
	if (kind === "research" || kind === "verification") return "research";
	if (kind === "section-writer" || kind === "writer" || kind === "editor") return "writer";
	if (kind === "reviewer") return "reviewer";
	return "generic";
}
