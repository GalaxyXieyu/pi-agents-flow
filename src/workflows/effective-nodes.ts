import type { WorkflowNode, WorkflowReviewerRelease, WorkflowRun } from "./types.ts";

export function effectiveAcceptedNodes(run: WorkflowRun): WorkflowNode[] {
	return Object.values(run.nodes).filter((node) => node.status === "accepted");
}

export function effectiveAcceptedResultNodes(run: WorkflowRun): WorkflowNode[] {
	return effectiveAcceptedNodes(run).filter((node) => node.result);
}

export function dependencyIsAccepted(nodes: Record<string, WorkflowNode>, nodeId: string): boolean {
	const visited = new Set<string>();
	let current = nodes[nodeId];
	while (current?.status === "superseded" && current.supersededBy && !visited.has(current.id)) {
		visited.add(current.id);
		current = nodes[current.supersededBy];
	}
	return current?.status === "accepted";
}

export function isAdjudicatedStatus(status: WorkflowNode["status"]): boolean {
	return status === "accepted" || status === "superseded" || status === "rejected";
}

function parseReviewerRelease(value: unknown): WorkflowReviewerRelease | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.release !== "boolean" || record.release !== true) return undefined;
	return {
		release: true,
		...(typeof record.gapsAccepted === "boolean" ? { gapsAccepted: record.gapsAccepted } : {}),
		...(typeof record.conflictsAccepted === "boolean" ? { conflictsAccepted: record.conflictsAccepted } : {}),
		...(typeof record.citationShortfallAccepted === "boolean" ? { citationShortfallAccepted: record.citationShortfallAccepted } : {}),
		...(typeof record.lengthShortfallAccepted === "boolean" ? { lengthShortfallAccepted: record.lengthShortfallAccepted } : {}),
		...(typeof record.rationale === "string" ? { rationale: record.rationale } : {}),
	};
}

/**
 * Collect the release declaration from the accepted reviewer node that reviewed
 * the final accepted editor (falls back to the last accepted reviewer).
 *
 * A reviewer may declare it accepts residual gaps/conflicts and/or citation and
 * length shortfalls. When present, the corresponding completion gates release so
 * the supervisor is not forced to manually record a decision per outstanding item.
 */
export function acceptedReviewerRelease(run: WorkflowRun): WorkflowReviewerRelease | undefined {
	const acceptedReviewers = effectiveAcceptedNodes(run).filter((node) => node.kind === "reviewer" && node.result);
	if (acceptedReviewers.length === 0) return undefined;
	const finalEditor = effectiveAcceptedNodes(run).filter((node) => node.kind === "editor").at(-1);
	const reviewer = finalEditor
		? acceptedReviewers.filter((node) => node.dependsOn.includes(finalEditor.id)).at(-1) ?? acceptedReviewers.at(-1)
		: acceptedReviewers.at(-1);
	if (!reviewer?.result?.extensions) return undefined;
	return parseReviewerRelease(reviewer.result.extensions.release);
}
