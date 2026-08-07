import { Type } from "typebox";

import type { WorkflowActionParams } from "./controller.ts";

export const WorkflowRunReadyConcurrencyParams = Type.Optional(Type.Integer({
	minimum: 1,
	maximum: 32,
	description: "Maximum concurrent ready nodes for action=run_ready.",
}));

export const WorkflowRunReadyNodeIdParams = Type.Optional(Type.String({
	minLength: 1,
	description: "Target node for accept/reject/supersede/get_result/cancel_node, or the one failed/cancelled node to retry with run_ready.",
}));

export function parseRunReadyWorkflowAction(
	value: Record<string, unknown>,
	runId?: string,
): Extract<WorkflowActionParams, { action: "run_ready" }> {
	if (value.concurrency !== undefined && (!Number.isInteger(value.concurrency) || (value.concurrency as number) < 1 || (value.concurrency as number) > 32)) {
		throw new Error("concurrency must be an integer between 1 and 32.");
	}
	if (value.nodeId !== undefined && (typeof value.nodeId !== "string" || !value.nodeId.trim())) throw new Error("nodeId must be a non-empty string.");
	const nodeId = typeof value.nodeId === "string" ? value.nodeId : undefined;
	return {
		action: "run_ready",
		...(runId ? { runId } : {}),
		...(typeof value.concurrency === "number" ? { concurrency: value.concurrency } : {}),
		...(nodeId ? { nodeId } : {}),
	};
}
