import type { WorkflowNode, WorkflowRun } from "./types.ts";

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
