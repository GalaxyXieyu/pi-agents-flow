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

export function nodeTransitivelyDependsOn(run: WorkflowRun, nodeId: string, dependencyId: string, visited = new Set<string>()): boolean {
	if (nodeId === dependencyId) return true;
	if (visited.has(nodeId)) return false;
	visited.add(nodeId);
	const node = run.nodes[nodeId];
	if (!node) return false;
	return node.dependsOn.some((candidate) => nodeTransitivelyDependsOn(run, candidate, dependencyId, visited));
}

function completionOrder(node: WorkflowNode): number {
	const attempt = node.attempts.at(-1);
	return attempt?.completedAt ?? attempt?.startedAt ?? node.order;
}

export function terminalAcceptedEditors(run: WorkflowRun): WorkflowNode[] {
	const editors = effectiveAcceptedNodes(run).filter((node) => node.kind === "editor");
	return editors.filter((editor) => !editors.some((candidate) =>
		candidate.id !== editor.id && nodeTransitivelyDependsOn(run, candidate.id, editor.id),
	));
}

export function finalAcceptedEditor(run: WorkflowRun): WorkflowNode | undefined {
	return terminalAcceptedEditors(run)
		.sort((left, right) => completionOrder(left) - completionOrder(right) || left.id.localeCompare(right.id))
		.at(-1);
}

export function isAdjudicatedStatus(status: WorkflowNode["status"]): boolean {
	return status === "accepted" || status === "superseded" || status === "rejected";
}

function parseReviewerRelease(review: unknown, value: unknown): WorkflowReviewerRelease | undefined {
	if (typeof review !== "object" || review === null || Array.isArray(review) || (review as Record<string, unknown>).verdict !== "pass") return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.release !== true || typeof record.rationale !== "string" || !record.rationale.trim()) return undefined;
	for (const name of ["gapsAccepted", "conflictsAccepted", "citationShortfallAccepted", "lengthShortfallAccepted"]) {
		if (record[name] !== undefined && typeof record[name] !== "boolean") return undefined;
	}
	return {
		release: true,
		...(typeof record.gapsAccepted === "boolean" ? { gapsAccepted: record.gapsAccepted } : {}),
		...(typeof record.conflictsAccepted === "boolean" ? { conflictsAccepted: record.conflictsAccepted } : {}),
		...(typeof record.citationShortfallAccepted === "boolean" ? { citationShortfallAccepted: record.citationShortfallAccepted } : {}),
		...(typeof record.lengthShortfallAccepted === "boolean" ? { lengthShortfallAccepted: record.lengthShortfallAccepted } : {}),
		rationale: record.rationale,
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
	const finalEditor = finalAcceptedEditor(run);
	const candidates = finalEditor
		? acceptedReviewers.filter((node) => nodeTransitivelyDependsOn(run, node.id, finalEditor.id))
		: acceptedReviewers;
	const reviewer = candidates.sort((left, right) => completionOrder(left) - completionOrder(right) || left.id.localeCompare(right.id)).at(-1);
	if (!reviewer?.result?.extensions) return undefined;
	return parseReviewerRelease(reviewer.result.review, reviewer.result.extensions.release);
}
