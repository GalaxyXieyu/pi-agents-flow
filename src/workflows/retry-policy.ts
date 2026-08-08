export const DEFAULT_WORKFLOW_MAX_NODE_ATTEMPTS = 3;
export const MAX_WORKFLOW_MAX_NODE_ATTEMPTS = 20;

export const DEFAULT_WORKFLOW_MAX_NODES = 64;
export const MAX_WORKFLOW_MAX_NODES = 512;

export function resolveWorkflowMaxNodes(value: number | undefined): number {
	if (!Number.isInteger(value) || value === undefined || value < 1 || value > MAX_WORKFLOW_MAX_NODES) {
		return DEFAULT_WORKFLOW_MAX_NODES;
	}
	return value;
}

export function resolveWorkflowMaxNodeAttempts(value: number | undefined): number {
	if (!Number.isInteger(value) || value === undefined || value < 1 || value > MAX_WORKFLOW_MAX_NODE_ATTEMPTS) {
		return DEFAULT_WORKFLOW_MAX_NODE_ATTEMPTS;
	}
	return value;
}

export function workflowNodeAttemptsExhausted(
	node: { status: string; attempts: readonly unknown[]; maxAttempts?: number },
	maxNodeAttempts: number,
): boolean {
	const ceiling = node.maxAttempts ?? maxNodeAttempts;
	return (node.status === "failed" || node.status === "cancelled") && node.attempts.length >= ceiling;
}
